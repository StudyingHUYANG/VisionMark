#!/usr/bin/env node
'use strict';

/**
 * 媒体链路基线跑批 —— W1-ZHX-02 / W1-ZHX-03 的可重复验收入口。
 *
 * 用法：
 *   node server/scripts/baselineMediaPipeline.js                      # 跑清单里的全部启用项（默认离线）
 *   node server/scripts/baselineMediaPipeline.js --list <file.json>    # 换清单
 *   node server/scripts/baselineMediaPipeline.js --only v1,v2          # 只跑指定 id
 *   node server/scripts/baselineMediaPipeline.js --compare A.json B.json
 *   node server/scripts/baselineMediaPipeline.js --allow-network       # 显式打开真实出网（会调用真实付费接口！）
 *
 * 产出：
 *   server/debug/baseline/{YYYYMMDD-HHmmss}-baseline.json  （完整记录，供 --compare 用）
 *   stdout 上一份可直接贴进文档的 Markdown 摘要
 *   退出码：任一视频不变量不过、或整段流程报错 → 非 0
 *
 * 设计取舍（重要，别改错）：
 *
 * 1. 跑的是真实链路：真实 ffmpeg/ffprobe、真实 ASR（无 key 时走降级）、真实分段流水线。
 *    没有大模型 API key 也必须能跑完，降级原因从 segmentPipeline.debug.fallbackReason 与
 *    asr.degradations 里如实记录，不吞掉。
 *
 * 2. source=file 的项跳过下载：清单里给的是本地文件，重新下载一遍既没意义也不稳定。
 *    这是唯一被替换掉的步骤，其余全部真实执行。
 *
 * 3. 有些字段 analyzeVideo 的返回值里没有（抽帧失败数、ASR provider/degradations），
 *    脚本用"只读观测包装"拿：包装调用原实现、只记录返回值，不改入参也不改结果。
 *    包装也拿不到的字段一律写 null 并注明原因，绝不编造。
 *
 * 4. --compare 把差异分成两类（依据 docs/SEGMENT_PIPELINE_CONTRACT.md 第五节）：
 *    (a) 确定性项：duration、抽帧数、视觉帧数、visualCuts 时间序列、audioCuts 时间序列。
 *        这些来自 ffprobe / ffmpeg / python 视觉指标等纯计算环节，同一输入同一机器
 *        应当逐次一致；不一致就是真回归，必须列出来并让退出码非 0。
 *    (b) 允许抖动项：ASR 转录文本、语义合并后的片段边界与 segmentId。
 *        语义合并走大模型（当前无 key 时走本地 fallback，但边界仍可能随阈值与浮点漂移），
 *        契约第五节已声明边界不保证跨次复现、segmentId 随之变化。这类只报差异量级，不判失败。
 *    两类混在一起看，会把"模型抖动"误判成回归、或把真回归淹没在噪声里，所以必须分开。
 *
 * 5. 默认离线：启动时在进程内安装出网守卫（见下面「出网守卫」一节），阻断一切外部网络
 *    并把出网尝试计数写进摘要与 JSON。原因：服务层 modelConfigService.js 内置了一个
 *    DashScope 兜底 key，即使用户没配 key，analyzeVideo 与分段语义合并也会拿它真实外呼
 *    付费接口（不拦的话一次默认跑批就会发出请求）。要验证真实大模型/下载路径必须显式
 *    加 --allow-network（或环境变量 BASELINE_ALLOW_NETWORK=1），此时摘要会醒目提示。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_LIST_PATH = path.join(__dirname, 'baseline-videos.json');
const OUTPUT_DIR = path.join(REPO_ROOT, 'server', 'debug', 'baseline');
const DOWNLOAD_DIR = path.join(REPO_ROOT, 'downloads');

/**
 * 与 segmentValidator.js:20 的 COVERAGE_TOLERANCE_SECONDS 保持一致。
 * 该常量在服务层没有导出；基线脚本自身只读服务层、不做任何改动，所以在这里复制一份，
 * 改那边的时候记得同步这里。
 */
const COVERAGE_TOLERANCE_SECONDS = 1;
/** segmentContract.roundSeconds 用 toFixed(2)，端点上界允许一个舍入单位 */
const ROUNDING_EPSILON = 0.011;
/** 契约 confidence 的合法取值（segmentContract.CONFIDENCE_MAP） */
const CONTRACT_CONFIDENCE = [0.2, 0.5, 0.8];
const EVIDENCE_KEYS = ['visual', 'speech', 'keyword', 'cut'];

// ---------------------------------------------------------------------------
// 出网守卫（默认离线）
// ---------------------------------------------------------------------------

/**
 * 为什么需要它：modelConfigService.js:5 内置了一个 DashScope 兜底 key，baseUrl 指向真实端点。
 * 跑批即使用户没有配置任何 key，analyzeVideo 与分段语义合并也会拿这个内置 key 真实外呼付费接口
 * （实测默认清单一轮会发出 6 次请求）。基线跑批必须是"纯本地、可重复"的，不能让一条命令
 * 悄悄产生费用，所以默认在进程内阻断一切外部网络，并把出网尝试计数如实写进摘要与 JSON。
 *
 * 为什么拦 net / dns / fetch，而不只是包一层 http.request：
 * - axios / node-fetch（OpenAI SDK 走它）最终都会落到 net.Socket.connect；在 net 层拦是硬保证，
 *   且不依赖调用方用哪个 HTTP 客户端。
 * - undici（Node 18+ 全局 fetch）不走 http/https 模块，必须单独拦 fetch。
 * - dns 是域名解析入口，拦一道属于纵深防御，也是唯一能看到"解析了什么域名"的位置。
 *
 * 为什么不直接返回一个假的 request 对象：axios / node-fetch / OpenAI SDK 依赖 ClientRequest 的
 * 完整事件语义（.on('error'/'response')、.end()、setTimeout 等），手搓对象容易制造新的假象。
 * 让真实请求照常建立、在 net 层以连接错误失败，行为与"网络不可达"一致，服务层现成的降级路径
 * （analyzeWithQwen 的 catch、segmentPipeline 的 fallback）会照常触发。
 *
 * 局限：这里只管本进程。ffmpeg/ffprobe/python 不联网，不受影响；但 yt-dlp 下载是子进程发起的
 * 网络，进程内守卫管不到——所以离线模式下 source=bvid 的条目直接跳过，而不是装作能拦住。
 */
