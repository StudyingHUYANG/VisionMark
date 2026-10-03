const fs = require('fs');
const path = require('path');
const { exec, spawn, spawnSync } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const OpenAI = require('openai');
const { buildEffectiveModelConfig } = require('./modelConfigService');
const { hasOssConfig } = require('../utils/oss');
const { killProcessTree } = require('../utils/killProcessTree');
const { toPositiveNumber } = require('../utils/numberUtils');
const EmbeddingService = require('./embeddingService');
const vectorDb = require('./vectorDb');
const BilibiliDownloader = require('./bilibiliDownloader');
const {
  ERROR_CODES,
  ERROR_REASONS,
  ERROR_STAGES,
  DownloadError,
  isDownloadError,
  isFatalDownloadError,
  classifyYtDlpFailure,
  attemptEntryFromError,
  finalizeDownloadError,
  withAttempts,
  buildUserFacingMessage,
  scrubSecrets,
  AttemptLog
} = BilibiliDownloader;
const { analyzeVisualCuts, analyzeSceneCutsWithFfmpeg } = require('./visualCutDetector');
const keywordCutService = require('./segment/keywordCuts');
const { detectAudioCuts } = require('./segment/audioCuts');
const { runSegmentPipeline } = require('./segmentPipeline');
const { removeArtifactsFor } = require('./segmentPipeline/debugArtifactWriter');
const asrService = require('./asr');

// 时间格式化辅助函数
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function clampPercent(percent) {
  const numericPercent = Number(percent);
  if (!Number.isFinite(numericPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(numericPercent)));
}

const YTDLP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * yt-dlp 停滞看门狗阈值（默认 5 分钟，可用构造参数 stallTimeoutMs 覆盖）。
 *
 * 为什么不是"总时长上限"：长视频合法下载几十分钟是正常的，硬性总超时会误杀正常任务。
 * 要防的是"完全没有输出"——网络黑洞（连接在、数据不来）时 yt-dlp 可以永远沉默地挂着。
 *
 * 为什么阈值要取到 5 分钟这么宽：`--remux-video mp4` 阶段 yt-dlp 内部调用 ffmpeg 转封装大文件，
 * 期间整条进程可能安静好几分钟（增量进度不写 stdout/stderr）。阈值必须宽于这段静默期，
 * 否则正常的大文件转封装会被当成停滞误杀。
 */
const YT_DLP_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 交给 yt-dlp 自己的 socket 读超时（秒）：每个 socket 连续 30 秒无数据即放弃该连接，
 * 并走参数里已有的 --retries / --fragment-retries 重试（可能换到备份源）。
 *
 * 看门狗只能发现"整条进程静默"，而单条死连接上 yt-dlp 仍可能在耐心等待；
 * 让 yt-dlp 自己快速失败能更早恢复。取 30 秒的理由：
 *  - 看的是静默时长而不是速率，慢速网络下"数据来得慢"仍有数据到达，不会触发；
 *  - 转封装阶段没有 socket 活动，不受此参数影响（防误杀）；
 *  - 30 秒远大于 B 站 CDN 分片正常的帧间/包间间隔，不会误伤正常下载。
 */
const YT_DLP_SOCKET_TIMEOUT_SECONDS = 30;

