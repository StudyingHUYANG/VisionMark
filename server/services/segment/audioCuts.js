/**
 * 音频切点检测服务
 * 通过 FFmpeg 检测音频中的静音段和音量突变点
 * 
 * 输入: audioPath (WAV文件路径)
 * 输出: audioCuts[] = [{ time, score, reasons }]
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { killProcessTree } = require('../../utils/killProcessTree');
const { toPositiveNumber } = require('../../utils/numberUtils');

// 不能再用 util.promisify(exec)：promisify 后的调用拿不到子进程句柄，
// 超时时无法杀进程树，挂死的 ffmpeg 会一直留在机器上。
const defaultExec = exec;
const TAG = '[AudioCuts]';

// ============ 配置常量 ============

/** 静音检测：噪声门限 (dB) */
const SILENCE_NOISE_DB = -30;
/** 静音检测：最短静音时长 (秒) */
const SILENCE_MIN_DURATION = 0.5;
/** 音量检测：时间窗口 (秒) */
const VOLUME_WINDOW_SEC = 1.0;
/** 音量检测：RMS 差值阈值 (dB) - 相邻窗口差值超过此值标记为切点 */
const VOLUME_CHANGE_THRESHOLD_DB = 8;
/** 去重：两个切点间最小间隔 (秒) */
const MIN_CUT_INTERVAL = 2.0;

// ============ 子命令超时 ============

/**
 * 超时策略，风格对齐 videoAnalyzer.js 的 MEDIA_TIMEOUT_POLICIES：
 * minMs 是兜底下限（时长未知/短片时用），perSecondMs 让超时随时长缩放。
 * 这里整片解码的命令（silencedetect / astats）不带超时会永久挂死，
 * 进而卡死调用方 VideoAnalyzer.analyzeVideo，所以必须有下限兜底。
 */
const AUDIO_CUTS_TIMEOUT_POLICIES = Object.freeze({
  /** 整片解码（silencedetect）：最坏要读完整个文件；当前拿不到时长，实际总走 120s 下限 */
  decode: Object.freeze({ minMs: 120000, perSecondMs: 500 }),
  /** 时长探测本身：探测对象就是时长，只能用固定下限 */
  probe: Object.freeze({ minMs: 120000, perSecondMs: 0 }),
  /**
   * astats 窗口统计：带 metadata=1 时 ffmpeg 要逐帧聚合统计量，比纯解码明显更重，
   * 系数从 500ms/秒放大到 800ms/秒，避免长音频在慢机器上被误判为超时。
   */
  astats: Object.freeze({ minMs: 120000, perSecondMs: 800 }),
  /** 备选方案的单窗口 volumedetect：每条命令只解一个窗口切片，按切片时长缩放即可 */
  window: Object.freeze({ minMs: 120000, perSecondMs: 500 })
});

/**
 * 按时长解析超时（毫秒），与 videoAnalyzer.resolveMediaTimeoutMs 同风格：
 * 时长有效时按 perSecondMs 缩放，否则退回 minMs 下限。下限恒为 120s 起。
 * @param {number} durationSeconds
 * @param {{minMs:number, perSecondMs:number}} policy
 */
function resolveAudioCutsTimeoutMs(durationSeconds, policy) {
  const minMs = Number.isFinite(Number(policy?.minMs)) ? Math.max(1, Math.round(Number(policy.minMs))) : 120000;
  const perSecondMs = Number.isFinite(Number(policy?.perSecondMs)) ? Number(policy.perSecondMs) : 0;
  const duration = Number(durationSeconds);
  const scaled = Number.isFinite(duration) && duration > 0 ? duration * perSecondMs : 0;
  return Math.max(minMs, Math.round(scaled));
}

/**
 * 把超时覆盖值归一化成正毫秒数；null/undefined/'' 或非正数都视为"未提供"。
 * 复用公共的 toPositiveNumber，避免这条链路上出现第二份实现：它专门挡 Number(null) === 0
 * 这个坑——否则"没传 timeoutMs"会被误判成 0ms（取整后 1ms），所有命令都在 1ms 内被误杀。
 */