function detectAllowNetwork(argv = process.argv.slice(2), env = process.env) {
  return argv.includes('--allow-network') || env.BASELINE_ALLOW_NETWORK === '1';
}

/** 从 http.request / net.connect / fetch 的各种参数形态里尽力提取主机与端口（只用于展示） */
function extractNetworkTarget(args) {
  const first = args[0];
  const fromUrl = (raw) => {
    try {
      const parsed = new URL(raw);
      return { host: parsed.hostname || null, port: parsed.port || null };
    } catch (_) {
      return null;
    }
  };

  if (typeof first === 'string') {
    return fromUrl(first) || { host: first, port: null };
  }
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : null, port: first };
  }
  if (first && typeof first === 'object') {
    if (typeof first.url === 'string') {
      const parsed = fromUrl(first.url);
      if (parsed) return parsed;
    }
    return { host: first.hostname || first.host || null, port: first.port ?? null };
  }
  return { host: null, port: null };
}

function installNetworkGuard({ block }) {
  const http = require('http');
  const https = require('https');
  const net = require('net');
  const dns = require('dns');

  const MAX_SAMPLES = 50;
  const stats = {
    attempts: 0,            // 逻辑出网尝试（http/https.request 与全局 fetch 的调用次数）
    blockedConnections: 0,  // net 层拦下的 TCP 连接尝试次数
    blockedDnsLookups: 0,   // dns.lookup 被拦次数
    hosts: {},              // 主机 -> 尝试次数
    samples: [],            // 前 MAX_SAMPLES 条明细（layer/host/port/at）
    // 离线模式恒为 0；在线模式为 null——计数只覆盖进程内 http(s)/fetch，
    // 子进程（yt-dlp）与其它通道不在口径内，写 0 会误导。
    actualEgress: block ? 0 : null
  };

  const pushSample = (layer, host, port) => {
    if (stats.samples.length < MAX_SAMPLES) {
      stats.samples.push({ layer, host: host || null, port: port ?? null, at: new Date().toISOString() });
    }
  };
  // 逻辑出网尝试（http/https/fetch）才计入 hosts；net/dns 的拦截明细只进 samples，
  // 否则同一次请求会在 http 层与 net 层各记一次，hosts 计数翻倍、读起来失真。
  const noteAttempt = (layer, host, port) => {
    const key = host || '(未知主机)';
    stats.hosts[key] = (stats.hosts[key] || 0) + 1;
    pushSample(layer, host, port);
  };
  const noteBlocked = (layer, host, port) => pushSample(layer, host, port);

  const blockedError = (layer, host, port) => {
    const target = host ? `${host}${port ? `:${port}` : ''}` : '外部地址';
    const error = new Error(`[baseline-offline] 已阻断出网尝试（${layer} → ${target}）`);
    error.code = 'BASELINE_OFFLINE_BLOCKED';
    return error;
  };

  const restores = [];
  const patch = (target, key, replacement) => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => { target[key] = original; });
  };

  // (1) http(s).request：计数并透传原实现。真正的阻断在 net 层——
  //     返回假 request 会破坏 ClientRequest 的事件语义（见上方注释）。
  for (const [layer, mod] of [['https', https], ['http', http]]) {
    const originalRequest = mod.request;
    patch(mod, 'request', function guardedRequest(...args) {
      const target = extractNetworkTarget(args);
      stats.attempts += 1;
      noteAttempt(layer, target.host, target.port);
      return originalRequest.apply(this, args);
    });
  }

  // (2) 全局 fetch（undici）：它会绕过 http/https 模块，单独处理。
  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    patch(globalThis, 'fetch', function guardedFetch(input, init) {
      const target = extractNetworkTarget([input]);
      stats.attempts += 1;
      noteAttempt('fetch', target.host, target.port);
      if (block) return Promise.reject(blockedError('fetch', target.host, target.port));
      return originalFetch.call(this, input, init);
    });
  }

  if (!block) {
    return { stats, restore: () => restores.forEach(fn => fn()) };
  }

  // (3) net 层硬阻断：允许真实 ClientRequest 建出来，但任何 TCP 连接都失败。
  const blockSocket = (socket, host, port) => {
    stats.blockedConnections += 1;
    noteBlocked('net', host, port);
    // 先挂一个空 listener：即便调用方还没来得及挂 error 处理器，
    // 也不会因为无人监听 'error' 事件把整个跑批进程崩掉。
    socket.on('error', () => {});
    // 用 destroy(err) 而不是抛异常：调用方以 socket 的 'error'/'close' 事件为准，
    // 这样 axios / node-fetch / TLS 都表现为一次普通的连接失败。
    process.nextTick(() => {
      if (!socket.destroyed) socket.destroy(blockedError('net', host, port));
    });
  };

  const guardedModuleConnect = function (...args) {
    const target = extractNetworkTarget(args);
    const socket = new net.Socket();
    blockSocket(socket, target.host, target.port);
    return socket;
  };
  patch(net, 'connect', guardedModuleConnect);
  patch(net, 'createConnection', guardedModuleConnect);

  // 关键的一层：_http_agent / _https_agent 在模块加载时就把 net.createConnection / tls.connect
  // 抄到了自己的原型属性上，替换 net 模块的导出对它们无效；但原始函数内部终究会调用
  // socket.connect(...)，原型方法在调用时才解析，所以这里才是真正兜底的拦截点。
  patch(net.Socket.prototype, 'connect', function guardedSocketConnect(...args) {
    const target = extractNetworkTarget(args);
    blockSocket(this, target.host, target.port);
    return this;
  });

  // (4) dns.lookup：纵深防御，同时记录被解析的域名。
  patch(dns, 'lookup', function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    stats.blockedDnsLookups += 1;
    noteBlocked('dns', hostname, null);
    if (typeof cb === 'function') {
      process.nextTick(() => cb(blockedError('dns', hostname, null)));
    }
  });

  return { stats, restore: () => restores.forEach(fn => fn()) };
}