/** 取 yt-dlp 输出末尾若干行用于诊断，先脱敏再截断 */
function truncateTail(text, maxLength = 400) {
  const lines = scrubSecrets(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const tail = lines.slice(-4).join(' | ');
  return tail.length > maxLength ? `${tail.slice(0, maxLength)}…` : (tail || '无输出');
}

/** 判断错误是否属于 B 站风控（412） */
function isRiskControlError(error) {
  return isDownloadError(error) && error.code === ERROR_CODES.RISK_CONTROL_412;
}

function resolveFfprobePath() {
  // 注意 @ffmpeg-installer 在 Windows 下给的是 ffmpeg.exe，必须连扩展名一起替换
  const siblingFfprobePath = ffmpegPath.replace(/(ffmpeg)(\.exe)?$/i, (_match, _name, ext) => `ffprobe${ext || ''}`);
  if (siblingFfprobePath !== ffmpegPath && fs.existsSync(siblingFfprobePath)) return siblingFfprobePath;

  const repoSiblingPath = path.join(__dirname, '../../scripts/ffmpeg/ffprobe.exe');
  if (fs.existsSync(repoSiblingPath)) return repoSiblingPath;

  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (!probe.error && probe.status === 0) return 'ffprobe';

  return null;
}

function parsePtsTimes(text) {
  return [...String(text || '').matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map(match => Number(match[1]))
    .filter(time => Number.isFinite(time) && time >= 0)
    .filter((time, index, list) => index === 0 || Math.abs(time - list[index - 1]) > 0.001);
}

// 16kHz / 单声道 / s16le 的 wav 每秒 32000 字节，低于 1 秒的音频没有识别价值
const MIN_AUDIO_BYTES = 32 * 1024;
// 音频与视频时长允许的差异下限（相对差异另取 2%）
const AUDIO_DURATION_TOLERANCE_SECONDS = 2;

// cleanup 认得的直接产物后缀；下载中间产物（.mp4.part / .durl-N.mp4 / .concat.txt …）
// 走 `${bvid}.` 前缀命中，不用在这里逐个列举
const CLEANUP_FILE_EXTS = Object.freeze(['.mp4', '.mp3', '.m4a', '.wav']);

/**
 * 文件名是否属于该 bvid。
 *
 * 判据必须落在分隔符边界（`{bvid}.` / `{bvid}_`）上：老实现用 startsWith(bvid)，
 * cleanup('BV1aa') 会连带删掉另一个视频的 'BV1aab.mp4' 和 'BV1aab_frames/'，误删别人的缓存。
 */
function belongsToBvid(name, bvid, exts = CLEANUP_FILE_EXTS) {
  if (exts.some(ext => name === `${bvid}${ext}`)) return true;
  return name.startsWith(`${bvid}.`) || name.startsWith(`${bvid}_`);
}

// --- 媒体工具超时策略 --------------------------------------------------------
// ffmpeg/ffprobe 不带超时会在异常输入上永久挂起，进而拖死整个分析任务。
// perSecondMs 让超时随视频时长缩放，minMs 是短片/时长未知时的兜底下限。
const MEDIA_TIMEOUT_POLICIES = Object.freeze({
  /** 元数据探测：只读文件头，与时长无关 */
  probe: Object.freeze({ minMs: 120000, perSecondMs: 0 }),
  /** 全片解码：最坏情况要读完整个文件 */
  decode: Object.freeze({ minMs: 300000, perSecondMs: 500 }),
  /** 单帧抓取：-ss 定位后只取一帧 */
  frame: Object.freeze({ minMs: 30000, perSecondMs: 50 }),
  /** 音频提取 / 压缩副本 */
  audio: Object.freeze({ minMs: 120000, perSecondMs: 500 }),
  /** ffmpeg scene 扫描：同样要读完整片 */
  scene: Object.freeze({ minMs: 120000, perSecondMs: 500 })
});

function resolveMediaTimeoutMs(durationSeconds, policy) {
  const minMs = Number.isFinite(Number(policy?.minMs)) ? Number(policy.minMs) : 120000;
  const perSecondMs = Number.isFinite(Number(policy?.perSecondMs)) ? Number(policy.perSecondMs) : 0;
  const duration = Number(durationSeconds);
  const scaled = Number.isFinite(duration) && duration > 0 ? duration * perSecondMs : 0;
  return Math.max(minMs, Math.round(scaled));
}

/** 命令超时错误：带上 label 与 timeoutMs，便于日志区分是哪一步挂住了 */
class MediaToolTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} 执行超时(${timeoutMs}ms)`);
    this.name = 'MediaToolTimeoutError';
    this.code = 'MEDIA_TOOL_TIMEOUT';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

function isMediaToolTimeout(error) {
  return error instanceof MediaToolTimeoutError || error?.code === 'MEDIA_TOOL_TIMEOUT';
}

/**
 * 解析 ffprobe 单值输出（N/A、空行、非数字都视为无效）。
 * 逐行找第一个有效正数：部分容器会先输出 N/A 再输出真实值。
 */
function parseDurationValue(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^n\/?a$/i.test(line)) continue;
    const value = Number.parseFloat(line);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

/**
 * 把 ASR 的分段结果格式化成 `[MM:SS] 文本` 的多行文本。
 * 时间戳只取识别结果自带的 start，不做任何按比例插值。
 */
function formatTranscriptSegments(segments) {
  if (!Array.isArray(segments)) return '';

  return segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment && typeof segment === 'object')
    .map(({ segment, index }) => {
      const text = String(segment.text ?? '').trim();
      if (!text) return null;
      const start = Number(segment.start);
      const safeStart = Number.isFinite(start) && start > 0 ? start : 0;
      return { line: `[${formatTime(safeStart)}] ${text}`, start: safeStart, index };
    })
    .filter(Boolean)
    .sort((a, b) => (a.start - b.start) || (a.index - b.index))
    .map(item => item.line)
    .join('\n');
}

function buildFallbackAnalysisResult(reason, transcript = null, visualCuts = [], visualCutStats = null) {
  const transcriptPreview = typeof transcript === 'string'
    ? transcript
      .split(/\r?\n/)
      .map(line => line.replace(/^\[[^\]]+\]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(' ')
    : '';

  return {
    title: 'AI分析暂不可用',
    tags: [],
    summary: transcriptPreview || '大模型分析暂不可用，已保留基础视频证据并进入降级分段流程。',
    segments: [],
    knowledge_points: [],
    hot_words: [],
    visual_cuts: visualCuts,
    visual_cut_stats: visualCutStats,
    raw_response: null,
    fallback_reason: reason
  };
}

class VideoAnalyzer {
  constructor(downloadDir, wss = null, options = {}) {
    this.downloadDir = downloadDir || path.join(__dirname, '../../downloads');
    this.wss = wss; // WebSocket 服务器实例
    this.spawnImpl = options.spawnImpl || spawn; // 便于测试注入
    // ffmpeg/ffprobe 执行器与超时，均可注入，便于单测覆盖超时/失败分支
    this.execImpl = typeof options.execImpl === 'function' ? options.execImpl : exec;
    this.mediaTimeoutMs = Number.isFinite(Number(options.mediaTimeoutMs)) && Number(options.mediaTimeoutMs) > 0
      ? Math.round(Number(options.mediaTimeoutMs))
      : null;
    this.ensureDownloadDir();
    // 复用 BilibiliDownloader 的校验能力（ffprobe/体积），避免两套实现漂移
    this.downloader = options.downloader || new BilibiliDownloader({ downloadDir: this.downloadDir });
    this.maxYtDlpAttempts = Number.isFinite(options.maxYtDlpAttempts)
      ? Math.max(1, options.maxYtDlpAttempts)
      : 4;
    // yt-dlp 停滞看门狗阈值：显式注入优先（测试/运维），缺省用 5 分钟。
    // 用 toPositiveNumber 而不是 Number.isFinite(Number(...))：后者会把 null 判成 0。
    const stallTimeoutOverride = toPositiveNumber(options.stallTimeoutMs);
    this.stallTimeoutMs = stallTimeoutOverride === null
      ? YT_DLP_STALL_TIMEOUT_MS
      : Math.max(1, Math.round(stallTimeoutOverride));
  }

  getEffectiveModelConfig(userConfig = null) {
    return buildEffectiveModelConfig(userConfig);
  }

  createOpenAIClient(modelConfig) {
    return new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl
    });
  }

  reportProgress(onProgress, stage, percent, message, detail = null) {
    const progressData = {
      stage,
      percent: clampPercent(percent),
      message,
      detail,
      updatedAt: new Date().toISOString()
    };
    
    // 通过 WebSocket 推送给所有连接的客户端
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        // 1 === WebSocket.OPEN；此处不能直接引用 WebSocket 类，本模块未导入它
        if (client.readyState === 1) {
          try {
            client.send(JSON.stringify({
              type: 'progress',
              data: progressData
            }));
          } catch (error) {
            console.warn('[VideoAnalyzer] WebSocket 推送失败:', error.message);
          }
        }
      });
    }
    
    // 保持原有的回调方式兼容
    if (typeof onProgress === 'function') {
      try {
        onProgress(progressData);
      } catch (error) {
        console.warn('[VideoAnalyzer] 进度上报失败:', error.message);
      }
    }
  }

  ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /** 本次调用该给多久超时：显式注入优先，否则按视频时长缩放 */
  resolveTimeoutMs(durationSeconds, policy) {
    if (Number.isFinite(this.mediaTimeoutMs)) return this.mediaTimeoutMs;
    return resolveMediaTimeoutMs(durationSeconds, policy);
  }

  /**
   * 统一执行 ffmpeg/ffprobe：带超时，超时后杀掉整个进程树并抛 MediaToolTimeoutError。
   * 通过 this.execImpl 注入，便于单测。
   */
  runMediaCommand(command, { label = 'ffmpeg', timeoutMs = null, maxBuffer = 8 * 1024 * 1024 } = {}) {
    // 不能用 Number.isFinite(Number(timeoutMs)) 判断"是否显式传了超时"：
    // Number(null) === 0 是有限数，会把"不传 timeoutMs"误判成 0，取整成 1ms 让命令瞬时超时，
    // 下面按 probe 策略兜底的分支永远不可达。
    const timeoutOverride = toPositiveNumber(timeoutMs);
    const effectiveTimeoutMs = timeoutOverride !== null
      ? Math.max(1, Math.round(timeoutOverride))
      : this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timer = null;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };

      let child;
      try {
        child = this.execImpl(command, { shell: true, windowsHide: true, maxBuffer }, (error, stdout, stderr) => {
          if (error) {
            if (timedOut) {
              finish(reject, new MediaToolTimeoutError(label, effectiveTimeoutMs));
              return;
            }
            const wrapped = error instanceof Error ? error : new Error(String(error));
            wrapped.stdout = stdout;
            wrapped.stderr = stderr;
            wrapped.label = label;
            finish(reject, wrapped);
            return;
          }
          finish(resolve, { stdout, stderr });
        });
      } catch (error) {
        finish(reject, error);
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // 进程被杀后回调不一定触发（Windows 上尤其如此），这里直接兜底
        finish(reject, new MediaToolTimeoutError(label, effectiveTimeoutMs));
      }, effectiveTimeoutMs);

      // 回调有可能在定时器注册前就同步返回，这种情况下别把定时器留在事件循环里
      if (settled) clearTimeout(timer);
    });
  }

  /** 删除半成品文件：失败时只记日志，不掩盖真正的错误 */
  removeFileQuietly(filePath, reason = '') {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.warn(`[VideoAnalyzer] 已删除${reason ? `（${reason}）` : ''}: ${filePath}`);
      }
    } catch (error) {
      console.warn(`[VideoAnalyzer] 删除文件失败 ${filePath}: ${error.message}`);
    }
  }

  /**
   * 从B站URL提取视频信息
   */
  extractBilibiliInfo(url) {
    // 支持 BV 号和完整URL
    const bvMatch = url.match(/BV[\w]+/i);
    if (bvMatch) {
      return { bvid: bvMatch[0], url };
    }
    throw new Error('无法从URL中提取BV号');
  }

  /**
   * 查找并校验可用的缓存视频；校验不通过的文件会被删除，避免命中中断产物。
   * 只认规范文件名 `{bvid}.mp4`：`{bvid}.durl-2.mp4`、`{bvid}.f80.mp4` 等是中断留下的
   * 中间产物，本身也是合法 mp4，用模糊匹配会被误当成整片缓存。
   */
  async findUsableCachedVideo(bvid) {
    if (!bvid) return null;

    const candidate = path.join(this.downloadDir, `${bvid}.mp4`);
    if (!fs.existsSync(candidate)) return null;

    if (await this.downloader.isUsableCache(candidate)) return candidate;
    return null;
  }

  /** 只打印 Cookie 的缺失项，绝不输出 Cookie 值 */
  logCookieDiagnostics(cookiesPath) {
    try {
      const cookiesContent = fs.readFileSync(cookiesPath, 'utf8');
      const requiredCookies = ['SESSDATA', 'bili_jct', 'DedeUserID'];
      const missing = requiredCookies.filter(name => !new RegExp(`(?:^|\\n)[^\\n]*\\t${name}\\t`).test(cookiesContent));
      if (missing.length > 0) {
        console.warn(`[VideoAnalyzer] cookies 可能不完整，缺少: ${missing.join(', ')}`);
      }
    } catch (error) {
      console.warn('[VideoAnalyzer] 读取 cookies 文件失败，继续尝试下载:', scrubSecrets(error.message));
    }
  }

  /**
   * 单次 yt-dlp 尝试。失败时抛出带 code/reason 的 DownloadError。
   */
  async runYtDlpAttempt({
    bvid,
    url,
    outputPath,
    onProgress = null,
    cookiesPath = null,
    useWbi = true,
    strategy = 'yt_dlp',
    withCookie = false
  }) {
    const outputTemplate = path.join(this.downloadDir, `${bvid}.%(ext)s`);

    // 构建基础参数（避免过多浏览器专有请求头触发风控）
    const args = [
      '-m', 'yt_dlp',
      '--newline',
      '--ffmpeg-location', ffmpegPath,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--remux-video', 'mp4',
      '--user-agent', YTDLP_USER_AGENT,
      '--referer', 'https://www.bilibili.com/',
      '--no-check-certificate',
      '--ignore-config',
      '--no-warnings',
      // 死连接由 yt-dlp 自己快速失败并换源重试；看门狗（进程级静默）只做最后兜底，
      // 两者配合：socket 级先失败，进程级兜住真正的网络黑洞
      '--socket-timeout', String(YT_DLP_SOCKET_TIMEOUT_SECONDS),
      '--extractor-args', `bilibili:use_wbi=${useWbi ? 'true' : 'false'}`
    ];

    if (useWbi) {
      args.push(
        '--add-header', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        '--add-header', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
        '--extractor-retries', '2',
        '--retries', '2',
        '--fragment-retries', '2'
      );
    } else {
      args.push('--extractor-retries', '3', '--retries', '3', '--fragment-retries', '3');
    }

    if (withCookie && cookiesPath) {
      args.push('--cookies', cookiesPath);
    }

    args.push('-o', outputTemplate, url);

    const progressReporter = (downloadPercent, wholePercent) => {
      const mappedPercent = 5 + (downloadPercent / 100) * 15;
      this.reportProgress(onProgress, 'download', mappedPercent, `正在下载 ${wholePercent}%`, {
        strategy,
        withCookie,
        useWbi
      });
    };

    const stallTimeoutMs = this.stallTimeoutMs;

    const result = await new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl('python', args, { windowsHide: true });
      } catch (error) {
        // spawn 同步抛出（可执行文件不存在等）：走既有的非零退出码分类路径
        resolve({ code: -1, output: error?.message || String(error), stalled: false });
        return;
      }

      let outputTail = '';
      let lastReportedPercent = -1;
      let settled = false;
      let stallTimer = null;

      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      const settle = (payload) => {
        if (settled) return;
        settled = true;
        // 必须清掉看门狗：settle 之后残留的定时器会拖住事件循环，
        // 极端情况下还会对着已退出的进程重复调用 killProcessTree
        clearStallTimer();
        resolve(payload);
      };

      /**
       * 停滞看门狗：只在"连续 stallTimeoutMs 无任何输出"时才判定停滞，
       * 每次 stdout/stderr 数据到达都会重置，因此长视频持续有进度输出时不会被误杀。
       */
      const armStallTimer = () => {
        if (settled) return;
        clearStallTimer();
        stallTimer = setTimeout(() => {
          console.warn(`[VideoAnalyzer] yt-dlp 连续 ${stallTimeoutMs}ms 无任何输出，判定为停滞，终止进程树`);
          killProcessTree(child);
          // Windows 上 taskkill 之后 close 事件不一定到达，这里必须自行兜底 settle
          settle({ code: null, output: outputTail, stalled: true });
        }, stallTimeoutMs);
      };

      const appendOutput = (text) => {
        outputTail = `${outputTail}${text}`.slice(-8000);
      };

      const handleOutput = (chunk) => {
        if (settled) return;
        // 任何输出（下载进度、ffmpeg 转封装提示、告警）都说明进程还活着，重置看门狗
        armStallTimer();

        const text = chunk.toString();
        appendOutput(text);

        const matches = [...text.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)];
        if (matches.length === 0) return;

        const rawPercent = Number(matches[matches.length - 1][1]);
        if (!Number.isFinite(rawPercent)) return;

        const downloadPercent = Math.max(0, Math.min(100, rawPercent));
        const wholePercent = Math.floor(downloadPercent);
        if (wholePercent === lastReportedPercent) return;

        lastReportedPercent = wholePercent;
        progressReporter(downloadPercent, wholePercent);
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);
      child.on('error', (error) => settle({ code: -1, output: `${outputTail}\n${error.message}`, stalled: false }));
      child.on('close', (code) => settle({ code, output: outputTail, stalled: false }));
      // 必须在注册监听之后启动：先武装定时器再挂监听的话，
      // 极端情况下同步到达的数据会重置一个尚未赋值的定时器句柄
      armStallTimer();
    });

    if (result.stalled) {
      // 停滞按可重试处理：下一档策略（use_wbi 切换 / 匿名）仍值得尝试，
      // 网络黑洞往往只在某条连接/某个参数组合上出现
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.PROCESS_STALLED,
        stage: ERROR_STAGES.YT_DLP,
        retryable: true,
        message: `yt-dlp 连续 ${stallTimeoutMs}ms 无任何输出，判定为停滞并终止进程树（${strategy}${withCookie ? '/cookie' : '/anonymous'}）: ${truncateTail(result.output)}`
      });
    }

    if (result.code !== 0) {
      const error = classifyYtDlpFailure(result.output, { stage: ERROR_STAGES.YT_DLP });
      if (error.code === ERROR_CODES.DOWNLOAD_FAILED && error.reason === ERROR_REASONS.UNKNOWN) {
        error.message = `yt-dlp 退出码 ${result.code}（${strategy}${withCookie ? '/cookie' : '/anonymous'}）: ${truncateTail(result.output)}`;
      }
      throw error;
    }

    if (!fs.existsSync(outputPath)) {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_NOT_FOUND,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: 'yt-dlp 执行完成但找不到输出文件'
      });
    }

    return outputPath;
  }

  /**
   * 使用 yt-dlp 下载 B 站视频（支持手动 cookies 文件）。
   *
   * 策略：Cookie → 匿名；出现 412 时在同一 Cookie 策略内切换 use_wbi=false 兼容参数。
   * 失败时抛出带 code/reason/stage/attempts 的 DownloadError。
   *
   * @param {string} bvid
   * @param {string} url
   * @param {Function|null} onProgress
   * @param {string|null} cookiesPath
   * @param {object} [options] { onAttempt } 用于向上层汇报每次尝试
   * @returns {Promise<string>} 视频文件路径
   */
  async downloadVideo(bvid, url, onProgress = null, cookiesPath = null, options = {}) {
    const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : null;
    const attempts = new AttemptLog();

    const recordAttempt = (entry) => {
      const stored = attempts.add(entry);
      if (onAttempt) {
        try { onAttempt({ ...stored }); } catch (_) { /* noop */ }
      }
      return stored;
    };

    // 缓存命中必须通过完整性校验
    const cachedPath = await this.findUsableCachedVideo(bvid);
    if (cachedPath) {
      console.log(`[VideoAnalyzer] 视频已存在且校验通过: ${cachedPath}`);
      this.reportProgress(onProgress, 'download', 20, '视频已缓存，跳过下载');
      recordAttempt({ strategy: 'yt_dlp_cache', withCookie: false, ok: true, message: '命中有效缓存' });
      return cachedPath;
    }

    const outputPath = path.join(this.downloadDir, `${bvid}.mp4`);
    // 清掉上次异常中断留下的中间产物，避免堆积与误判
    // downloader 是可注入依赖，这里用可选调用，不强制其实现该扩展方法
    this.downloader.cleanupStaleArtifacts?.(bvid);

    const hasCookies = Boolean(cookiesPath && fs.existsSync(cookiesPath));

    if (hasCookies) {
      this.logCookieDiagnostics(cookiesPath);
      console.log('[VideoAnalyzer] 使用临时 cookies 文件进行下载');
    } else {
      console.log('[VideoAnalyzer] 无 cookies 文件，使用无认证模式下载');
    }

    // 每个策略最多一次；use_wbi=false 只在前一次遇到 412 时才追加
    const plan = [
      { withCookie: true, useWbi: true, when: () => hasCookies },
      { withCookie: true, useWbi: false, when: previous => hasCookies && isRiskControlError(previous) },
      { withCookie: false, useWbi: true, when: previous => !isFatalDownloadError(previous) },
      { withCookie: false, useWbi: false, when: previous => isRiskControlError(previous) }
    ].slice(0, this.maxYtDlpAttempts);

    let lastError = null;
    let cookieRejected = false;

    for (const step of plan) {
      if (step.withCookie && cookieRejected) continue;
      if (!step.when(lastError)) continue;

      const strategy = step.withCookie ? 'yt_dlp' : 'yt_dlp_anonymous';

      try {
        this.reportProgress(onProgress, 'download', 5, step.withCookie ? '正在使用 Cookie 下载' : '正在匿名下载', {
          strategy,
          withCookie: step.withCookie,
          useWbi: step.useWbi
        });

        await this.runYtDlpAttempt({
          bvid,
          url,
          outputPath,
          onProgress,
          cookiesPath: step.withCookie ? cookiesPath : null,
          useWbi: step.useWbi,
          strategy,
          withCookie: step.withCookie
        });

        const validation = await this.downloader.validateVideoFile(outputPath, { label: 'yt-dlp 下载视频' });
        recordAttempt({
          strategy,
          withCookie: step.withCookie,
          ok: true,
          message: `下载成功（${(validation.size / 1024 / 1024).toFixed(2)} MB）`
        });
        this.reportProgress(onProgress, 'download', 20, '视频下载完成');
        console.log(`[VideoAnalyzer] 视频下载完成: ${outputPath}`);
        return outputPath;
      } catch (error) {
        lastError = error;
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (_) { /* noop */ }

        const entry = recordAttempt(attemptEntryFromError(strategy, error, { withCookie: step.withCookie }));
        console.warn(
          `[VideoAnalyzer] ${strategy}${step.withCookie ? '(cookie)' : '(anonymous)'} use_wbi=${step.useWbi} 失败: ${entry.code}/${entry.reason} - ${entry.message}`
        );

        if (isFatalDownloadError(error)) throw withAttempts(error, attempts.toJSON());
        if (entry.reason === ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED) cookieRejected = true;
      }
    }

    throw finalizeDownloadError({ attempts: attempts.toJSON(), lastError, stage: ERROR_STAGES.YT_DLP });
  }

  /**
   * 混合下载策略（策略顺序）：
   *   A. B 站接口 + Cookie
   *   B. B 站接口 + 匿名   —— A→B 降级在 BilibiliDownloader 内部完成
   *   C. yt-dlp + Cookie
   *   D. yt-dlp + 匿名     —— C→D 降级在 downloadVideo 内部完成
   *
   * 任一步骤判定为 INVALID_INPUT / VIDEO_INACCESSIBLE 时立即中止，不做无意义重试；
   * 最终错误由全部尝试记录统一分类（全 412 时必须是 RISK_CONTROL_412）。
   */
  async downloadVideoHybrid(bvid, url, onProgress = null, cookiesPath = null, options = {}) {
    const attempts = [];
    const forwardAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : null;
    const collectAttempt = (entry) => {
      attempts.push(entry);
      if (forwardAttempt) {
        try { forwardAttempt(entry); } catch (_) { /* noop */ }
      }
    };

    const reportProgress = (progress) => {
      this.reportProgress(onProgress, progress.stage, progress.percent, progress.message, {
        strategy: progress.strategy || null,
        withCookie: progress.withCookie ?? null
      });
    };

    const describe = (error) => (isDownloadError(error) ? `${error.code}/${error.reason}` : error?.message);

    let lastError = null;

    // A / B：B 站专用接口
    try {
      console.log('[VideoAnalyzer] 尝试使用 Bilibili 专用下载器...');
      const result = await this.downloader.downloadVideo(url, reportProgress, {
        cookiesPath,
        onAttempt: collectAttempt
      });
      console.log('[VideoAnalyzer] Bilibili 专用下载器成功');
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`[VideoAnalyzer] Bilibili 专用下载器失败: ${describe(error)}`);
      if (isFatalDownloadError(error)) throw withAttempts(error, attempts);
    }

    // C / D：yt-dlp
    try {
      console.log('[VideoAnalyzer] 回退到 yt-dlp 下载器...');
      return await this.downloadVideo(bvid, url, onProgress, cookiesPath, { onAttempt: collectAttempt });
    } catch (error) {
      lastError = error;
      console.warn(`[VideoAnalyzer] yt-dlp 下载器失败: ${describe(error)}`);
      if (isFatalDownloadError(error)) throw withAttempts(error, attempts);
    }

    throw finalizeDownloadError({ attempts, lastError });
  }

  /**
   * 获取视频时长（秒）。
   *
   * 三级探测，任一环拿到有效值即返回：
   *   1. ffprobe format=duration        → durationSource='probe'
   *   2. ffprobe 视频流 duration        → durationSource='probe'
   *   3. ffmpeg 全片解码取最大 pts_time → durationSource='decoded'
   *
   * 三级全部失败时返回 { duration: null, durationSource: 'unknown' }。
   * 不再兜底 300 秒：错误的时长会同时污染抽帧 fps、自适应阈值和契约里的 duration。
   * @returns {Promise<{duration: number|null, durationSource: 'probe'|'decoded'|'unknown', detail: string}>}
   */
  async getVideoDuration(videoPath) {
    const attempts = [];
    const ffprobePath = resolveFfprobePath();

    if (ffprobePath) {
      // 1) 容器层 duration：绝大多数 mp4/flv 都能直接读到
      try {
        const { stdout } = await this.runMediaCommand(
          `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
          { label: 'ffprobe format=duration', timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe) }
        );
        const duration = parseDurationValue(stdout);
        if (duration !== null) {
          console.log(`[VideoAnalyzer] 视频时长: ${formatTime(duration)} (${duration.toFixed(2)}秒, 来源=ffprobe format)`);
          return { duration, durationSource: 'probe', detail: 'format=duration' };
        }
        attempts.push('format=duration 无有效数值');
      } catch (error) {
        attempts.push(`format=duration 失败: ${error.message}`);
        console.warn(`[VideoAnalyzer] ffprobe format=duration 失败: ${error.message}`);
      }

      // 2) 视频流 duration：部分容器（如分段 flv、raw h264）只在流上带时长
      try {
        const { stdout } = await this.runMediaCommand(
          `"${ffprobePath}" -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
          { label: 'ffprobe stream=duration', timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe) }
        );
        const duration = parseDurationValue(stdout);
        if (duration !== null) {
          console.log(`[VideoAnalyzer] 视频时长: ${formatTime(duration)} (${duration.toFixed(2)}秒, 来源=ffprobe stream)`);
          return { duration, durationSource: 'probe', detail: 'stream=duration' };
        }
        attempts.push('stream=duration 无有效数值');
      } catch (error) {
        attempts.push(`stream=duration 失败: ${error.message}`);
        console.warn(`[VideoAnalyzer] ffprobe stream=duration 失败: ${error.message}`);
      }
    } else {
      attempts.push('ffprobe 不可用');
      console.warn('[VideoAnalyzer] 未找到 ffprobe，跳过两级 ffprobe 时长探测');
    }

    // 3) 最后手段：解到最后一帧，取最大 pts_time
    try {
      const { stderr } = await this.runMediaCommand(
        `"${ffmpegPath}" -hide_banner -nostats -i "${videoPath}" -map 0:v:0 -an -vf showinfo -f null -`,
        {
          label: 'ffmpeg decode-duration',
          timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.decode),
          maxBuffer: 32 * 1024 * 1024
        }
      );
      const times = parsePtsTimes(stderr);
      const duration = times.reduce((max, time) => (time > max ? time : max), 0);
      if (duration > 0) {
        console.log(`[VideoAnalyzer] 视频时长: ${formatTime(duration)} (${duration.toFixed(2)}秒, 来源=解码末帧)`);
        return { duration, durationSource: 'decoded', detail: 'decode_max_pts' };
      }
      attempts.push('解码未取到 pts_time');
    } catch (error) {
      attempts.push(`解码探测失败: ${error.message}`);
      console.warn(`[VideoAnalyzer] ffmpeg 解码探测时长失败: ${error.message}`);
    }

    const detail = attempts.join('; ');
    console.warn(`[VideoAnalyzer] 无法获取视频时长，将按“时长未知”继续（不影响分析是否完成）: ${detail}`);
    return { duration: null, durationSource: 'unknown', detail };
  }

  /**
   * 使用ffprobe获取视频关键帧时间戳
   * @param {string} videoPath - 视频路径
   * @returns {Promise<number[]>} 关键帧时间戳（秒）
   */
  async extractKeyframeTimestamps(videoPath) {
    try {
      const ffprobePath = resolveFfprobePath();
      if (ffprobePath) {
        const command = `"${ffprobePath}" -v error -select_streams v -skip_frame nokey -show_entries frame=pkt_pts_time -of csv=p=0 "${videoPath}"`;
        const { stdout } = await this.runMediaCommand(command, {
          label: 'ffprobe 关键帧时间戳',
          timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe),
          maxBuffer: 8 * 1024 * 1024
        });
        const timestamps = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line)
          .map(line => parseFloat(line))
          .filter(t => !Number.isNaN(t));
        if (timestamps.length > 0) return timestamps;
      }

      const command = `"${ffmpegPath}" -skip_frame nokey -i "${videoPath}" -map 0:v:0 -an -vf showinfo -f null -`;
      const { stderr } = await this.runMediaCommand(command, {
        label: 'ffmpeg 关键帧时间戳',
        timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.decode),
        maxBuffer: 16 * 1024 * 1024
      });
      const timestamps = parsePtsTimes(stderr);
      if (timestamps.length > 0) {
        console.log(`[VideoAnalyzer] 使用 ffmpeg showinfo 提取关键帧时间戳: ${timestamps.length} 个`);
      }
      return timestamps;
    } catch (error) {
      console.warn('[VideoAnalyzer] 提取关键帧时间戳失败，回退到均匀采样', error.message);
      return [];
    }
  }

  /**
   * 使用ffmpeg提取视频关键帧
   * @param {string} videoPath - 视频路径
   * @param {string} bvid - 视频BV号
   */
  async extractFrames(videoPath, bvid, onProgress = null) {
    const framesDir = path.join(this.downloadDir, `${bvid}_frames`);

    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    // 先清掉上一轮的帧，否则残留旧帧会被当成这一轮的证据
    for (const file of fs.readdirSync(framesDir)) {
      if (/\.(jpe?g|png)$/i.test(file)) {
        fs.unlinkSync(path.join(framesDir, file));
      }
    }

    console.log(`[VideoAnalyzer] 提取视频关键帧...`);
    this.reportProgress(onProgress, 'frames', 22, '正在准备抽帧');

    try {
      // 获取视频实际时长（三级探测，拿不到就是 null，不再兜底 300 秒）
      const { duration, durationSource, detail: durationDetail } = await this.getVideoDuration(videoPath);
      this.reportProgress(onProgress, 'frames', 24, '正在定位关键帧');

      // 尝试使用ffprobe获取关键帧时间戳（更接近场景切换）
      let timestamps = await this.extractKeyframeTimestamps(videoPath);

      // 如果ffprobe失败或者数据过少，退回到均匀采样
      if (!timestamps || timestamps.length < 2) {
        if (Number.isFinite(duration) && duration > 0) {
          const interval = 5;
          const frameCount = Math.ceil(duration / interval);
          timestamps = Array.from({ length: frameCount }, (_, i) => i * interval);
          console.log(`[VideoAnalyzer] 关键帧时间点不足，退回到均匀采样，每 ${interval} 秒一帧`);
        } else {
          throw new Error(`无法获取视频时长且没有可用的关键帧时间戳，无法抽帧（${durationDetail}）`);
        }
      }

      // 限制最大帧数，避免发送给大模型太多图像
      const MAX_FRAMES = 30;
      if (timestamps.length > MAX_FRAMES) {
        const step = Math.ceil(timestamps.length / MAX_FRAMES);
        timestamps = timestamps.filter((_, idx) => idx % step === 0);
      }

      console.log(`[VideoAnalyzer] 将提取 ${timestamps.length} 张关键帧（基于场景/关键帧，间隔可变）`);
      this.reportProgress(onProgress, 'frames', 25, `正在抽帧 0/${timestamps.length}`);

      // 提取关键帧截图，文件名包含时间戳（毫秒），便于后续排序和提示。
      // 单帧失败只跳过并告警（seek 到损坏区段很常见），全部失败才认为抽帧失败。
      const frameTimeoutMs = this.resolveTimeoutMs(duration, MEDIA_TIMEOUT_POLICIES.frame);
      const failures = [];
      let successCount = 0;

      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const ms = Math.round(ts * 1000);
        const outputPath = path.join(framesDir, `frame_${String(i + 1).padStart(3, '0')}_${ms}.jpg`);
        const command = `"${ffmpegPath}" -ss ${ts} -i "${videoPath}" -frames:v 1 -q:v 2 -vf "scale=640:-1" "${outputPath}" -y`;
        try {
          await this.runMediaCommand(command, { label: `抽帧 t=${ts}s`, timeoutMs: frameTimeoutMs });
          successCount += 1;
        } catch (error) {
          failures.push({ time: ts, message: error.message });
          console.warn(`[VideoAnalyzer] 抽帧失败，跳过该帧 t=${ts}s: ${error.message}`);
          this.removeFileQuietly(outputPath, '抽帧残留');
        }
        const framePercent = 25 + ((i + 1) / Math.max(timestamps.length, 1)) * 15;
        this.reportProgress(onProgress, 'frames', framePercent, `正在抽帧 ${i + 1}/${timestamps.length}`);
      }

      if (successCount === 0) {
        throw new Error(`关键帧全部提取失败（${timestamps.length} 帧），首个失败原因: ${failures[0]?.message || '未知'}`);
      }
      if (failures.length > 0) {
        console.warn(`[VideoAnalyzer] 抽帧部分失败: 成功 ${successCount}/${timestamps.length}，失败 ${failures.length} 帧`);
      }

      console.log(`[VideoAnalyzer] 关键帧提取完成，保存在: ${framesDir}`);
      this.reportProgress(onProgress, 'frames', 40, '关键帧提取完成');
      return {
        framesDir,
        duration,
        durationSource,
        // 关键帧时间戳一并带出：时长探测全失败时，最大时间戳就是时长的下界，用完就丢太浪费
        keyframeTimestamps: timestamps,
        frameCount: successCount,
        failedFrameCount: failures.length
      };
    } catch (error) {
      console.error('[VideoAnalyzer] 关键帧提取失败:', error);
      throw new Error(`关键帧提取失败: ${error.message}`);
    }
  }

  /**
   * 抽取用于视觉切点检测的低分辨率连续采样帧。
   * 这组帧和发给大模型的关键帧分开，避免 30 帧上限影响切点召回。
   *
   * 时长未知时不再假定时长，而是按 sampleFps 抽完再按 maxFrames 均匀截断，
   * 并在 meta 里标出 durationSource，让阈值随 fps 漂移这件事在结果里可见。
   *
   * @returns {Promise<{frames: Array<{framePath: string, time: number}>, meta: object}>}
   */
  async extractVisualProbeFrames(videoPath, bvid, duration, onProgress = null, options = {}) {
    const framesDir = path.join(this.downloadDir, `${bvid}_visual_frames`);
    const manifestPath = path.join(framesDir, 'manifest.json');
    const sampleFps = Number.isFinite(Number(options.sampleFps)) && Number(options.sampleFps) > 0
      ? Number(options.sampleFps)
      : 1;
    const maxFrames = Number.isFinite(Number(options.maxFrames)) && Number(options.maxFrames) > 1
      ? Math.floor(Number(options.maxFrames))
      : 900;
    const scaleWidth = Number.isFinite(Number(options.scaleWidth)) && Number(options.scaleWidth) > 0
      ? Math.floor(Number(options.scaleWidth))
      : 320;
    const hasDuration = Number.isFinite(Number(duration)) && Number(duration) > 0;
    const safeDuration = hasDuration ? Number(duration) : null;
    // 时长来源由调用方传入（probe / decoded / unknown），避免这里把解码得到的时长标成 probe
    const durationSource = typeof options.durationSource === 'string'
      ? options.durationSource
      : (hasDuration ? 'probe' : 'unknown');

    if (!hasDuration) {
      console.warn('[VideoAnalyzer] 视频时长未知，视觉帧按 sampleFps 抽取后截断');
    }

    const targetFrames = hasDuration
      ? Math.max(2, Math.min(maxFrames, Math.ceil(safeDuration * sampleFps)))
      : null;
    const effectiveFps = hasDuration ? targetFrames / safeDuration : sampleFps;

    // 缓存必须绑定到具体文件：同名不同内容的视频（重下/换清晰度）不能复用旧帧
    let sourceSize = null;
    let sourceMtimeMs = null;
    try {
      const stat = fs.statSync(videoPath);
      sourceSize = stat.size;
      sourceMtimeMs = Math.round(stat.mtimeMs);
    } catch (error) {
      console.warn(`[VideoAnalyzer] 读取视频指纹失败，视觉帧缓存将不复用: ${error.message}`);
    }

    const buildMeta = (frameCount, cached) => ({
      frameCount,
      targetFrames,
      effectiveFps,
      sampleFps,
      scaleWidth,
      maxFrames,
      duration: safeDuration,
      durationSource,
      cached
    });

    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // 老 manifest 没有 source_size/source_mtime_ms，一律视为不匹配，重新抽帧
        const cacheMatchesOptions =
          Math.abs(Number(manifest.sample_fps) - sampleFps) < 0.0001 &&
          Number(manifest.scale_width) === scaleWidth &&
          Number(manifest.max_frames || maxFrames) === maxFrames &&
          path.resolve(String(manifest.source_video || '')) === path.resolve(videoPath) &&
          sourceSize !== null &&
          Number(manifest.source_size) === sourceSize &&
          Number(manifest.source_mtime_ms) === sourceMtimeMs &&
          (hasDuration
            ? Math.abs(Number(manifest.duration || 0) - safeDuration) < 0.5
            : manifest.duration === null || manifest.duration === undefined);
        const cachedFrames = Array.isArray(manifest.frames)
          ? manifest.frames
            .map(frame => ({
              framePath: path.join(framesDir, frame.file),
              time: Number(frame.time)
            }))
            .filter(frame => fs.existsSync(frame.framePath) && Number.isFinite(frame.time))
          : [];

        if (cacheMatchesOptions && cachedFrames.length >= 2) {
          console.log(`[VideoAnalyzer] 视觉检测帧已缓存: ${cachedFrames.length} 张`);
          this.reportProgress(onProgress, 'visual', 41, '视觉检测帧已缓存');
          return { frames: cachedFrames, meta: buildMeta(cachedFrames.length, true) };
        }
        if (cachedFrames.length >= 2 && !cacheMatchesOptions) {
          console.log('[VideoAnalyzer] 视觉帧缓存与当前视频指纹不匹配，重新抽帧');
        }
      } catch (error) {
        console.warn('[VideoAnalyzer] 读取视觉帧缓存失败，将重新抽帧:', error.message);
      }
    }

    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    for (const file of fs.readdirSync(framesDir)) {
      if (/\.(jpe?g|png)$/i.test(file)) {
        fs.unlinkSync(path.join(framesDir, file));
      }
    }

    console.log(`[VideoAnalyzer] 抽取视觉检测帧: target=${targetFrames ?? 'unknown'}, fps=${effectiveFps.toFixed(4)}`);
    this.reportProgress(onProgress, 'visual', 41, '正在抽取视觉检测帧');

    const outputPattern = path.join(framesDir, 'visual_%06d.jpg');
    const command = `"${ffmpegPath}" -i "${videoPath}" -vf "fps=${effectiveFps.toFixed(4)},scale=${scaleWidth}:-1" -q:v 5 "${outputPattern}" -y`;
    await this.runMediaCommand(command, {
      label: '视觉检测帧抽取',
      timeoutMs: this.resolveTimeoutMs(safeDuration, MEDIA_TIMEOUT_POLICIES.decode)
    });

    const files = fs.readdirSync(framesDir)
      .filter(file => /^visual_\d+\.jpg$/i.test(file))
      .sort();

    let frames = files.map((file, index) => ({
      framePath: path.join(framesDir, file),
      time: Number((index / effectiveFps).toFixed(3))
    }));

    // 只有时长未知时才可能超上限：此时按固定步长均匀截断，保持确定性
    if (frames.length > maxFrames) {
      const step = Math.ceil(frames.length / maxFrames);
      frames = frames.filter((_, index) => index % step === 0);
      console.warn(`[VideoAnalyzer] 视觉帧数超过上限，按 step=${step} 截断到 ${frames.length} 张`);
    }

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        generated_at: new Date().toISOString(),
        source_video: videoPath,
        source_size: sourceSize,
        source_mtime_ms: sourceMtimeMs,
        duration: safeDuration,
        duration_source: durationSource,
        sample_fps: sampleFps,
        max_frames: maxFrames,
        effective_fps: effectiveFps,
        scale_width: scaleWidth,
        frames: frames.map(frame => ({
          file: path.basename(frame.framePath),
          time: frame.time
        }))
      }, null, 2),
      'utf8'
    );

    console.log(`[VideoAnalyzer] 视觉检测帧抽取完成: ${frames.length} 张`);
    return { frames, meta: buildMeta(frames.length, false) };
  }

  /**
   * 用 ffprobe 检查音频文件是否有音频流、时长多少。
   * ffprobe 不可用时返回 { checked: false }，调用方降级为只校验体积。
   */
  async probeAudioFile(audioPath) {
    const ffprobePath = resolveFfprobePath();
    if (!ffprobePath) return { checked: false, hasAudio: null, duration: null };

    const timeoutMs = this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe);
    try {
      const { stdout: streamOut } = await this.runMediaCommand(
        `"${ffprobePath}" -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
        { label: 'ffprobe 音频流', timeoutMs }
      );
      const hasAudio = /audio/i.test(String(streamOut || ''));

      let duration = null;
      try {
        const { stdout: durationOut } = await this.runMediaCommand(
          `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
          { label: 'ffprobe 音频时长', timeoutMs }
        );
        duration = parseDurationValue(durationOut);
      } catch (error) {
        console.warn(`[VideoAnalyzer] 读取音频时长失败: ${error.message}`);
      }

      return { checked: true, hasAudio, duration };
    } catch (error) {
      return { checked: false, hasAudio: null, duration: null, error: error.message };
    }
  }

  /**
   * 读取视频中音轨的时长（秒）。
   * 容器时长可能含没有声音的尾巴，校验音频缓存时音轨时长是更准确的参照。
   * 拿不到就返回 null，由调用方退回容器时长。
   */
  async getVideoAudioStreamDuration(videoPath) {
    const ffprobePath = resolveFfprobePath();
    if (!ffprobePath) return null;

    try {
      const { stdout } = await this.runMediaCommand(
        `"${ffprobePath}" -v error -select_streams a:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { label: 'ffprobe 音轨时长', timeoutMs: this.resolveTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe) }
      );
      return parseDurationValue(stdout);
    } catch (error) {
      console.warn(`[VideoAnalyzer] 读取视频音轨时长失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 校验音频文件是否可用：体积下限 + 能读出音频流 + 时长与视频接近。
   * 只判断“文件存在”会把 0 字节 / 半截 wav 永久当成有效缓存。
   */
  async validateAudioFile(audioPath, { videoDuration = null } = {}) {
    let stat;
    try {
      stat = fs.statSync(audioPath);
    } catch (_) {
      return { ok: false, reason: '文件不存在' };
    }

    if (stat.size < MIN_AUDIO_BYTES) {
      return { ok: false, reason: `体积过小(${stat.size} 字节)` };
    }

    const probe = await this.probeAudioFile(audioPath);
    if (probe.checked && probe.hasAudio === false) {
      return { ok: false, reason: 'ffprobe 读不到音频流' };
    }

    const expectedDuration = Number.isFinite(Number(videoDuration)) && Number(videoDuration) > 0
      ? Number(videoDuration)
      : null;
    if (expectedDuration && Number.isFinite(probe.duration) && probe.duration > 0) {
      const tolerance = Math.max(AUDIO_DURATION_TOLERANCE_SECONDS, expectedDuration * 0.02);
      if (Math.abs(probe.duration - expectedDuration) > tolerance) {
        return {
          ok: false,
          reason: `时长不匹配(音频 ${probe.duration.toFixed(1)}s / 视频 ${expectedDuration.toFixed(1)}s)`
        };
      }
    }

    return { ok: true, probed: probe.checked, duration: probe.duration, size: stat.size };
  }

  /**
   * 从视频中提取音频
   *
   * 命中缓存前必须先校验（体积 / 音频流 / 时长），坏缓存删掉重提；
   * 提取失败或超时必须删除半成品，否则一次失败会永久污染后续所有分析。
   * @returns {Promise<string>} 实际可用的音频路径（可能是历史遗留的 .mp3）
   */
  async extractAudio(videoPath, bvid, onProgress = null, options = {}) {
    const audioPath = path.join(this.downloadDir, `${bvid}.wav`);
    const legacyMp3Path = path.join(this.downloadDir, `${bvid}.mp3`);

    let resolvedVideoDuration;
    const getVideoDurationForCheck = async () => {
      if (resolvedVideoDuration !== undefined) return resolvedVideoDuration;

      if (Number.isFinite(Number(options.duration)) && Number(options.duration) > 0) {
        resolvedVideoDuration = Number(options.duration);
      } else {
        const probed = await this.getVideoDuration(videoPath);
        resolvedVideoDuration = probed.duration;
      }

      // 音轨时长比容器时长更贴近「提取出来的音频应该有多长」（容器可能有纯画面尾巴）
      const audioTrackDuration = await this.getVideoAudioStreamDuration(videoPath);
      if (Number.isFinite(audioTrackDuration) && audioTrackDuration > 0) {
        if (Number.isFinite(resolvedVideoDuration) && Math.abs(audioTrackDuration - resolvedVideoDuration) > 1) {
          console.log(
            `[VideoAnalyzer] 音轨时长 ${audioTrackDuration.toFixed(1)}s 与容器时长 ${resolvedVideoDuration.toFixed(1)}s 不同，按音轨时长校验音频缓存`
          );
        }
        resolvedVideoDuration = audioTrackDuration;
      }

      return resolvedVideoDuration;
    };

    // 1) 已有的 wav
    if (fs.existsSync(audioPath)) {
      const verdict = await this.validateAudioFile(audioPath, { videoDuration: await getVideoDurationForCheck() });
      if (verdict.ok) {
        console.log(`[VideoAnalyzer] 音频已存在且校验通过: ${audioPath}`);
        this.reportProgress(onProgress, 'audio', 44, '音频已缓存，准备识别');
        return audioPath;
      }
      console.warn(`[VideoAnalyzer] 音频缓存不可用(${verdict.reason})，删除后重新提取`);
      this.removeFileQuietly(audioPath, '损坏的音频缓存');
    }

    // 2) 历史遗留的 mp3：同样要校验，通过才复用
    if (fs.existsSync(legacyMp3Path)) {
      const verdict = await this.validateAudioFile(legacyMp3Path, { videoDuration: await getVideoDurationForCheck() });
      if (verdict.ok) {
        console.log(`[VideoAnalyzer] 复用历史 mp3 音频: ${legacyMp3Path}`);
        this.reportProgress(onProgress, 'audio', 44, '音频已缓存，准备识别');
        return legacyMp3Path;
      }
      console.warn(`[VideoAnalyzer] 历史 mp3 音频不可用(${verdict.reason})，删除后重新提取`);
      this.removeFileQuietly(legacyMp3Path, '损坏的历史音频');
    }

    console.log(`[VideoAnalyzer] 提取音频为WAV格式...`);
    this.reportProgress(onProgress, 'audio', 42, '正在提取音频');

    // 使用ffmpeg提取音频，采样率16000Hz，单声道，使用WAV格式（更兼容paraformer-v2）
    const command = `"${ffmpegPath}" -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`;
    try {
      await this.runMediaCommand(command, {
        label: '音频提取',
        timeoutMs: this.resolveTimeoutMs(options.duration, MEDIA_TIMEOUT_POLICIES.audio)
      });
    } catch (error) {
      this.removeFileQuietly(audioPath, '提取失败/超时的半成品');
      console.error('[VideoAnalyzer] 音频提取失败:', error.message);
      throw new Error(`音频提取失败: ${error.message}`);
    }

    // 刚提取的文件也要过一遍体积 + 音频流校验：视频没有音轨时 ffmpeg 可能留下空壳
    const verdict = await this.validateAudioFile(audioPath, { videoDuration: null });
    if (!verdict.ok) {
      this.removeFileQuietly(audioPath, `提取结果无效: ${verdict.reason}`);
      throw new Error(`音频提取结果无效: ${verdict.reason}`);
    }

    // 时长偏差只告警不失败：截断的音频仍可用于识别，直接失败会让整条音频链路无谓降级
    const referenceDuration = await getVideoDurationForCheck();
    if (Number.isFinite(referenceDuration) && Number.isFinite(verdict.duration)) {
      const tolerance = Math.max(AUDIO_DURATION_TOLERANCE_SECONDS, referenceDuration * 0.02);
      if (Math.abs(verdict.duration - referenceDuration) > tolerance) {
        console.warn(
          `[VideoAnalyzer] 提取出的音频时长(${verdict.duration.toFixed(1)}s)与视频音轨(${referenceDuration.toFixed(1)}s)差异较大，可能被截断`
        );
      }
    }

    console.log(`[VideoAnalyzer] 音频提取完成: ${audioPath}`);
    this.reportProgress(onProgress, 'audio', 44, '音频提取完成');
    return audioPath;
  }

  /**
   * 使用统一 ASR 服务进行音频转录（DashScope paraformer-v2 优先，失败降级本地 Whisper）
   *
   * 进度区间保持 45 → 58；ASR 内部的 0-100 进度映射到该区间。
   * @param {string} audioPath - 音频文件路径
   * @param {string} bvid - 视频BV号
   * @returns {Promise<string|null>} `[MM:SS] 文本` 多行文本；拿不到结果时返回 null
   */
  async transcribeAudio(audioPath, bvid, userConfig = null, onProgress = null) {
    console.log('[VideoAnalyzer] 开始语音识别...');
    this.reportProgress(onProgress, 'speech', 45, '正在准备语音识别');

    if (!audioPath || !fs.existsSync(audioPath)) {
      console.warn(`[VideoAnalyzer] 音频文件不可用，跳过语音识别: ${audioPath || '未提供'}`);
      this.reportProgress(onProgress, 'speech', 58, '音频不可用，跳过语音识别');
      return null;
    }

    const reportAsrProgress = (stage, percent) => {
      const numeric = Number(percent);
      const ratio = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) / 100 : 0;
      this.reportProgress(onProgress, 'speech', 45 + ratio * 13, `正在识别音频(${stage || 'processing'})`);
    };

    try {
      const result = await asrService.transcribe(audioPath, {
        userConfig,
        bvid,
        onProgress: reportAsrProgress
      });

      // 降级原因必须留在日志里，不能静默消失
      for (const note of result.degradations || []) {
        console.warn(`[VideoAnalyzer] ASR 降级: ${note}`);
      }
      if (result.error) {
        console.warn(`[VideoAnalyzer] ASR 未成功: ${result.error}`);
      }

      if (!result.transcript || result.transcript.length === 0) {
        console.warn('[VideoAnalyzer] 未获得转录文本，继续画面分析');
        this.reportProgress(onProgress, 'speech', 58, '未获得语音文本，继续画面分析');
        return null;
      }

      const transcript = formatTranscriptSegments(result.transcript);
      if (!transcript) {
        console.warn('[VideoAnalyzer] 转录结果为空文本，继续画面分析');
        this.reportProgress(onProgress, 'speech', 58, '未获得语音文本，继续画面分析');
        return null;
      }

      console.log(`[VideoAnalyzer] 语音识别完成(provider=${result.provider})，共 ${result.transcript.length} 段`);
      console.log('[VideoAnalyzer] 转录内容预览:', transcript.substring(0, 500).replace(/\n/g, ' '));
      this.reportProgress(onProgress, 'speech', 58, '语音识别完成');
      return transcript;
    } catch (error) {
      console.error('[VideoAnalyzer] 语音识别失败:', error.response?.data || error.message);
      // 识别失败不拖垮整个分析：返回 null，继续使用画面分析
      this.reportProgress(onProgress, 'speech', 58, '语音识别失败，继续画面分析');
      return null;
    }
  }

  /**
   * 从音频中提取知识点
   * @param {string} transcript - 音频转录文本
   */
  async extractKnowledgePoints(transcript, userConfig = null) {
    if (!transcript) return null;

    console.log('[VideoAnalyzer] 提取知识点...');
    const modelConfig = this.getEffectiveModelConfig(userConfig);
    const client = this.createOpenAIClient(modelConfig);

    try {
      const response = await client.chat.completions.create({
        model: modelConfig.textModel,
        messages: [
          {
            role: 'user',
            content: `请从以下文本中提取重要的知识点、概念和术语，进行学霸提示和百科解读：

文本内容（可能包含[MM:SS]时间标记）：
${transcript}

请以JSON格式返回：
{
  "knowledge_points": [
    {
      "term": "术语/概念名称",
      "explanation": "详细解释说明",
      "type": "知识点类型（如：技术概念/历史知识/科学原理等）",
      "timestamp": "出现时间点(格式必须为MM:SS)。如果文本中有[MM:SS]标记，请直接使用该标记；否则请根据上下文推算。"
    }
  ]
}

提取3-8个最重要的知识点。请务必标注每个知识点在文本中大致出现的时间点（根据文本顺序或[MM:SS]标记推测）。`
          }
        ],
        max_tokens: 2000
      });

      if (response && response.choices && response.choices[0]) {
        const result = response.choices[0].message.content;
        // 尝试解析JSON
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const jsonStr = jsonMatch[1] || jsonMatch[0];
          return JSON.parse(jsonStr);
        }
      }
      return null;
    } catch (error) {
      console.error('[VideoAnalyzer] 知识点提取失败:', error.message);
      return null;
    }
  }

  /**
   * 识别热词和网络梗（仅提取转录文本中原有的词）
   * @param {string} transcript - 音频转录文本
   */
  async extractHotWords(transcript, userConfig = null) {
    if (!transcript) return null;

    console.log('[VideoAnalyzer] 识别热词和梗...');

    const modelConfig = this.getEffectiveModelConfig(userConfig);
    const client = this.createOpenAIClient(modelConfig);

    try {
      const response = await client.chat.completions.create({
        model: modelConfig.textModel,
        messages: [
          {
            role: 'user',
            content: `请从以下转录文本中提取网络热词、流行梗和饭圈用语。

**重要要求：只能提取转录文本中原有的词汇，不能自己编造或解释新的词！**

转录文本内容（格式：[MM:SS] 文本内容）：
${transcript}

请以JSON格式返回：
{
  "hot_words": [
    {
      "word": "从转录文本中直接提取的热词（必须是原文中出现的词）",
      "meaning": "简要解释这个词的含义",
      "explanation": "简要解释这个词的含义",
      "category": "分类（如：网络梗/流行语/饭圈用语等）",
      "timestamp": "出现时间点(格式必须为MM:SS)。必须直接使用转录文本中的[MM:SS]标记。"
    }
  ]
}

**注意**：
1. 只能提取转录文本中实际出现的词
2. 不要创造或添加文本中没有的词
3. 必须使用转录文本中的[MM:SS]时间戳
4. 如果某个词在转录文本中没有明确的时间戳，就不要提取它
5. 提取3-5个最热门的词`
          }
        ],
        max_tokens: 2000
      });

      if (response && response.choices && response.choices[0]) {
        const result = response.choices[0].message.content;
        // 尝试解析JSON
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const jsonStr = jsonMatch[1] || jsonMatch[0];
          return JSON.parse(jsonStr);
        }
      }
      return null;
    } catch (error) {
      console.error('[VideoAnalyzer] 热词识别失败:', error.message);
      return null;
    }
  }

  /**
   * 调用通义千问Qwen3-VL进行视频分析
   * @param {string} videoPath - 视频路径
   * @param {string} framesDir - 关键帧目录
   * @param {number} duration - 视频时长（秒）
   * @param {string} transcript - 音频转录文本（可选）
   */
  async analyzeWithQwen(videoPath, framesDir, duration, transcript = null, userConfig = null, onProgress = null, progressOptions = {}) {
    console.log('[VideoAnalyzer] 调用通义千问API进行视频分析...');
    const modelStartPercent = Number.isFinite(Number(progressOptions.modelStartPercent))
      ? Number(progressOptions.modelStartPercent)
      : 42;
    this.reportProgress(onProgress, 'model', modelStartPercent, '正在整理关键帧与分析上下文');
    const modelConfig = this.getEffectiveModelConfig(userConfig);
    const client = this.createOpenAIClient(modelConfig);

    // 获取所有帧图片，并从文件名中解析时间戳（毫秒）
    const frames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const match = f.match(/frame_\d+_(\d+)\.jpg$/);
        return {
          file: f,
          timestampMs: match ? parseInt(match[1], 10) : 0
        };
      })
      .sort((a, b) => a.timestampMs - b.timestampMs);

    if (frames.length === 0) {
      throw new Error('没有找到关键帧图片');
    }

    console.log(`[VideoAnalyzer] 共有 ${frames.length} 张关键帧`);
    this.reportProgress(onProgress, 'model', modelStartPercent + 2, `正在准备 ${frames.length} 张关键帧`);

    // 生成时间戳（秒）列表，供提示词使用
    const frameTimestamps = frames.map(f => f.timestampMs / 1000);
    const frameTimesText = frameTimestamps
      .slice(0, 10)
      .map(t => formatTime(t))
      .join(', ');
    const visualCuts = Array.isArray(progressOptions.visualCuts)
      ? progressOptions.visualCuts
      : [];
    const visualCutsText = visualCuts.length > 0
      ? visualCuts
        .slice(0, 20)
        .map(cut => {
          const reasons = Array.isArray(cut.reasons) ? cut.reasons.join('/') : 'visual_change';
          const score = Number.isFinite(Number(cut.score)) ? Number(cut.score).toFixed(2) : '0.00';
          return `- ${formatTime(Number(cut.time) || 0)} score=${score} method=${cut.method || 'visual'} reasons=${reasons}`;
        })
        .join('\n')
      : '无高置信视觉候选切点';

    // 构建提示词 - 结合音视频进行综合分析
    const promptText = `请作为一个资深B站用户和百科全书，对这段视频内容进行深度分析。

ASR语音转录内容（格式：[MM:SS] 文本内容）：
${transcript || '无语音内容'}

**注意**：上述转录文本中的 [MM:SS] 是精确的时间戳，例如 [0:15] 表示该内容在视频第15秒出现。

关键帧分析（仅用于分段和视觉理解）：
我已上传 ${frames.length} 张关键帧截图，按时间顺序排列。它们对应的视频时间点会根据场景/画面内容变化（不固定长度）。示例时间点（仅供参考）：${frameTimesText}。

视觉候选切点（由 SSIM / histogram diff / pHash / 峰值检测生成，仅作为候选边界，不是最终结论）：
${visualCutsText}

请输出JSON格式报告：
{
  "title": "视频标题（若未知可根据内容生成）",
  "tags": ["标签1", "标签2"],
  "summary": "300字以内的视频精彩总结，包含核心看点",
  "segments": [
    {
      "start_time": "MM:SS",
      "end_time": "MM:SS",
      "description": "该片段的核心内容概要",
      "highlight": true/false (是否高能片段)
    }
  ],
  "knowledge_points": [
    {
      "term": "知识点名称",
      "explanation": "通俗易懂的解释",
      "timestamp": "MM:SS (必须直接使用语音转录文本中的[MM:SS]标记，不允许推测)"
    }
  ],
  "hot_words": [
    {
      "word": "从转录文本中直接提取的热词（必须是原文中出现的词）",
      "explanation": "简要解释该热词或梗的含义",
      "timestamp": "MM:SS (必须直接使用语音转录文本中的[MM:SS]标记)"
    }
  ]
}

**重要要求**：
1. **热词必须严格从转录文本中提取，不能自己创造或解释新的词**。只提取文本中原有的词汇、短语或梗
2. **知识点和热词的timestamp必须直接使用ASR语音转录文本中的[MM:SS]标记**，不允许推测或根据关键帧推算
3. 如果某个知识点/热词在转录文本中没有对应的时间戳标记，就不要提取它
4. 只提取那些在转录文本中能明确找到时间戳的知识点和热词
5. 分段的start_time和end_time由关键帧画面分析决定
6. 知识点要硬核且有趣，适合B站用户口味
7. 只有真正有价值的内容才提取，不要凑数
8. 视觉候选切点可作为片段边界参考，但必须结合语义和转录内容判断，不要机械照搬`;

    // 构建多模态消息
    const content = [
      {
        type: 'text',
        text: promptText
      }
    ];

    // 添加图片（使用base64编码）
    for (const frame of frames) {
      const framePath = path.join(framesDir, frame.file);
      const imageBuffer = fs.readFileSync(framePath);
      const base64Image = imageBuffer.toString('base64');

      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Image}`
        }
      });
    }

    try {
      this.reportProgress(onProgress, 'model', modelStartPercent + 4, '大模型分析中');
      // 使用OpenAI兼容模式调用通义千问
      const completion = await client.chat.completions.create({
        model: modelConfig.visionModel,
        messages: [
          {
            role: 'user',
            content: content
          }
        ],
        max_tokens: 3000,
        timeout: 300000 // 5分钟超时
      });

      if (completion && completion.choices && completion.choices[0]) {
        const aiResponse = completion.choices[0].message.content;
        console.log('[VideoAnalyzer] AI分析完成');
        console.log('[VideoAnalyzer] AI完整返回内容:\n', aiResponse);
        this.reportProgress(onProgress, 'model', 96, '大模型分析完成');

        // 尝试解析JSON
        try {
          // 提取JSON部分（AI可能返回``json\n``）
          const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/) ||
                           aiResponse.match(/\{[\s\S]*\}/);

          if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);

            // 确保所有必需字段都存在
            const result = {
              title: parsed.title || '未知标题',
              tags: parsed.tags || [],
              summary: parsed.summary || '',
              segments: parsed.segments || [],
              knowledge_points: parsed.knowledge_points || [],
              hot_words: parsed.hot_words || [],
              visual_cuts: visualCuts,
              visual_cut_stats: progressOptions.visualCutStats || null,
              raw_response: aiResponse // 包含原始响应以便前端调试
            };

            console.log('[VideoAnalyzer] JSON解析成功');
            console.log('[VideoAnalyzer] - segments:', result.segments.length);
            console.log('[VideoAnalyzer] - knowledge_points:', result.knowledge_points.length);
            console.log('[VideoAnalyzer] - hot_words:', result.hot_words.length);

            // 打印知识点和热词的详细时间戳信息
            if (result.knowledge_points.length > 0) {
              console.log('[VideoAnalyzer] 知识点时间戳详情:');
              result.knowledge_points.forEach((kp, i) => {
                console.log(`  [${i+1}] "${kp.term}" -> timestamp: "${kp.timestamp}"`);
              });

              // 验证时间戳是否在转录文本中
              console.log('[VideoAnalyzer] 验证知识点时间戳...');
              const transcriptLines = (transcript || '').split('\n');
              result.knowledge_points.forEach((kp, i) => {
                const foundInTranscript = transcriptLines.some(line => line.includes(kp.timestamp));
                console.log(`  [${i+1}] "${kp.term}" (${kp.timestamp}) ${foundInTranscript ? '✓ 在转录文本中找到' : '✗ 未在转录文本中找到'}`);
              });
            }
            if (result.hot_words.length > 0) {
              console.log('[VideoAnalyzer] 热词时间戳详情:');
              result.hot_words.forEach((hw, i) => {
                console.log(`  [${i+1}] "${hw.word}" -> timestamp: "${hw.timestamp}"`);
              });

              // 验证时间戳是否在转录文本中
              console.log('[VideoAnalyzer] 验证热词时间戳...');
              const transcriptLinesHw = (transcript || '').split('\n');
              result.hot_words.forEach((hw, i) => {
                const foundInTranscript = transcriptLinesHw.some(line => line.includes(hw.timestamp));
                console.log(`  [${i+1}] "${hw.word}" (${hw.timestamp}) ${foundInTranscript ? '✓ 在转录文本中找到' : '✗ 未在转录文本中找到'}`);
              });
            }

            return result;
          }

          // 如果没有找到JSON，返回原始文本
          console.warn('[VideoAnalyzer] 未找到JSON格式，返回原始响应');
          return {
            title: '解析失败',
            tags: [],
            summary: aiResponse.substring(0, 200),
            segments: [],
            knowledge_points: [],
            hot_words: [],
            visual_cuts: visualCuts,
            visual_cut_stats: progressOptions.visualCutStats || null,
            raw_response: aiResponse,
            parse_error: '无法提取JSON格式的分析结果'
          };
        } catch (parseError) {
          console.error('[VideoAnalyzer] JSON解析失败:', parseError);
          return {
            title: '解析失败',
            tags: [],
            summary: aiResponse ? aiResponse.substring(0, 200) : '解析错误',
            segments: [],
            knowledge_points: [],
            hot_words: [],
            visual_cuts: visualCuts,
            visual_cut_stats: progressOptions.visualCutStats || null,
            raw_response: aiResponse,
            parse_error: parseError.message
          };
        }
      } else {
        throw new Error('API返回数据格式错误');
      }
    } catch (error) {
      console.error('[VideoAnalyzer] API调用失败:', error.response?.data || error.message);
      this.reportProgress(onProgress, 'model', 96, '大模型分析失败，使用降级结果继续');
      return buildFallbackAnalysisResult(
        `AI分析失败: ${error.message}`,
        transcript,
        visualCuts,
        progressOptions.visualCutStats || null
      );
    }
  }

  /**
   * 将提取的帧转存为向量DB
   */
  async storeFrameVectors(bvid, framesDir, onVectorProgress = null) {
    // 跳过图像向量提取，因为多模态API不稳定
    console.log('[VideoAnalyzer] 跳过图像向量提取（多模态API暂时禁用）');
    if (onVectorProgress) {
      onVectorProgress(100, 'completed', '图像向量提取已禁用');
    }
    return;
    
    /* 
    // 原始代码已注释
    if (!vectorDb.isReady()) {
      console.warn('[VideoAnalyzer] VectorDB 未初始化，跳过帧向量提取');
      if (onVectorProgress) onVectorProgress(100, 'error', 'VectorDB 未初始化，跳过帧向量提取');
      return;
    }
    const embeddingService = new EmbeddingService();
    if (!embeddingService.isReady()) {
      console.warn('[VideoAnalyzer] 未配置 DASHSCOPE_API_KEY，跳过帧向量提取');
      if (onVectorProgress) onVectorProgress(100, 'error', '未配置环境变量 DASHSCOPE_API_KEY，跳过语义搜索功能');
      return;
    }

    try {
      if (onVectorProgress) onVectorProgress(5, 'running', '正在读取视频帧...');
      const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      if (files.length === 0) {
        if (onVectorProgress) onVectorProgress(100, 'completed', '没有可以入库的帧');
        return;
      }

      console.log(`[VideoAnalyzer] 开始提取并存储 ${files.length} 个帧向量...`);
      const points = [];
      const total = files.length;

      for (let i = 0; i < total; i++) {
        const file = files[i];
        // 文件名格式 frame_001_12345.jpg，其中12345是毫秒
        const match = file.match(/_(\d+)\.jpg$/);
        if (!match) continue;
        const timestampMs = parseInt(match[1], 10);
        const timestampSec = timestampMs / 1000.0;
        const filePath = path.join(framesDir, file);

        try {
          const vector = await embeddingService.embedLocalImage(bvid, timestampMs, filePath);
          if (vector) {
            points.push({
              timestamp: timestampSec,
              vector: vector
            });
          }
        } catch (err) {
          console.error(`[VideoAnalyzer] embedLocalImage 失败: ${file}`, err.message);
        }

        const percent = 5 + Math.round(((i + 1) / total) * 90);
        if (onVectorProgress) onVectorProgress(percent, 'running', `正在调用百炼多模态模型向量化画面: ${i + 1}/${total} 帧...`);
      }

      if (points.length > 0) {
        if (onVectorProgress) onVectorProgress(96, 'running', '正在存入本地LanceDB向量数据库...');
        await vectorDb.upsertFramePoints(bvid, points);
      }
      
      if (onVectorProgress) onVectorProgress(100, 'completed', '多模态帧向量提取完毕！现在可以正常使用语义搜索了。');
    } catch (error) {
      console.error('[VideoAnalyzer] storeFrameVectors 失败:', error.message);
      if (onVectorProgress) onVectorProgress(100, 'error', `后台提取失败: ${error.message}`);
    }
    */
  }

  /**
   * 完整的视频分析流程（支持音视频结合分析）
   */
  async analyzeVideo(url, useAudio = true, userConfig = null, options = {}) {
    const onProgress = typeof options === 'function' ? options : options?.onProgress;
    const bilibiliCookies = options?.bilibiliCookies; // 接收前端传来的 cookies
    let bvid = null;
    let tempCookiesPath = null;
    
    try {
      // 1. 提取视频信息
      ({ bvid } = this.extractBilibiliInfo(url));
      console.log(`[VideoAnalyzer] 开始分析视频: ${bvid}`);
      this.reportProgress(onProgress, 'prepare', 2, '准备分析视频');

      // 2. 如果有 cookies，保存为临时文件，仅在下载阶段使用
      if (bilibiliCookies) {
        try {
          const tempDir = path.join(this.downloadDir, 'temp');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          tempCookiesPath = path.join(tempDir, `${bvid}_cookies.txt`);
          fs.writeFileSync(tempCookiesPath, bilibiliCookies, 'utf8');
          console.log('[VideoAnalyzer] 已启用临时 cookies 进行下载');
        } catch (error) {
          console.warn('[VideoAnalyzer] 保存 cookies 文件失败:', error.message);
          tempCookiesPath = null;
        }
      }

      // 3. 下载视频（传递 cookies 路径）- 使用混合策略
      const videoPath = await this.downloadVideoHybrid(bvid, url, onProgress, tempCookiesPath);

      // 4. 提取关键帧（用于视觉理解）
      const {
        framesDir,
        duration: probedDuration,
        durationSource: probedDurationSource,
        keyframeTimestamps
      } = await this.extractFrames(videoPath, bvid, onProgress);

      // 时长探测三级全失败时，用最大关键帧时间戳兜底：能走到这里说明关键帧可用（< 2 个会直接抛错），
      // 这个值至少是时长的下界。若一路传 null，segmentValidator 会判 duration_missing_or_zero 并清空
      // final_segments，前端拿到的东西和"分析失败"无法区分，而这段视频其实是有可用信息的。
      // 来源必须如实标注，绝不冒充 probe：推导值只是下界，不是真实时长。
      let duration = probedDuration;
      let durationSource = probedDurationSource;
      const probedDurationOk = Number.isFinite(Number(probedDuration)) && Number(probedDuration) > 0;
      const lastKeyframeTime = Array.isArray(keyframeTimestamps) && keyframeTimestamps.length > 0
        ? keyframeTimestamps.reduce((max, time) => (time > max ? time : max), 0)
        : null;
      if (!probedDurationOk && Number.isFinite(lastKeyframeTime) && lastKeyframeTime > 0) {
        duration = lastKeyframeTime;
        durationSource = 'derived_from_keyframes';
        console.warn(`[VideoAnalyzer] 时长探测失败，改用最大关键帧时间戳 ${lastKeyframeTime} 秒作为下界（durationSource=derived_from_keyframes）`);
      }

      // 后台异步执行向量提取
      this.storeFrameVectors(bvid, framesDir, options?.onVectorProgress).catch(err => {
        console.error('[VideoAnalyzer] 后台提取向量失败:', err);
      });

      // 5. 视觉候选切点检测（确定性信号，供分段参考）
      let visualCuts = [];
      let visualCutStats = null;
      try {
        const visualProbe = await this.extractVisualProbeFrames(
          videoPath,
          bvid,
          duration,
          onProgress,
          { ...(options?.visualProbe || {}), durationSource }
        );
        const visualResult = await analyzeVisualCuts(visualProbe.frames, {
          ...(options?.visualCuts || {}),
          probe: visualProbe.meta
        });
        visualCuts = visualResult.visualCuts || [];
        visualCutStats = {
          ...(visualResult.stats || {}),
          durationSource,
          probe: visualProbe.meta
        };
        console.log(`[VideoAnalyzer] 视觉候选切点检测完成: ${visualCuts.length} 个 (method=${visualCutStats?.method || 'unknown'})`);
        this.reportProgress(onProgress, 'visual', 42, `检测到 ${visualCuts.length} 个视觉候选切点`);
      } catch (error) {
        console.warn('[VideoAnalyzer] Python视觉候选切点检测失败，尝试 ffmpeg scene fallback:', error.message);
        try {
          const fallbackVisualResult = await analyzeSceneCutsWithFfmpeg(videoPath, {
            ...(options?.visualCuts || {}),
            timeoutMs: this.resolveTimeoutMs(duration, MEDIA_TIMEOUT_POLICIES.scene)
          });
          visualCuts = fallbackVisualResult.visualCuts || [];
          visualCutStats = {
            ...(fallbackVisualResult.stats || {}),
            // 回退路径产出的是另一类切点，必须一眼可辨
            method: 'ffmpeg_scene',
            fallbackFrom: 'python_visual_metrics',
            fallbackReason: error.message,
            durationSource
          };
          console.log(`[VideoAnalyzer] ffmpeg视觉候选切点检测完成: ${visualCuts.length} 个 (method=ffmpeg_scene)`);
          this.reportProgress(onProgress, 'visual', 42, `检测到 ${visualCuts.length} 个视觉候选切点`);
        } catch (fallbackError) {
          console.warn('[VideoAnalyzer] 视觉候选切点检测失败，继续后续分析:', fallbackError.message);
          visualCutStats = {
            method: 'unavailable',
            fallbackFrom: 'python_visual_metrics',
            fallbackReason: error.message,
            fallbackError: fallbackError.message,
            durationSource
          };
          this.reportProgress(onProgress, 'visual', 42, '视觉切点检测失败，继续分析');
        }
      }

      // 6. 提取音频并进行语音识别（可选）
      let transcript = null;
      let audioPath = null;
      const shouldAnalyzeAudio = Boolean(useAudio);
      // 音频支路本身不依赖 OSS：DashScope 上传不可用时还有本地 Whisper 和本地音频切点兜底，
      // 这里显式告警，避免降级原因只有结果里音频空空、日志里却查不到。
      if (useAudio && !hasOssConfig) {
        console.warn('[VideoAnalyzer] 未配置 OSS（OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET/OSS_BUCKET），DashScope 上传路径不可用，将依赖本地 Whisper 与本地音频切点');
      }

      if (shouldAnalyzeAudio) {
        try {
          audioPath = await this.extractAudio(videoPath, bvid, onProgress, { duration });
          transcript = await this.transcribeAudio(audioPath, bvid, userConfig, onProgress);
        } catch (error) {
          audioPath = null;
          console.warn('[VideoAnalyzer] 音频处理失败，继续使用画面分析:', error.message);
          this.reportProgress(onProgress, 'speech', 58, '音频处理失败，继续画面分析');
        }
      } else {
        this.reportProgress(onProgress, 'model', 42, '跳过音频，准备大模型分析');
      }

      let keywordCuts = [];
      let audioCuts = [];
      if (transcript) {
        try {
          keywordCuts = keywordCutService.mergeNearbyDetections(
            keywordCutService.detectKeywordCuts(transcript),
            5
          );
          console.log(`[VideoAnalyzer] 关键词候选切点检测完成: ${keywordCuts.length} 个`);
        } catch (error) {
          console.warn('[VideoAnalyzer] 关键词切点检测失败，继续分析:', error.message);
        }
      }

      // 6.5 音频切点检测（静音 + 音量变化）
      // 必须用 extractAudio 的返回值：它可能是历史遗留的 .mp3，硬拼 {bvid}.wav 会让老缓存视频永远拿不到音频切点
      if (shouldAnalyzeAudio) {
        if (audioPath && fs.existsSync(audioPath)) {
          try {
            audioCuts = await detectAudioCuts(audioPath);
            console.log(`[VideoAnalyzer] 音频切点检测完成: ${audioCuts.length} 个`);
          } catch (error) {
            console.warn('[VideoAnalyzer] 音频切点检测失败，继续分析:', error.message);
            this.reportProgress(onProgress, 'audio', 58, '音频切点检测失败，继续分析');
          }
        } else {
          console.warn(`[VideoAnalyzer] 没有可用的音频文件，跳过音频切点检测（audioCuts 为空）: ${audioPath || '未获取到音频'}`);
          this.reportProgress(onProgress, 'audio', 58, '音频不可用，跳过音频切点检测');
        }
      }

      // 7. AI分析（基于关键帧、时长、视觉切点和音频转录），知识点和热词从分析结果中获取
      const analysisResult = await this.analyzeWithQwen(videoPath, framesDir, duration, transcript, userConfig, onProgress, {
        modelStartPercent: shouldAnalyzeAudio ? 60 : 42,
        visualCuts,
        visualCutStats
      });

      // 8. 整合所有分析结果
      this.reportProgress(onProgress, 'finalize', 98, '正在整理分析结果');
      let segmentPipeline = null;
      try {
        const frameTimes = fs.readdirSync(framesDir)
          .filter(file => file.endsWith('.jpg'))
          .map(file => {
            const match = file.match(/frame_\d+_(\d+)\.jpg$/);
            return match ? Number(match[1]) / 1000 : null;
          })
          .filter(time => Number.isFinite(time));
        const modelConfig = this.getEffectiveModelConfig(userConfig);
        segmentPipeline = await runSegmentPipeline({
          videoId: bvid,
          bvid,
          duration,
          frameTimes,
          transcript,
          visualCuts,
          audioCuts,
          keywordCuts,
          existingAnalysis: analysisResult,
          modelConfig
        }, {
          modelClient: this.createOpenAIClient(modelConfig)
        });
        console.log(`[VideoAnalyzer] 分段主流程完成: ${segmentPipeline.segments.length} 个最终片段`);
      } catch (error) {
        console.warn('[VideoAnalyzer] 分段主流程运行失败，保留原分析结果:', error.message);
      }

      const finalResult = {
        ...analysisResult,
        // 时长与来源：duration 为 null 表示探测全失败且没有关键帧可推导（不再兜底 300 秒）；
        // derived_from_keyframes 表示这是由最大关键帧时间戳推出来的下界，不是探测到的真实时长
        duration,
        duration_source: durationSource,
        // 添加音频转录文本（如果有）
        transcript: transcript,
        keyword_cuts: keywordCuts,
        visual_cuts: visualCuts,
        visual_cut_stats: visualCutStats,
        candidateCuts: segmentPipeline?.candidateCuts || [],
        segmentPipeline,
        final_segments: segmentPipeline?.segments || []
      };

      // 9. 返回结果
      return {
        bvid,
        video_path: videoPath,
        analysis: finalResult,
        analyzed_at: new Date().toISOString()
      };
    } catch (error) {
      console.error('[VideoAnalyzer] 视频分析失败:', error);
      // 下载阶段的错误已经分类，这里补一条可操作的用户提示，并保留结构化字段
      if (isDownloadError(error)) {
        const wrapped = new Error(buildUserFacingMessage(error));
        wrapped.code = error.code;
        wrapped.reason = error.reason;
        wrapped.stage = error.stage;
        wrapped.retryable = error.retryable;
        wrapped.attempts = error.attempts;
        wrapped.userMessage = wrapped.message;
        wrapped.cause = error;
        console.error('[VideoAnalyzer] 下载失败分类:', JSON.stringify({
          code: error.code,
          reason: error.reason,
          stage: error.stage,
          attempts: error.attempts
        }));
        throw wrapped;
      }
      throw error;
    } finally {
      // 清理临时 cookies 文件（成功或失败都执行）
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        try {
          fs.unlinkSync(tempCookiesPath);
          console.log('[VideoAnalyzer] 临时 cookies 已清理');
        } catch (error) {
          console.warn('[VideoAnalyzer] 清理临时 cookies 文件失败:', error.message);
        }
      }
    }
  }

  /**
   * 清理某个 bvid 在磁盘上的全部产物（视频/音频/压缩副本/中间产物/两套帧目录/cookies/debug 产物）。
   *
   * 归属判据走 belongsToBvid，而不是 startsWith(bvid)：
   * 后者会让 cleanup('BV1aa') 连带删掉另一个视频的 'BV1aab.mp4'。
   * 清理失败只记日志不抛错——清理是收尾动作，不该把主流程带崩。
   *
   * @param {string} bvid
   * @param {{keepVideo?: boolean, keepDebug?: boolean}} [options]
   *   keepVideo=true 保留视频本体（重新下载代价最高），keepDebug=true 保留 debug 产物
   * @returns {{removed: string[], failed: string[], debugArtifacts: number}} 让调用方看得出删了什么
   */
  cleanup(bvid, options = {}) {
    const keepVideo = Boolean(options.keepVideo);
    const keepDebug = Boolean(options.keepDebug);
    const removed = [];
    const failed = [];

    const removeFile = (filePath) => {
      try {
        fs.unlinkSync(filePath);
        removed.push(filePath);
        console.log(`[VideoAnalyzer] 已删除文件: ${filePath}`);
      } catch (error) {
        failed.push(filePath);
        console.warn(`[VideoAnalyzer] 删除文件失败: ${filePath} — ${error.message}`);
      }
    };

    const removeDir = (dirPath) => {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        removed.push(dirPath);
        console.log(`[VideoAnalyzer] 已删除目录: ${dirPath}`);
      } catch (error) {
        failed.push(dirPath);
        console.warn(`[VideoAnalyzer] 删除目录失败: ${dirPath} — ${error.message}`);
      }
    };

    try {
      if (fs.existsSync(this.downloadDir)) {
        for (const entry of fs.readdirSync(this.downloadDir, { withFileTypes: true })) {
          // 目录单独处理（下面按后缀精确匹配），这里只收文件，避免把 _frames 当成文件去 unlink
          if (entry.isDirectory()) continue;
          if (!belongsToBvid(entry.name, bvid)) continue;
          if (keepVideo && entry.name === `${bvid}.mp4`) continue;
          removeFile(path.join(this.downloadDir, entry.name));
        }
      }

      // 关键帧（发大模型用，≤30 张）与视觉探针帧（含 manifest.json）两套目录
      for (const suffix of ['_frames', '_visual_frames']) {
        const dirPath = path.join(this.downloadDir, `${bvid}${suffix}`);
        if (fs.existsSync(dirPath)) removeDir(dirPath);
      }

      // 下载阶段用完即删的临时 cookies；进程被中断时 finally 没跑到，会残留在这里
      const cookiesPath = path.join(this.downloadDir, 'temp', `${bvid}_cookies.txt`);
      if (fs.existsSync(cookiesPath)) removeFile(cookiesPath);
    } catch (error) {
      console.error('[VideoAnalyzer] 清理文件失败:', error);
    }

    // debug 产物没有自动清理入口，只能靠这里显式清
    let debugArtifacts = 0;
    if (!keepDebug) {
      try {
        debugArtifacts = removeArtifactsFor(bvid);
        if (debugArtifacts > 0) {
          console.log(`[VideoAnalyzer] 已删除 ${debugArtifacts} 个 debug 产物: ${bvid}`);
        }
      } catch (error) {
        console.warn('[VideoAnalyzer] 清理 debug 产物失败:', error.message);
      }
    }

    return { removed, failed, debugArtifacts };
  }
}

module.exports = VideoAnalyzer;
// 纯函数与常量挂到导出上，便于单测直接引用（保持 `new (require('./videoAnalyzer'))()` 的旧用法）
module.exports.formatTime = formatTime;
module.exports.formatTranscriptSegments = formatTranscriptSegments;
module.exports.resolveMediaTimeoutMs = resolveMediaTimeoutMs;
module.exports.parseDurationValue = parseDurationValue;
module.exports.isMediaToolTimeout = isMediaToolTimeout;
module.exports.MediaToolTimeoutError = MediaToolTimeoutError;
module.exports.MEDIA_TIMEOUT_POLICIES = MEDIA_TIMEOUT_POLICIES;
module.exports.MIN_AUDIO_BYTES = MIN_AUDIO_BYTES;
// yt-dlp 停滞看门狗相关常量，供运维调参与单测断言
module.exports.YT_DLP_STALL_TIMEOUT_MS = YT_DLP_STALL_TIMEOUT_MS;
module.exports.YT_DLP_SOCKET_TIMEOUT_SECONDS = YT_DLP_SOCKET_TIMEOUT_SECONDS;