function normalizeTimeoutMs(value) {
  const num = toPositiveNumber(value);
  return num === null ? null : Math.max(1, Math.round(num));
}

/**
 * 解析单条子命令的超时：ctx.timeoutMs 存在时优先（单测用来注入极短超时，
 * 正常调用不传），否则按时长策略解析。
 */
function resolveCommandTimeoutMs(ctx, durationSeconds, policy) {
  const override = normalizeTimeoutMs(ctx?.timeoutMs);
  if (override !== null) return override;
  return resolveAudioCutsTimeoutMs(durationSeconds, policy);
}

/** 子命令超时错误：带 label 与 timeoutMs，便于日志区分是哪一步挂住了 */
class AudioCutsTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} 执行超时(${timeoutMs}ms)`);
    this.name = 'AudioCutsTimeoutError';
    this.code = 'AUDIO_CUTS_TIMEOUT';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

function isAudioCutsTimeout(error) {
  return error instanceof AudioCutsTimeoutError || error?.code === 'AUDIO_CUTS_TIMEOUT';
}

/**
 * 执行子命令并强制超时：
 * - 直接调用 exec 拿 ChildProcess 句柄（promisify 拿不到，超时没法杀进程树）
 * - 超时后 killProcessTree(child) 杀掉整棵树，reject AUDIO_CUTS_TIMEOUT（带 label/timeoutMs）
 * - 回调正常返回/报错时清掉定时器，保证只 settle 一次
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.label='ffmpeg'] - 用途标签，超时错误与日志里透出
 * @param {number} [options.timeoutMs] - 超时毫秒数；不传按 decode 下限兜底
 * @param {number} [options.maxBuffer] - exec 输出缓冲上限
 * @param {Function} [options.execImpl] - 注入的 exec 实现（默认 child_process.exec）
 */
function execWithTimeout(command, {
  label = 'ffmpeg',
  timeoutMs = null,
  maxBuffer = 8 * 1024 * 1024,
  execImpl = defaultExec
} = {}) {
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs) ?? AUDIO_CUTS_TIMEOUT_POLICIES.decode.minMs;

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
      child = execImpl(command, { shell: true, windowsHide: true, maxBuffer }, (error, stdout, stderr) => {
        if (error) {
          if (timedOut) {
            // 进程被杀后回调仍可能触发；统一按超时错误上报，避免把 kill 的副作用当成真实执行失败
            finish(reject, new AudioCutsTimeoutError(label, effectiveTimeoutMs));
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
      // 进程被杀后回调不一定触发（Windows 上尤其如此），这里直接兜底 settle
      finish(reject, new AudioCutsTimeoutError(label, effectiveTimeoutMs));
    }, effectiveTimeoutMs);

    // 回调有可能在定时器注册前就同步返回，这种情况下别把定时器留在事件循环里
    if (settled) clearTimeout(timer);
  });
}

/**
 * 检测音频切点（静音 + 音量变化）
 * @param {string} audioPath - 音频文件路径
 * @param {object} [options={}]
 * @param {number} [options.silenceNoiseDb=-30] - 静音噪声门限
 * @param {number} [options.silenceMinDuration=0.5] - 最短静音时长
 * @param {number} [options.volumeWindowSec=1.0] - 音量分析窗口
 * @param {number} [options.volumeChangeThresholdDb=8] - 音量变化阈值
 * @param {Function} [options.execImpl] - 子进程执行实现（默认 child_process.exec，单测注入用）
 * @param {number} [options.timeoutMs] - 覆盖所有子命令的超时（毫秒）；不传则按时长策略解析
 * @returns {Promise<Array<{time: number, score: number, reasons: string[]}>>}
 */
async function detectAudioCuts(audioPath, options = {}) {
  const {
    silenceNoiseDb = SILENCE_NOISE_DB,
    silenceMinDuration = SILENCE_MIN_DURATION,
    volumeWindowSec = VOLUME_WINDOW_SEC,
    volumeChangeThresholdDb = VOLUME_CHANGE_THRESHOLD_DB,
    execImpl = defaultExec,
    timeoutMs = null
  } = options;

  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }

  console.log(`${TAG} 开始检测音频切点: ${audioPath}`);

  const ctx = { execImpl, timeoutMs };

  // 并行执行两种检测
  const [silenceCuts, volumeCuts] = await Promise.all([
    detectSilence(audioPath, silenceNoiseDb, silenceMinDuration, ctx),
    detectVolumeChanges(audioPath, volumeWindowSec, volumeChangeThresholdDb, ctx)
  ]);

  console.log(`${TAG} 静音切点: ${silenceCuts.length} 个, 音量切点: ${volumeCuts.length} 个`);

  // 合并并去重
  const merged = mergeCuts(silenceCuts, volumeCuts);
  console.log(`${TAG} 合并去重后: ${merged.length} 个切点`);

  return merged;
}

/**
 * 静音检测 - 使用 FFmpeg silencedetect
 * 将静音结束时刻作为候选切点（静音结束 = 新内容开始）
 */
async function detectSilence(audioPath, noiseDb, minDuration, ctx = {}) {
  const command = `"${ffmpegPath}" -i "${audioPath}" -af silencedetect=noise=${noiseDb}dB:d=${minDuration} -f null -`;

  try {
    const { stderr } = await execWithTimeout(command, {
      label: 'silencedetect',
      // 此处还没探测到音频时长（再跑一遍 ffmpeg 探测等于整片解码两次），按策略退回 120s 下限
      timeoutMs: resolveCommandTimeoutMs(ctx, undefined, AUDIO_CUTS_TIMEOUT_POLICIES.decode),
      maxBuffer: 10 * 1024 * 1024,
      execImpl: ctx.execImpl
    });

    const cuts = [];
    // 解析 silencedetect 输出
    // 格式: [silencedetect @ ...] silence_end: 5.234 | silence_duration: 0.8
    const regex = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
    let match;

    while ((match = regex.exec(stderr)) !== null) {
      const silenceEnd = parseFloat(match[1]);
      const silenceDuration = parseFloat(match[2]);

      // 评分：静音时长越长，分数越高（0.5 - 0.8）
      const score = Math.min(0.8, 0.5 + (silenceDuration - minDuration) * 0.1);

      cuts.push({
        time: Math.round(silenceEnd * 100) / 100,
        score: Math.round(score * 100) / 100,
        reasons: ['silence'],
        _silenceDuration: silenceDuration
      });
    }

    return cuts;
  } catch (error) {
    // 超时不能静默吞掉：否则调用方看到的是"检测成功但 0 个切点"，无从知道 ffmpeg 挂过
    if (isAudioCutsTimeout(error)) {
      console.warn(`${TAG} silencedetect 超时（label=${error.label}, timeoutMs=${error.timeoutMs}）: ${audioPath}`);
      return [];
    }
    console.error(`${TAG} 静音检测失败:`, error.message);
    return [];
  }
}

/**
 * 音量变化检测 - 使用 FFmpeg astats 按窗口计算 RMS
 * 相邻窗口 RMS 差值超过阈值则标记为切点
 */
async function detectVolumeChanges(audioPath, windowSec, thresholdDb, ctx = {}) {
  // 使用 ffprobe 获取音频时长
  const duration = await getAudioDuration(audioPath, ctx);
  if (!duration || duration <= 0) {
    console.warn(`${TAG} 无法获取音频时长`);
    return [];
  }

  // 使用 FFmpeg 按固定窗口计算每段 RMS 值
  // 通过 loudnorm 的 measured_I 或使用 astats 的 RMS_level
  const rmsValues = await computeRmsPerWindow(audioPath, windowSec, duration, ctx);

  if (rmsValues.length < 2) {
    return [];
  }

  const cuts = [];

  for (let i = 1; i < rmsValues.length; i++) {
    const diff = Math.abs(rmsValues[i] - rmsValues[i - 1]);

    if (diff >= thresholdDb) {
      const time = i * windowSec;
      // 评分：基于差值归一化到 0.3-0.9
      const score = Math.min(0.9, 0.3 + (diff - thresholdDb) / 20 * 0.6);

      cuts.push({
        time: Math.round(time * 100) / 100,
        score: Math.round(score * 100) / 100,
        reasons: ['volume_change'],
        _rmsDiff: Math.round(diff * 100) / 100
      });
    }
  }

  return cuts;
}

/**
 * 获取音频时长 (秒) - 使用 ffmpeg 解析
 */
async function getAudioDuration(audioPath, ctx = {}) {
  // 方案 1：用 ffmpeg -i 获取 duration
  const command = `"${ffmpegPath}" -i "${audioPath}" -f null - 2>&1`;
  try {
    const result = await execWithTimeout(command, {
      label: 'audio-duration',
      // 探测的正是时长本身，拿不到时长只能按固定下限
      timeoutMs: resolveCommandTimeoutMs(ctx, undefined, AUDIO_CUTS_TIMEOUT_POLICIES.probe),
      execImpl: ctx.execImpl
    }).catch(e => {
      // 非超时的 exec 报错：ffmpeg 常把 Duration 打在 stderr 上却以非 0 退出，仍尝试解析（保持原有行为）
      if (isAudioCutsTimeout(e)) throw e;
      return {
        stdout: e.stdout || '',
        stderr: e.stderr || e.message || ''
      };
    });
    const output = result.stderr || result.stdout || '';
    // 解析 Duration: 00:01:23.45
    const match = output.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (match) {
      return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
    }
  } catch (error) {
    // 超时留痕：探测卡住时下面还有 WAV 头兜底，但必须让日志知道发生过超时
    if (isAudioCutsTimeout(error)) {
      console.warn(`${TAG} 时长探测超时，改用 WAV 头估算（label=${error.label}, timeoutMs=${error.timeoutMs}）: ${audioPath}`);
    }
  }

  // 方案 2：用 WAV 文件头计算（仅限 PCM WAV）
  try {
    const stats = fs.statSync(audioPath);
    // WAV PCM 16-bit mono 16kHz: 每秒 32000 字节
    const headerSize = 44; // 标准 WAV 头
    const bytesPerSecond = 16000 * 2 * 1; // sampleRate * bytesPerSample * channels
    const dataSize = stats.size - headerSize;
    if (dataSize > 0) {
      return dataSize / bytesPerSecond;
    }
  } catch (_) {}

  return 0;
}

/**
 * 按窗口计算 RMS 能量 (dB)
 * 使用 FFmpeg astats 滤镜 + segment 实现分段统计
 */
async function computeRmsPerWindow(audioPath, windowSec, totalDuration, ctx = {}) {
  // 使用 volume filter 输出每帧的 RMS，然后按窗口聚合
  // 更可靠的方案：使用 afade 分段 + astats
  // 实际采用：使用 ebur128 或简单的分段 volumedetect

  // 方案：通过 lavfi astats 的 reset 参数按帧统计，然后聚合
  const framesPerWindow = Math.ceil(windowSec * 100); // 假设100fps的统计率
  const command = `"${ffmpegPath}" -i "${audioPath}" -af astats=metadata=1:reset=${framesPerWindow} -f null - 2>&1`;

  let output = '';
  let failure = null;
  try {
    const result = await execWithTimeout(command, {
      label: 'astats-window',
      timeoutMs: resolveCommandTimeoutMs(ctx, totalDuration, AUDIO_CUTS_TIMEOUT_POLICIES.astats),
      maxBuffer: 50 * 1024 * 1024,
      execImpl: ctx.execImpl
    });
    output = result.stderr || result.stdout || '';
  } catch (error) {
    if (isAudioCutsTimeout(error)) {
      // astats 超时说明 ffmpeg 已经在整片解码上挂住；此时再启动最多 600 条备选命令
      // 只会把卡死放大，所以直接放弃本轮音量检测（返回空数组，交调用方继续）
      console.warn(`${TAG} astats 窗口计算超时，跳过备选方案（label=${error.label}, timeoutMs=${error.timeoutMs}）: ${audioPath}`);
      return [];
    }
    failure = error;
    output = error.stderr || error.stdout || '';
  }

  const allRms = parseAstatsRms(output);
  if (allRms.length > 0) {
    // astats reset 已经按窗口输出，直接使用最后一帧的值作为窗口RMS
    // 每个 reset 周期输出一次统计，取每个周期最后的值
    return allRms;
  }

  if (failure) {
    console.warn(`${TAG} astats 计算失败，使用备选方案:`, failure.message);
  }
  // 备选方案：如果 astats 无输出，使用简单的分段 volumedetect
  return await computeRmsFallback(audioPath, windowSec, totalDuration, ctx);
}

/** 解析 astats 输出的 lavfi.astats.Overall.RMS_level 序列（成功/失败两条路径共用） */
function parseAstatsRms(output) {
  const rmsRegex = /lavfi\.astats\.Overall\.RMS_level=([-\d.]+)/g;
  const allRms = [];
  let m;
  while ((m = rmsRegex.exec(output)) !== null) {
    const val = parseFloat(m[1]);
    if (isFinite(val)) {
      allRms.push(val);
    }
  }
  return allRms;
}

/**
 * 备选 RMS 计算方案：逐段提取并使用 volumedetect
 */
async function computeRmsFallback(audioPath, windowSec, totalDuration, ctx = {}) {
  const windowCount = Math.ceil(totalDuration / windowSec);
  // 限制最大窗口数，避免执行太多命令
  const maxWindows = Math.min(windowCount, 600);
  const actualWindowSec = totalDuration / maxWindows;

  const rmsValues = [];

  // 批量执行，每次处理一段
  for (let i = 0; i < maxWindows; i++) {
    const startTime = i * actualWindowSec;
    const command = `"${ffmpegPath}" -ss ${startTime} -t ${actualWindowSec} -i "${audioPath}" -af volumedetect -f null - 2>&1`;

    try {
      const result = await execWithTimeout(command, {
        label: 'astats-summary',
        // 每条命令只解一个窗口切片，按切片时长缩放超时即可；下限仍由策略兜底
        timeoutMs: resolveCommandTimeoutMs(ctx, actualWindowSec, AUDIO_CUTS_TIMEOUT_POLICIES.window),
        maxBuffer: 1024 * 1024,
        execImpl: ctx.execImpl
      });

      const output = result.stderr || result.stdout || '';
      const meanMatch = output.match(/mean_volume:\s*([-\d.]+)/);
      if (meanMatch) {
        rmsValues.push(parseFloat(meanMatch[1]));
      } else {
        rmsValues.push(-Infinity);
      }
    } catch (error) {
      if (isAudioCutsTimeout(error)) {
        // 一个窗口就超时说明 ffmpeg 在这份音频上已经不稳，继续跑最多 600 条命令
        // 只会把卡死放大；留痕后停止本方案，返回已有窗口（保持数组返回类型）
        console.warn(`${TAG} 音量窗口检测超时（label=${error.label}, timeoutMs=${error.timeoutMs}）: ${audioPath}`);
        rmsValues.push(-Infinity);
        break;
      }
      rmsValues.push(-Infinity);
    }
  }

  return rmsValues;
}

/**
 * 合并静音切点和音量切点，去重
 */
function mergeCuts(silenceCuts, volumeCuts) {
  // 合并所有切点
  const allCuts = [...silenceCuts, ...volumeCuts];

  // 按时间排序
  allCuts.sort((a, b) => a.time - b.time);

  // 去重：相距 MIN_CUT_INTERVAL 内的合并
  const merged = [];

  for (const cut of allCuts) {
    const last = merged[merged.length - 1];

    if (last && Math.abs(cut.time - last.time) < MIN_CUT_INTERVAL) {
      // 合并：取更高分，合并 reasons
      if (cut.score > last.score) {
        last.score = cut.score;
      }
      for (const reason of cut.reasons) {
        if (!last.reasons.includes(reason)) {
          last.reasons.push(reason);
        }
      }
    } else {
      // 新切点（去除内部调试字段）
      merged.push({
        time: cut.time,
        score: cut.score,
        reasons: [...cut.reasons]
      });
    }
  }

  return merged;
}

module.exports = {
  detectAudioCuts,
  // 以下仅供单测注入/断言使用，生产调用方只用 detectAudioCuts
  execWithTimeout,
  resolveAudioCutsTimeoutMs,
  AUDIO_CUTS_TIMEOUT_POLICIES,
  AudioCutsTimeoutError,
  isAudioCutsTimeout
};