// 守卫必须在 require 服务层之前安装：这样连"模块加载时捕获 fetch/agent 引用"的情况也覆盖到。
const ALLOW_NETWORK = detectAllowNetwork();
const networkGuard = installNetworkGuard({ block: !ALLOW_NETWORK });

const VideoAnalyzer = require('../services/videoAnalyzer');
const asrService = require('../services/asr');
const { probeAudioDuration } = require('../services/asr/audioProbe');

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { list: DEFAULT_LIST_PATH, only: null, compare: null, allowNetwork: detectAllowNetwork(argv) };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--list') { args.list = argv[i + 1]; i += 1; }
    else if (token === '--only') { args.only = String(argv[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean); i += 1; }
    else if (token === '--compare') { args.compare = [argv[i + 1], argv[i + 2]]; i += 2; }
    else if (token === '--allow-network') { args.allowNetwork = true; }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** 失败不抛：探测类操作拿不到值就返回 fallback，由调用方记 null + 原因 */
function attempt(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

function fileSize(filePath) {
  if (!filePath) return null;
  return attempt(() => fs.statSync(filePath).size, null);
}

function round2(value) {
  return Number.isFinite(value) ? Number(Number(value).toFixed(2)) : null;
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 真 BV 号形态：BV + 10 位字母数字 */
const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;

/**
 * 兜底标识：必须一眼看得出不是 BV 号。
 * 为什么不能用 `BV{entryId}`：那个形态和真 BV 号长得一样，而代码里没有任何地方校验 bvid 格式，
 * 假 BV 会静默流进 segmentId、debug 产物，将来还可能被抄进文档或库里。
 */
function fallbackLocalId(entryId) {
  const cleaned = String(entryId || 'entry').trim().replace(/\s+/g, '-');
  return cleaned.startsWith('local-') ? cleaned : `local-${cleaned}`;
}

/**
 * source=file 的项没有真实 BV 号，按优先级解析：
 *   a. 清单项显式给的 bvid 字段；
 *   b. 文件名里的真 BV 号（样片 downloads/BV1TiuZ6TEQw.mp4 的文件名里正好有一个，别浪费）；
 *   c. local-<entryId> 兜底。
 * @returns {{bvid: string, bvidSource: 'explicit'|'filename'|'fallback'}}
 */
function resolveFileBvid(entry, localPath) {
  const explicit = typeof entry.bvid === 'string' ? entry.bvid.trim() : '';
  if (explicit) return { bvid: explicit, bvidSource: 'explicit' };

  const fileName = localPath ? path.basename(localPath) : '';
  const matched = fileName.match(BVID_PATTERN);
  if (matched) return { bvid: matched[0], bvidSource: 'filename' };

  return { bvid: fallbackLocalId(entry.id), bvidSource: 'fallback' };
}

// ---------------------------------------------------------------------------
// 观测包装：调用原实现，只记录返回值（不是 mock，不改变任何行为）
// ---------------------------------------------------------------------------

/** 记录每次 ASR 调用的 provider / degradations / 耗时；analyzeVideo 的返回值里没有这些 */
function observeAsrCalls(records) {
  const original = asrService.transcribe;
  asrService.transcribe = async (...args) => {
    const startedAt = Date.now();
    const result = await original(...args);
    records.push({ result, elapsedMs: Date.now() - startedAt });
    return result;
  };
  return () => { asrService.transcribe = original; };
}

/** 记录 extractFrames 的返回值；analyzeVideo 只解构了其中几个字段，失败帧数会丢 */
function observeMethod(target, methodName, records) {
  const original = target[methodName].bind(target);
  target[methodName] = async (...args) => {
    const result = await original(...args);
    records.push(result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// 不变量检查（W1-ZHX-03 的验收口径）
// ---------------------------------------------------------------------------

function checkSegmentInvariants(segments, duration) {
  const failures = [];
  const list = Array.isArray(segments) ? segments : [];
  const durationKnown = Number.isFinite(Number(duration)) && Number(duration) > 0;
  const seenIds = new Set();

  list.forEach((segment, index) => {
    const label = `#${index + 1} ${segment?.segmentId || '(无 segmentId)'}`;
    const fail = (rule, detail) => failures.push({ rule, segment: label, detail });

    const start = Number(segment?.startTime);
    const end = Number(segment?.endTime);

    // 1) 0 <= startTime < endTime <= duration（时长已知时）
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail('time_not_finite', `startTime=${segment?.startTime} endTime=${segment?.endTime}`);
    } else {
      if (start < 0) fail('start_before_zero', `startTime=${start}`);
      if (!(end > start)) fail('end_not_after_start', `start=${start} end=${end}`);
      if (durationKnown && end > Number(duration) + ROUNDING_EPSILON) {
        fail('end_beyond_duration', `end=${end} duration=${duration}`);
      }
    }

    // 2) title / description 非空
    if (!String(segment?.title || '').trim()) fail('title_empty', '');
    if (!String(segment?.description || '').trim()) fail('description_empty', '');

    // 3) evidence 四桶至少一个非空
    const evidence = segment?.evidence || {};
    const nonEmptyBuckets = EVIDENCE_KEYS.filter(key => Array.isArray(evidence[key]) && evidence[key].length > 0);
    if (nonEmptyBuckets.length === 0) {
      fail('evidence_all_empty', JSON.stringify(evidence).slice(0, 120));
    }

    // 4) segmentId 唯一 + 形状 {bvid}_{page}_{start}_{end}，起止两位小数
    const segmentId = String(segment?.segmentId || '');
    if (!/^[^_]+_\d+_\d+\.\d{2}_\d+\.\d{2}$/.test(segmentId)) {
      fail('segment_id_shape', `segmentId=${segmentId}`);
    }
    if (seenIds.has(segmentId)) fail('segment_id_duplicate', segmentId);
    seenIds.add(segmentId);
    if (segmentId && String(segment?.bvid) && !segmentId.startsWith(`${segment.bvid}_`)) {
      fail('segment_id_bvid_mismatch', `segmentId=${segmentId} bvid=${segment.bvid}`);
    }

    // 5) page / source 固定值
    if (segment?.page !== 1) fail('page_not_1', `page=${segment?.page}`);
    if (segment?.source !== 'segment_pipeline') fail('source_unexpected', `source=${segment?.source}`);

    // 6) previewTimestamp 落在区间内
    const preview = Number(segment?.previewTimestamp);
    if (!Number.isFinite(preview) || !Number.isFinite(start) || !Number.isFinite(end)) {
      fail('preview_not_finite', `previewTimestamp=${segment?.previewTimestamp}`);
    } else if (preview < start - ROUNDING_EPSILON || preview > end + ROUNDING_EPSILON) {
      fail('preview_out_of_range', `preview=${preview} 区间=[${start}, ${end}]`);
    }

    // 7) confidence 只能是契约映射的三个值
    if (!CONTRACT_CONFIDENCE.includes(Number(segment?.confidence))) {
      fail('confidence_unexpected', `confidence=${segment?.confidence}`);
    }
  });

  // 8) 相邻片段不重叠（允许 COVERAGE_TOLERANCE_SECONDS 容差），且按时间升序
  for (let i = 1; i < list.length; i += 1) {
    const previousEnd = Number(list[i - 1]?.endTime);
    const currentStart = Number(list[i]?.startTime);
    if (!Number.isFinite(previousEnd) || !Number.isFinite(currentStart)) continue;
    if (currentStart < previousEnd - COVERAGE_TOLERANCE_SECONDS) {
      failures.push({
        rule: 'adjacent_overlap',
        segment: `#${i + 1} ${list[i]?.segmentId || ''}`,
        detail: `start=${currentStart} < 前一段 end=${previousEnd} - 容差 ${COVERAGE_TOLERANCE_SECONDS}`
      });
    }
  }

  return { total: list.length, failures };
}

// ---------------------------------------------------------------------------
// 单个视频
// ---------------------------------------------------------------------------

async function runOne(entry) {
  const startedAt = Date.now();
  const isFile = entry.source === 'file';
  const localPath = isFile ? path.resolve(REPO_ROOT, entry.value) : null;
  // source=bvid 的项维持原行为：bvid 就是 value 里的 BV 号
  const resolved = isFile
    ? resolveFileBvid(entry, localPath)
    : { bvid: (String(entry.value).match(/BV[\w]+/i) || [null])[0], bvidSource: 'value' };
  const bvid = resolved.bvid;
  const record = {
    id: entry.id,
    source: entry.source,
    value: entry.value,
    note: entry.note || '',
    bvid,
    bvidSource: resolved.bvidSource,
    status: 'error',
    errors: [],
    stageTimings: [],
    elapsedMs: null
  };

  if (!bvid) {
    record.errors.push({ message: '无法从 value 中解析出 BV 号', value: entry.value });
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  if (isFile && !fs.existsSync(localPath)) {
    record.errors.push({ message: '本地文件不存在', path: localPath });
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  // 分析用 URL：source=file 时不走下载，这个 URL 只作为 analyzeVideo 的入参，
  // 让下游沿用同一个 bvid 派生命名（帧目录/音频/segmentId）；bvid 已按 resolveFileBvid 解析过
  const url = isFile ? `https://local.invalid/${bvid}` : String(entry.value);
  const videoPathGuess = path.join(DOWNLOAD_DIR, `${bvid}.mp4`);
  const cachedBeforeRun = fs.existsSync(videoPathGuess);

  const analyzer = new VideoAnalyzer(DOWNLOAD_DIR, null, {});
  const frameReturns = [];
  const visualProbeReturns = [];
  const asrCalls = [];
  let downloadElapsedMs = null;

  if (isFile) {
    // source=file：跳过下载，直接把本地文件交给后续步骤（清单明确要求，其余环节全部真实执行）
    analyzer.downloadVideoHybrid = async () => localPath;
  } else {
    const originalDownload = analyzer.downloadVideoHybrid.bind(analyzer);
    analyzer.downloadVideoHybrid = async (...args) => {
      const downloadStartedAt = Date.now();
      const result = await originalDownload(...args);
      downloadElapsedMs = Date.now() - downloadStartedAt;
      return result;
    };
  }
  observeMethod(analyzer, 'extractFrames', frameReturns);
  observeMethod(analyzer, 'extractVisualProbeFrames', visualProbeReturns);

  const stageTimeline = new Map();
  const onProgress = (progress) => {
    if (!progress || !progress.stage) return;
    const at = Date.now() - startedAt;
    const current = stageTimeline.get(progress.stage) || {
      stage: progress.stage, firstAtMs: at, lastAtMs: at, lastPercent: null, lastMessage: ''
    };
    current.lastAtMs = at;
    current.lastPercent = progress.percent;
    current.lastMessage = progress.message;
    stageTimeline.set(progress.stage, current);
  };

  const restoreAsr = observeAsrCalls(asrCalls);
  let result = null;
  try {
    result = await analyzer.analyzeVideo(url, true, null, { onProgress });
  } catch (error) {
    // 下载类错误带 code/reason/stage，尽量一起记下来
    record.errors.push({
      message: error?.message || String(error),
      code: error?.code ?? null,
      reason: error?.reason ?? null,
      stage: error?.stage ?? null
    });
  } finally {
    restoreAsr();
  }

  record.elapsedMs = Date.now() - startedAt;
  record.stageTimings = [...stageTimeline.values()];

  const analysis = result?.analysis || null;

  // --- download ---
  record.download = isFile
    ? {
      skipped: true,
      reason: 'source=file：按清单要求跳过下载，直接分析本地文件',
      localPath,
      sizeBytes: fileSize(localPath)
    }
    : {
      cachedBeforeRun,
      path: result?.video_path || null,
      sizeBytes: fileSize(result?.video_path || videoPathGuess),
      elapsedMs: downloadElapsedMs,
      note: cachedBeforeRun ? '运行前该文件已存在，可能命中缓存（analyzeVideo 不透出缓存命中标志）' : ''
    };

  if (!analysis) {
    record.status = 'error';
    return record;
  }

  // --- duration ---
  record.duration = {
    value: Number.isFinite(Number(analysis.duration)) ? Number(analysis.duration) : null,
    durationSource: analysis.duration_source ?? null
  };

  // --- frames（磁盘 + extractFrames 返回值）---
  const framesDir = path.join(DOWNLOAD_DIR, `${bvid}_frames`);
  const frameFiles = attempt(() => fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')), []) || [];
  const keyframeTimestamps = frameFiles
    .map(file => { const m = file.match(/_(\d+)\.jpg$/); return m ? Number(m[1]) / 1000 : null; })
    .filter(time => Number.isFinite(time))
    .sort((a, b) => a - b);
  const frameReturn = frameReturns[0] || null;
  record.frames = {
    count: frameReturn?.frameCount ?? frameFiles.length,
    countSource: frameReturn ? 'extractFrames 返回值' : '磁盘 frames 目录',
    failedCount: frameReturn?.failedFrameCount ?? null,
    failedCountReason: frameReturn ? '' : 'extractFrames 未返回（本轮未观测到返回值）',
    keyframeTimestampCount: frameReturn?.keyframeTimestamps?.length ?? keyframeTimestamps.length,
    keyframeTimestamps: keyframeTimestamps,
    duration: frameReturn?.duration ?? null,
    durationSource: frameReturn?.durationSource ?? null
  };

  // --- visualProbe ---
  // 优先用观测到的 meta：视觉检测回退到 ffmpeg scene 时 visual_cut_stats.probe 是缺的，
  // 但 extractVisualProbeFrames 本身跑成功了，它的 meta（含 frameCount / cached）才是真值
  const observedProbeMeta = visualProbeReturns[0]?.meta || null;
  const statsProbe = analysis.visual_cut_stats?.probe || null;
  const probe = observedProbeMeta || statsProbe;
  record.visualProbe = probe ? {
    frameCount: probe.frameCount ?? null,
    sampleFps: probe.sampleFps ?? null,
    scaleWidth: probe.scaleWidth ?? null,
    maxFrames: probe.maxFrames ?? null,
    effectiveFps: probe.effectiveFps ?? null,
    cached: probe.cached ?? null,
    durationSource: probe.durationSource ?? null,
    source: observedProbeMeta ? 'extractVisualProbeFrames 返回值（观测）' : 'analysis.visual_cut_stats.probe'
  } : {
    frameCount: null,
    reason: '既没有观测到 extractVisualProbeFrames 返回值，analysis.visual_cut_stats.probe 也缺失'
  };

  // --- visualCuts ---
  const visualCuts = Array.isArray(analysis.visual_cuts) ? analysis.visual_cuts : [];
  record.visualCuts = {
    count: visualCuts.length,
    method: analysis.visual_cut_stats?.method ?? null,
    durationSource: analysis.visual_cut_stats?.durationSource ?? null,
    fallbackFrom: analysis.visual_cut_stats?.fallbackFrom ?? null,
    fallbackReason: analysis.visual_cut_stats?.fallbackReason ?? null,
    times: visualCuts.map(cut => round2(cut?.time))
  };

  // --- audio ---
  const audioPath = attempt(() => {
    const wav = path.join(DOWNLOAD_DIR, `${bvid}.wav`);
    const mp3 = path.join(DOWNLOAD_DIR, `${bvid}.mp3`);
    if (fs.existsSync(wav)) return wav;
    if (fs.existsSync(mp3)) return mp3;
    return null;
  }, null);
  if (audioPath) {
    const audioProbe = attempt(() => probeAudioDuration(audioPath), null);
    // extractAudio 内部的缓存校验结论不透出；这里用同一个公开方法复检一次（async，必须 await）
    let postRunVerdict = null;
    try {
      postRunVerdict = await analyzer.validateAudioFile(audioPath, { videoDuration: record.duration.value });
    } catch (error) {
      postRunVerdict = { error: error?.message || String(error) };
    }
    record.audio = {
      path: audioPath,
      sizeBytes: fileSize(audioPath),
      duration: audioProbe?.duration ?? null,
      durationSource: audioProbe?.source ?? null,
      reusedLegacyMp3: path.extname(audioPath).toLowerCase() === '.mp3',
      postRunVerdict
    };
  } else {
    record.audio = { path: null, reason: '未找到 {bvid}.wav / {bvid}.mp3（音频提取失败或未执行）' };
  }

  // --- audioCuts / keywordCuts ---
  // audioCuts 不在 analyzeVideo 的返回值里，从分段流水线的 debug 产物里读（同一轮真实写下的记录）
  const debugPath = analysis.segmentPipeline?.debug?.artifactPaths?.[0] || null;
  const evidence = debugPath ? attempt(() => readJson(debugPath).evidence, null) : null;
  record.audioCuts = evidence?.audioCuts
    ? { count: evidence.audioCuts.length, times: evidence.audioCuts.map(cut => round2(cut?.time)) }
    : {
      count: null,
      times: null,
      reason: debugPath ? 'debug 产物里没有 evidence.audioCuts' : 'segmentPipeline 未产出 debug 产物'
    };
  const keywordCuts = Array.isArray(analysis.keyword_cuts) ? analysis.keyword_cuts : [];
  record.keywordCuts = { count: keywordCuts.length, times: keywordCuts.map(cut => round2(cut?.time)) };
  record.candidateCuts = {
    count: Array.isArray(analysis.candidateCuts) ? analysis.candidateCuts.length : 0,
    adoptedCount: Array.isArray(analysis.candidateCuts) ? analysis.candidateCuts.filter(cut => cut?.adopted).length : 0
  };

  // --- asr ---
  const asrCall = asrCalls[0] || null;
  record.asr = asrCall ? {
    provider: asrCall.result?.provider ?? null,
    segmentCount: Array.isArray(asrCall.result?.transcript) ? asrCall.result.transcript.length : 0,
    degradations: asrCall.result?.degradations || [],
    error: asrCall.result?.error || null,
    elapsedMs: asrCall.elapsedMs,
    transcriptText: typeof analysis.transcript === 'string' ? analysis.transcript : null
  } : {
    provider: null,
    reason: '本轮没有调用 ASR（音频不可用或未走到该步骤）'
  };

  // --- segmentPipeline ---
  record.segmentPipeline = analysis.segmentPipeline ? {
    mode: analysis.segmentPipeline.mode ?? null,
    confidence: analysis.segmentPipeline.confidence ?? null,
    usedAI: analysis.segmentPipeline.debug?.usedAI ?? null,
    fallbackReason: analysis.segmentPipeline.debug?.fallbackReason ?? null,
    artifactPath: debugPath,
    warnings: analysis.segmentPipeline.debug?.warnings || []
  } : { mode: null, reason: '分段主流程未产出结果（异常时 analyzeVideo 会保留原分析结果）' };

  // --- segments + 不变量 ---
  const segments = Array.isArray(analysis.final_segments) ? analysis.final_segments : [];
  const invariants = checkSegmentInvariants(segments, record.duration.value);
  record.segments = {
    count: segments.length,
    ids: segments.map(segment => segment?.segmentId ?? null),
    boundaries: segments.map(segment => [round2(segment?.startTime), round2(segment?.endTime)]),
    invariantFailures: invariants.failures
  };

  record.status = invariants.failures.length > 0 ? 'fail' : 'ok';
  return record;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function toMarkdown(baseline) {
  const lines = [];
  const coverage = baseline.coverage || { localFileItems: 0, downloadItems: 0, note: '' };
  lines.push('# 媒体链路基线摘要');
  lines.push('');
  lines.push(`- 运行时间: ${baseline.startedAt}`);
  lines.push(`- 清单: ${baseline.listPath}`);
  lines.push(`- 结论: ${baseline.summary.ok} 通过 / ${baseline.summary.fail} 不变量不过 / ${baseline.summary.error} 报错`);
  lines.push(`- 覆盖范围: 本地文件 ${coverage.localFileItems} 项 / 下载项 ${coverage.downloadItems} 项`);
  lines.push(`- ${coverage.note}`);
  lines.push('');

  // 出网与大模型："这次到底有没有外呼/花钱"是读报告的人第一个要确认的事，
  // 所以放在摘要最显眼的位置（表格之前），并且离线/在线两种模式措辞必须截然不同。
  const net = baseline.network || { mode: 'offline', egressAttempts: 0, actualEgress: 0, hosts: {} };
  lines.push('## 出网与大模型');
  lines.push('');
  if (net.mode === 'allow-network') {
    lines.push('- ⚠️ **--allow-network 已打开：本次会调用真实付费接口（DashScope 等），并可能触发真实下载**');
    lines.push(`- 进程内出网尝试计数: ${net.egressAttempts}（http/https/fetch；不含 yt-dlp 等子进程）`);
  } else {
    lines.push('- **离线模式（默认）：本轮未使用真实大模型**');
    lines.push(`- 出网尝试计数: ${net.egressAttempts}（全部被进程内守卫阻断）`);
    lines.push(`- 实际出网计数: ${net.actualEgress}`);
  }
  const hostEntries = Object.entries(net.hosts || {});
  if (hostEntries.length > 0) {
    lines.push(`- 尝试的主机: ${hostEntries.map(([host, count]) => `${host} ×${count}`).join('，')}`);
  }
  const perVideoAttempts = (baseline.videos || []).filter(item => Number(item.egressAttempts) > 0);
  if (perVideoAttempts.length > 0) {
    lines.push(`- 分视频出网尝试: ${perVideoAttempts.map(item => `${item.id}: ${item.egressAttempts} 次`).join('，')}`);
  }
  lines.push('');

  lines.push('| id | bvid | bvid 来源 | source | duration | duration_source | 抽帧数 | 视觉帧数 | visualCuts | audioCuts | segments | 不变量 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const item of baseline.videos) {
    lines.push([
      `| ${item.id}`,
      item.bvid ?? 'null',
      item.bvidSource ?? 'null',
      item.source,
      item.duration?.value ?? 'null',
      item.duration?.durationSource ?? 'null',
      item.frames?.count ?? 'null',
      item.visualProbe?.frameCount ?? 'null',
      item.visualCuts?.count ?? 'null',
      item.audioCuts?.count ?? 'null',
      item.segments?.count ?? 'null',
      item.segments?.invariantFailures?.length ?? '-',
      `${item.status} |`
    ].join(' | '));
  }
  lines.push('');

  // 跳过项单独成段：只少打几行的话，看报告的人会以为这次跑的是完整清单
  lines.push('## 本轮跳过的条目');
  lines.push('');
  if (!Array.isArray(baseline.skipped) || baseline.skipped.length === 0) {
    lines.push('无（清单里的条目全部执行）');
  } else {
    lines.push('| id | source | value | 跳过原因 |');
    lines.push('|---|---|---|---|');
    for (const item of baseline.skipped) {
      lines.push(`| ${item.id} | ${item.source} | ${item.value} | ${item.reason} |`);
    }
  }
  lines.push('');

  const failed = baseline.videos.filter(v => v.status !== 'ok');
  if (failed.length > 0) {
    lines.push('## 未通过的视频');
    lines.push('');
    for (const item of failed) {
      lines.push(`### ${item.id} (${item.status})`);
      for (const error of item.errors || []) {
        lines.push(`- 报错: ${error.message}${error.code ? ` [code=${error.code} reason=${error.reason} stage=${error.stage}]` : ''}`);
      }
      for (const failure of item.segments?.invariantFailures || []) {
        lines.push(`- 不变量 ${failure.rule}: ${failure.segment}${failure.detail ? ` — ${failure.detail}` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## 降级情况（如实记录，不代表失败）');
  lines.push('');
  for (const item of baseline.videos) {
    const notes = [];
    if (item.asr?.provider) notes.push(`ASR provider=${item.asr.provider}${item.asr.degradations?.length ? `，降级 ${item.asr.degradations.length} 条` : ''}`);
    if (item.segmentPipeline?.fallbackReason) notes.push(`分段合并 fallback: ${item.segmentPipeline.fallbackReason}`);
    if (item.visualCuts?.fallbackReason) notes.push(`视觉切点 fallback: ${item.visualCuts.fallbackReason}`);
    lines.push(`- ${item.id}: ${notes.length ? notes.join('；') : '无'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 对比
// ---------------------------------------------------------------------------

function timesEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((value, index) => Math.abs(Number(value) - Number(right[index])) < 0.001);
}

function compareBaselines(a, b) {
  const deterministic = [];
  const flaky = [];
  const ids = [...new Set([...a.videos.map(v => v.id), ...b.videos.map(v => v.id)])];

  for (const id of ids) {
    const left = a.videos.find(v => v.id === id);
    const right = b.videos.find(v => v.id === id);
    if (!left || !right) {
      deterministic.push({ id, item: 'videos', detail: left ? 'B 中缺少该视频' : 'A 中缺少该视频' });
      continue;
    }

    // (a) 确定性项：不一致即回归
    const pairs = [
      ['duration', left.duration?.value, right.duration?.value],
      ['duration_source', left.duration?.durationSource, right.duration?.durationSource],
      ['frames.count', left.frames?.count, right.frames?.count],
      ['frames.keyframeTimestampCount', left.frames?.keyframeTimestampCount, right.frames?.keyframeTimestampCount],
      ['visualProbe.frameCount', left.visualProbe?.frameCount, right.visualProbe?.frameCount],
      ['visualCuts.count', left.visualCuts?.count, right.visualCuts?.count],
      ['audioCuts.count', left.audioCuts?.count, right.audioCuts?.count]
    ];
    for (const [item, leftValue, rightValue] of pairs) {
      if (leftValue !== rightValue) deterministic.push({ id, item, detail: `A=${leftValue} B=${rightValue}` });
    }
    if (!timesEqual(left.visualCuts?.times, right.visualCuts?.times)) {
      deterministic.push({
        id,
        item: 'visualCuts.times',
        detail: `A=[${(left.visualCuts?.times || []).slice(0, 12).join(',')}] B=[${(right.visualCuts?.times || []).slice(0, 12).join(',')}]`
      });
    }
    if (!timesEqual(left.audioCuts?.times, right.audioCuts?.times)) {
      deterministic.push({
        id,
        item: 'audioCuts.times',
        detail: `A=[${(left.audioCuts?.times || []).slice(0, 12).join(',')}] B=[${(right.audioCuts?.times || []).slice(0, 12).join(',')}]`
      });
    }

    // (b) 允许抖动项：只报差异量级，不判失败（契约第五节：语义合并边界不保证跨次复现）
    const textA = left.asr?.transcriptText || '';
    const textB = right.asr?.transcriptText || '';
    if (textA !== textB) {
      flaky.push({
        id,
        item: 'asr.transcriptText',
        detail: `长度 A=${textA.length} B=${textB.length}（差 ${Math.abs(textA.length - textB.length)} 字符）`
      });
    }

    const boundariesA = left.segments?.boundaries || [];
    const boundariesB = right.segments?.boundaries || [];
    const idsA = left.segments?.ids || [];
    const idsB = right.segments?.ids || [];
    const maxBoundaryDelta = boundariesA.length === boundariesB.length
      ? boundariesA.reduce((max, pair, index) => {
        const other = boundariesB[index] || [];
        return Math.max(max, Math.abs(Number(pair[0]) - Number(other[0]) || 0), Math.abs(Number(pair[1]) - Number(other[1]) || 0));
      }, 0)
      : null;
    if (left.segments?.count !== right.segments?.count
      || idsA.join('|') !== idsB.join('|')
      || !timesEqual(boundariesA.flat(), boundariesB.flat())) {
      flaky.push({
        id,
        item: 'segments.boundaries+ids',
        detail: `条数 A=${left.segments?.count} B=${right.segments?.count}；`
          + `边界最大差=${maxBoundaryDelta === null ? '不适用（条数不同）' : `${maxBoundaryDelta.toFixed(2)}s`}；`
          + `id 差异=${idsA.filter(x => !idsB.includes(x)).length + idsB.filter(x => !idsA.includes(x)).length}`
      });
    }
  }

  return { deterministic, flaky };
}

function printCompare(report, fileA, fileB) {
  console.log('========== 基线对比 ==========');
  console.log(`A: ${fileA}`);
  console.log(`B: ${fileB}`);
  console.log('');
  console.log(`--- (a) 确定性项：${report.deterministic.length} 处不一致（不一致即回归）---`);
  if (report.deterministic.length === 0) {
    console.log('  完全一致 ✓');
  } else {
    for (const item of report.deterministic) console.log(`  ✗ [${item.id}] ${item.item}: ${item.detail}`);
  }
  console.log('');
  console.log(`--- (b) 允许抖动项：${report.flaky.length} 处差异（不判失败，只看量级）---`);
  if (report.flaky.length === 0) {
    console.log('  两次完全一致（本就不保证，一致属于运气好）');
  } else {
    for (const item of report.flaky) console.log(`  ~ [${item.id}] ${item.item}: ${item.detail}`);
  }
  console.log('');
  console.log('分类依据：docs/SEGMENT_PIPELINE_CONTRACT.md 第五节 —— 语义合并走大模型，'
    + '片段边界不保证跨次复现，segmentId 随之变化；ASR 文本同理。');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const [fileA, fileB] = args.compare;
    if (!fileA || !fileB) throw new Error('用法: --compare <A.json> <B.json>');
    const report = compareBaselines(readJson(fileA), readJson(fileB));
    printCompare(report, fileA, fileB);
    if (report.deterministic.length > 0) process.exitCode = 1;
    return;
  }

  const list = readJson(args.list);
  const declared = Array.isArray(list.videos) ? list.videos.filter(Boolean) : [];
  const enabled = declared.filter(entry => entry.enabled !== false);
  const onlyFilter = args.only && args.only.length > 0 ? args.only : null;
  const selected = onlyFilter ? enabled.filter(entry => onlyFilter.includes(entry.id)) : enabled;

  // 离线模式下 source=bvid 的条目直接跳过：下载由 yt-dlp 子进程发起，进程内守卫拦不住，
  // 与其让它带着"半拦截"状态跑出难以解释的错误，不如显式跳过并写清怎么打开。
  const offlineSkipped = args.allowNetwork
    ? []
    : selected
      .filter(entry => entry.source !== 'file')
      .map(entry => ({
        id: entry.id,
        source: entry.source,
        value: entry.value,
        reason: '离线模式（默认）：下载由 yt-dlp 子进程发起，进程内守卫拦不住；'
          + '要跑下载链路请加 --allow-network 或 BASELINE_ALLOW_NETWORK=1'
      }));
  const entries = args.allowNetwork ? selected : selected.filter(entry => entry.source === 'file');

  // 跳过项必须显式列出来：只少打几行的话，看报告的人会以为这次跑的是完整清单
  const skipped = [
    ...declared
      .filter(entry => entry.enabled === false)
      .map(entry => ({
        id: entry.id,
        source: entry.source,
        value: entry.value,
        reason: 'enabled=false（清单里显式关闭，待团队确认后再打开）'
      })),
    ...(onlyFilter ? enabled.filter(entry => !onlyFilter.includes(entry.id)) : [])
      .map(entry => ({
        id: entry.id,
        source: entry.source,
        value: entry.value,
        reason: `--only 未选中（本次只跑 ${onlyFilter.join(',')}）`
      })),
    ...offlineSkipped
  ];

  if (entries.length === 0) {
    const hint = offlineSkipped.length > 0
      ? '；其中部分条目因默认离线被跳过，如确需真实外网请加 --allow-network'
      : '';
    throw new Error(`清单里没有可运行的条目（跳过 ${skipped.length} 个：${skipped.map(item => item.id).join(',') || '无'}${hint}）`);
  }

  if (args.allowNetwork) {
    console.log('⚠️  --allow-network 已打开：本次会调用真实付费接口（DashScope 大模型等），并可能触发真实下载');
  } else {
    console.log('[离线模式] 已阻断进程内出网：本轮不会使用真实大模型；要打开真实网络请加 --allow-network');
  }
  console.log(`========== 媒体链路基线跑批（${entries.length} 个视频，跳过 ${skipped.length} 个）==========`);
  const baseline = {
    startedAt: new Date().toISOString(),
    listPath: args.list,
    listComment: list._comment || null,
    videos: [],
    skipped,
    summary: { ok: 0, fail: 0, error: 0 }
  };

  // 串行跑：并行会让 ffmpeg/python 互相抢 CPU，视觉指标这类纯计算项反而更不稳
  for (const entry of entries) {
    console.log(`\n----- ${entry.id} (${entry.source}) -----`);
    const attemptsBefore = networkGuard.stats.attempts;
    let record;
    try {
      record = await runOne(entry);
    } catch (error) {
      record = { id: entry.id, source: entry.source, value: entry.value, status: 'error', errors: [{ message: error?.message || String(error) }] };
    }
    // 本视频跑动期间发生过多少次出网尝试（离线模式下即被拦截的次数）
    record.egressAttempts = networkGuard.stats.attempts - attemptsBefore;
    baseline.videos.push(record);
    baseline.summary[record.status] = (baseline.summary[record.status] || 0) + 1;
    console.log(`[${record.id}] status=${record.status} 耗时=${record.elapsedMs}ms`);
    for (const error of record.errors || []) console.log(`  报错: ${error.message}`);
    for (const failure of record.segments?.invariantFailures || []) console.log(`  不变量 ${failure.rule}: ${failure.segment} ${failure.detail || ''}`);
  }

  // 覆盖范围必须写出来：本地文件跑批天然覆盖不到下载链路，
  // 不写的话看报告的人会以为「通过」= 整条链路都验过了
  const localFileItems = baseline.videos.filter(item => item.source === 'file').length;
  const downloadItems = baseline.videos.length - localFileItems;
  baseline.coverage = {
    localFileItems,
    downloadItems,
    downloadChainCovered: downloadItems > 0,
    note: downloadItems > 0
      ? `其中 ${downloadItems} 项走了真实下载链路（下载降级 / Cookie 切换 / 风控错误分类都在其中）`
      : '本轮全部为本地文件，未覆盖下载链路（下载降级 / Cookie 切换 / 风控错误分类都不在基线内）；'
        + 'download 相关字段为 {skipped:true}（path / elapsedMs / cachedBeforeRun 为 null）属预期，不代表该项通过'
  };

  baseline.network = {
    mode: args.allowNetwork ? 'allow-network' : 'offline',
    // 离线模式下进程内已硬阻断，可以断言"本轮未使用真实大模型"；在线模式不做断言，
    // 是否真的发出看下面的 egressAttempts。
    realModelUsed: args.allowNetwork ? null : false,
    egressAttempts: networkGuard.stats.attempts,
    blockedConnections: networkGuard.stats.blockedConnections,
    blockedDnsLookups: networkGuard.stats.blockedDnsLookups,
    actualEgress: networkGuard.stats.actualEgress,
    hosts: networkGuard.stats.hosts,
    samples: networkGuard.stats.samples,
    note: args.allowNetwork
      ? '⚠️ --allow-network 已打开：本次会调用真实付费接口（DashScope 等）；计数只覆盖进程内 http(s)/fetch，不含 yt-dlp 等子进程'
      : '本轮未使用真实大模型：进程内出网已被守卫阻断，实际出网 0 次；计数覆盖进程内 http(s)/fetch'
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${timestampSlug()}-baseline.json`);
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2), 'utf8');

  console.log('\n');
  console.log(toMarkdown(baseline));
  console.log('');
  console.log(`完整记录: ${outputPath}`);

  if (baseline.summary.fail > 0 || baseline.summary.error > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('基线跑批失败:', error);
  process.exitCode = 1;
});
