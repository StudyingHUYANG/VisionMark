'use strict';

/**
 * BilibiliDownloader 下载链路 / 错误分类 测试
 *
 * 运行方式: node server/services/bilibiliDownloader.test.js
 *
 * 全部用例均为确定性测试：mock 掉 axios 与 child_process.spawn，
 * 只使用本机临时目录做文件读写，不访问真实网络、不读取真实 Cookie。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// 必须在 require bilibiliDownloader 之前把 killProcessTree 换成记录桩：
// bilibiliDownloader 在模块加载时 require 它（同 audioCuts.test.js 的手法），
// 晚替换拿到的是真实现，超时用例会真的执行 taskkill。
// ---------------------------------------------------------------------------
const KILL_PROCESS_TREE_PATH = require.resolve('../utils/killProcessTree');
const killCalls = [];
require.cache[KILL_PROCESS_TREE_PATH] = {
  id: KILL_PROCESS_TREE_PATH,
  filename: KILL_PROCESS_TREE_PATH,
  loaded: true,
  exports: {
    killProcessTree: (child) => {
      killCalls.push(child);
    }
  }
};

const BilibiliDownloader = require('./bilibiliDownloader');
const {
  ERROR_CODES,
  ERROR_REASONS,
  ERROR_STAGES,
  DownloadError,
  classifyYtDlpFailure,
  classifyBilibiliApiResponse,
  parseCookieInput,
  scrubSecrets,
  finalizeDownloadError,
  resolveMergeTimeoutMs,
  MERGE_TIMEOUT_FLOOR_MS,
  MERGE_TIMEOUT_PER_MB_MS,
  PROBE_TIMEOUT_MS
} = BilibiliDownloader;

// ---------------------------------------------------------------------------
// 断言与测试框架（保持与仓库现有脚本风格一致）
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(condition, label, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(actual, expected, label) {
  check(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (error) {
    failures.push(`${name} 抛出异常: ${error.stack || error.message}`);
    console.error(`  ✗ 抛出异常: ${error.stack || error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Mock 工具
// ---------------------------------------------------------------------------

const BV = 'BV1GJ411x7h7';
const CID = 137649199;
const VIDEO_BYTES = 48 * 1024; // 大于最小体积阈值

/** 构造可同时作为函数与 .get 使用的 axios mock */
function createHttpMock(handler) {
  const calls = [];
  const fn = async (config) => {
    const entry = { kind: 'request', url: config.url, headers: config.headers || {} };
    calls.push(entry);
    return handler(entry, config);
  };
  fn.get = async (url, config = {}) => {
    const entry = { kind: 'get', url, headers: config.headers || {}, params: config.params || {} };
    calls.push(entry);
    return handler(entry, config);
  };
  fn.calls = calls;
  fn.countByUrl = (fragment) => calls.filter(call => String(call.url).includes(fragment)).length;
  return fn;
}

function viewBody({ code = 0, message = 'OK', cid = CID } = {}) {
  return {
    status: 200,
    data: code === 0
      ? { code: 0, message: 'OK', data: { bvid: BV, pages: [{ cid }] } }
      : { code, message, data: null }
  };
}

function playUrlBody({ durl = null, dash = null, code = 0, message = 'OK', quality = 64 } = {}) {
  return {
    status: 200,
    data: code === 0
      ? { code: 0, message: 'OK', data: { quality, durl, dash } }
      : { code, message, data: null }
  };
}

/** 一次性完整成功响应体 */
function streamResponse(bytes = VIDEO_BYTES, { contentType = 'video/mp4', status = 200 } = {}) {
  return {
    status,
    headers: { 'content-type': contentType, 'content-length': String(bytes) },
    data: Readable.from([Buffer.alloc(bytes, 7)])
  };
}

/** 中途断流的响应体 */
function interruptedResponse({ bytesBeforeError = 4096 } = {}) {
  const stream = new Readable({ read() { /* 手动推送 */ } });
  setImmediate(() => {
    stream.push(Buffer.alloc(bytesBeforeError, 1));
    setImmediate(() => stream.destroy(new Error('socket hang up')));
  });
  return {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO_BYTES) },
    data: stream
  };
}

/** 返回 HTML 风险控制页面的响应体 */
function riskControlPageResponse() {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    data: Readable.from([Buffer.from('<html><title>412 Precondition Failed</title>风险控制</html>')])
  };
}

/** spawn mock：ffmpeg 写出文件，ffprobe 回放 stdout */
function createSpawnMock(options = {}) {
  const calls = [];
  const spawnImpl = (cmd, args = [], spawnOptions = {}) => {
    calls.push({ cmd, args, spawnOptions });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    setImmediate(() => {
      const isProbe = String(cmd).includes('ffprobe') || args.includes('-show_entries');
      if (isProbe) {
        const result = options.onProbe ? options.onProbe(args) : { code: 0, stdout: 'video\n' };
        child.stdout.emit('data', Buffer.from(result.stdout || ''));
        child.stderr.emit('data', Buffer.from(result.stderr || ''));
        child.emit('close', result.code ?? 0);
        return;
      }

      const outPath = args[args.length - 1];
      const result = options.onFfmpeg ? options.onFfmpeg(outPath, args) : { code: 0 };
      if ((result.code ?? 0) === 0 && outPath) {
        try {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, Buffer.alloc(VIDEO_BYTES, 3));
        } catch (_) { /* noop */ }
      }
      child.stderr.emit('data', Buffer.from(result.stderr || ''));
      child.emit('close', result.code ?? 0);
    });

    return child;
  };
  spawnImpl.calls = calls;
  spawnImpl.ffmpegCalls = () => calls.filter(call => !call.args.includes('-show_entries'));
  spawnImpl.probeCalls = () => calls.filter(call => call.args.includes('-show_entries'));
  return spawnImpl;
}

function makeDownloader({ http, spawnImpl, dir, ffprobePath = 'ffprobe-mock', mergeTimeoutMs, probeTimeoutMs }) {
  return new BilibiliDownloader({
    downloadDir: dir,
    http,
    spawnImpl,
    ffprobePath,
    maxAttemptsPerStrategy: 2,
    mergeTimeoutMs,
    probeTimeoutMs
  });
}

function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vm-dl-${name}-`));
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/** 写一个 Netscape 格式的临时 Cookie 文件；返回路径 */
function writeCookieFile(dir, {
  sessdata = 'TEST_SESSDATA_VALUE_DO_NOT_LEAK',
  expiry = Math.floor(Date.now() / 1000) + 86400,
  includeSessdata = true
} = {}) {
  const lines = [
    '# Netscape HTTP Cookie File',
    `.bilibili.com\tTRUE\t/\tFALSE\t${expiry}\tbili_jct\tTEST_JCT_VALUE_DO_NOT_LEAK`
  ];
  if (includeSessdata) {
    lines.push(`.bilibili.com\tTRUE\t/\tFALSE\t${expiry}\tSESSDATA\t${sessdata}`);
  }
  const cookiePath = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookiePath, `${lines.join('\n')}\n`, 'utf8');
  return cookiePath;
}

const singlePartDurl = () => [{
  order: 1,
  length: 213,
  size: VIDEO_BYTES,
  url: 'https://cdn.test/video-part-1.mp4',
  backup_url: []
}];

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== BilibiliDownloader 测试 ==========');
  console.log(`临时目录: ${os.tmpdir()}`);

  // --- 1. 纯函数：Cookie 解析 ---
  await test('parseCookieInput 解析 Netscape 与原始 Cookie', () => {
    const netscape = parseCookieInput('.bilibili.com\tTRUE\t/\tFALSE\t9999999999\tSESSDATA\tabc\n');
    check(netscape.valid, 'Netscape 格式解析为有效');
    check(netscape.hasSessdata, 'Netscape 格式识别出 SESSDATA');

    const raw = parseCookieInput('SESSDATA=abc; bili_jct=def');
    check(raw.valid, '原始 Cookie 头解析为有效');
    equal(raw.pairs.length, 2, '原始 Cookie 头解析出 2 个键值');

    const empty = parseCookieInput('');
    check(!empty.valid, '空输入判为无效');
    equal(empty.reason, ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED, '空输入原因为 COOKIE_INVALID_OR_EXPIRED');

    const expired = parseCookieInput('.bilibili.com\tTRUE\t/\tFALSE\t1000000000\tSESSDATA\tabc\n');
    check(!expired.valid, '过期 Cookie 判为无效');

    const noSessdata = parseCookieInput('.bilibili.com\tTRUE\t/\tFALSE\t9999999999\tbili_jct\tabc\n');
    check(!noSessdata.valid, '缺少 SESSDATA 判为未登录');
  });

  // --- 2. 纯函数：脱敏 ---
  await test('scrubSecrets 不泄漏 Cookie 明文', () => {
    const scrubbed = scrubSecrets('Cookie: SESSDATA=SECRET123; bili_jct=SECRET456');
    check(!scrubbed.includes('SECRET123'), 'scrubSecrets 移除 SESSDATA 值');
    check(!scrubbed.includes('SECRET456'), 'scrubSecrets 移除 bili_jct 值');

    const netscapeLine = scrubSecrets('.bilibili.com\tTRUE\t/\tFALSE\t9999999999\tSESSDATA\tSECRET789');
    check(!netscapeLine.includes('SECRET789'), 'scrubSecrets 移除 Netscape 行中的值');
  });

  // --- 3. 纯函数：B 站业务码分类 ---
  await test('classifyBilibiliApiResponse 分类优先级', () => {
    equal(classifyBilibiliApiResponse(-404, '啥都木有').code, ERROR_CODES.VIDEO_INACCESSIBLE, '-404 → VIDEO_INACCESSIBLE');
    equal(classifyBilibiliApiResponse(62002, '稿件不可见').code, ERROR_CODES.VIDEO_INACCESSIBLE, '62002 → VIDEO_INACCESSIBLE');
    equal(classifyBilibiliApiResponse(62004, '稿件审核中').reason, ERROR_REASONS.VIDEO_UNDER_REVIEW, '62004 → VIDEO_UNDER_REVIEW');
    equal(classifyBilibiliApiResponse(-400, '请求错误').code, ERROR_CODES.INVALID_INPUT, '-400 → INVALID_INPUT');
    equal(classifyBilibiliApiResponse(-412, '风控').code, ERROR_CODES.RISK_CONTROL_412, '-412 → RISK_CONTROL_412');
    equal(classifyBilibiliApiResponse(-352, '风控校验失败').code, ERROR_CODES.RISK_CONTROL_412, '-352 → RISK_CONTROL_412');
    equal(classifyBilibiliApiResponse(0, 'OK').code, null, 'code=0 不产生错误');

    // -101 账号未登录：带 Cookie 时说明 Cookie 失效，应允许降级
    equal(
      classifyBilibiliApiResponse(-101, '账号未登录', { cookieSupplied: true }).reason,
      ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED,
      '带 Cookie 的 -101 → COOKIE_INVALID_OR_EXPIRED'
    );
    equal(
      classifyBilibiliApiResponse(-101, '账号未登录', { cookieSupplied: true }).code,
      ERROR_CODES.DOWNLOAD_FAILED,
      '带 Cookie 的 -101 不是致命错误'
    );
  });

  // --- 4. 纯函数：yt-dlp 输出分类 ---
  await test('classifyYtDlpFailure 分类', () => {
    equal(classifyYtDlpFailure('ERROR: HTTP Error 412: Precondition Failed').code, ERROR_CODES.RISK_CONTROL_412, '412 → RISK_CONTROL_412');
    equal(classifyYtDlpFailure('ERROR: 稿件不可见').code, ERROR_CODES.VIDEO_INACCESSIBLE, '稿件不可见 → VIDEO_INACCESSIBLE');
    equal(classifyYtDlpFailure('ERROR: unable to extract').code, ERROR_CODES.VIDEO_INACCESSIBLE, 'unable to extract → VIDEO_INACCESSIBLE');
    equal(classifyYtDlpFailure('ERROR: connection reset by peer').code, ERROR_CODES.DOWNLOAD_FAILED, '网络错误 → DOWNLOAD_FAILED');
  });

  // --- 5. 最终分类不变量 ---
  await test('finalizeDownloadError 分类不变量', () => {
    const all412 = finalizeDownloadError({
      attempts: [
        { code: ERROR_CODES.RISK_CONTROL_412, reason: ERROR_REASONS.HTTP_412, stage: 'video_info' },
        { code: ERROR_CODES.RISK_CONTROL_412, reason: ERROR_REASONS.HTTP_412, stage: 'download' }
      ],
      lastError: null
    });
    equal(all412.code, ERROR_CODES.RISK_CONTROL_412, '全部 412 → RISK_CONTROL_412');

    // 「文件不存在」不应覆盖此前的 412 判定
    const trailingFileMissing = finalizeDownloadError({
      attempts: [
        { code: ERROR_CODES.RISK_CONTROL_412, reason: ERROR_REASONS.HTTP_412, stage: 'video_info' },
        { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.FILE_NOT_FOUND, stage: 'validate' }
      ],
      lastError: null
    });
    equal(trailingFileMissing.code, ERROR_CODES.RISK_CONTROL_412, '尾随的「文件不存在」不覆盖 412');

    const inaccessible = finalizeDownloadError({
      attempts: [{ code: ERROR_CODES.VIDEO_INACCESSIBLE, reason: ERROR_REASONS.VIDEO_DELETED, stage: 'video_info' }],
      lastError: null
    });
    equal(inaccessible.code, ERROR_CODES.VIDEO_INACCESSIBLE, 'VIDEO_INACCESSIBLE 优先');
  });

  // --- 6. 非法输入 ---
  await test('非法 URL / BV 号 → INVALID_INPUT', async () => {
    const dir = makeTempDir('invalid');
    const http = createHttpMock(() => { throw new Error('不应发起请求'); });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    for (const badInput of ['', 'https://www.bilibili.com/video/av12345', 'not-a-url', null]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await downloader.downloadVideo(badInput, null, {});
        check(false, `非法输入 ${JSON.stringify(badInput)} 应当抛错`);
      } catch (error) {
        equal(error.code, ERROR_CODES.INVALID_INPUT, `非法输入 ${JSON.stringify(badInput)} → INVALID_INPUT`);
      }
    }

    equal(http.calls.length, 0, '非法输入不发起网络请求');
    cleanupDir(dir);
  });

  // --- 7. 公开视频匿名下载成功（durl 单分片） ---
  await test('公开视频匿名下载成功（durl）', async () => {
    const dir = makeTempDir('anon-durl');
    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return streamResponse();
    });
    const spawnImpl = createSpawnMock();
    const downloader = makeDownloader({ http, spawnImpl, dir });

    const onAttempt = [];
    const result = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {
      onAttempt: entry => onAttempt.push(entry)
    });

    const outputPath = path.join(dir, `${BV}.mp4`);
    equal(result, outputPath, '返回最终 mp4 路径');
    check(fs.existsSync(outputPath), '文件已落盘');
    equal(fs.statSync(outputPath).size, VIDEO_BYTES, '文件大小与 API 声明一致');

    const okAttempt = onAttempt.find(entry => entry.ok);
    check(Boolean(okAttempt), '存在成功尝试记录');
    equal(okAttempt.withCookie, false, '成功尝试为匿名路径');
    check(!okAttempt.strategy.includes('cache'), '不是缓存命中');

    const cookieSent = http.calls.some(call => call.headers.Cookie);
    check(!cookieSent, '匿名路径未发送 Cookie 头');

    cleanupDir(dir);
  });

  // --- 8. 携带 Cookie 成功（dash：视频流 + 音频流 + ffmpeg 合并） ---
  await test('携带 Cookie 成功并合并 dash 音视频', async () => {
    const dir = makeTempDir('cookie-dash');
    const cookiePath = writeCookieFile(dir);

    const dash = {
      video: [{ id: 64, baseUrl: 'https://cdn.test/v.m4s', backupUrl: ['https://cdn.test/v-backup.m4s'] }],
      audio: [{ id: 30280, baseUrl: 'https://cdn.test/a.m4s' }]
    };

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ dash });
      return streamResponse();
    });
    const spawnImpl = createSpawnMock();
    const downloader = makeDownloader({ http, spawnImpl, dir });

    const outputPath = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, { cookiesPath: cookiePath });

    check(fs.existsSync(outputPath), 'dash 路径产出 mp4');
    equal(spawnImpl.ffmpegCalls().length, 1, '调用了一次 ffmpeg 合并');
    check(http.calls.some(call => call.headers.Cookie), '请求携带了 Cookie 头');

    // 临时流文件应被清理
    const leftovers = fs.readdirSync(dir).filter(file => file.endsWith('.m4s') || file.endsWith('.part'));
    equal(leftovers.length, 0, '临时流文件已清理');

    cleanupDir(dir);
  });

  // --- 9. Cookie 失效 → 匿名降级成功 ---
  await test('Cookie 过期时匿名降级成功', async () => {
    const dir = makeTempDir('cookie-expired');
    const cookiePath = writeCookieFile(dir, { expiry: 1000000000 });

    const http = createHttpMock((entry) => {
      check(!entry.headers.Cookie, '过期 Cookie 不应出现在任何请求头中');
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return streamResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    const onAttempt = [];
    const outputPath = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {
      cookiesPath: cookiePath,
      onAttempt: entry => onAttempt.push(entry)
    });

    check(fs.existsSync(outputPath), '降级后仍下载成功');
    check(
      onAttempt.some(entry => entry.reason === ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED),
      '记录了 COOKIE_INVALID_OR_EXPIRED 尝试'
    );
    check(onAttempt.some(entry => entry.ok && entry.withCookie === false), '匿名尝试成功');

    cleanupDir(dir);
  });

  // --- 10. Cookie 被服务端拒绝 → 匿名降级成功 ---
  await test('服务端拒绝 Cookie 后匿名降级成功', async () => {
    const dir = makeTempDir('cookie-rejected');
    const cookiePath = writeCookieFile(dir);

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) {
        // 携带 Cookie 时服务端返回 -101 账号未登录，等价于 Cookie 已失效
        return entry.headers.Cookie ? viewBody({ code: -101, message: '账号未登录' }) : viewBody();
      }
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return streamResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    const onAttempt = [];
    const outputPath = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {
      cookiesPath: cookiePath,
      onAttempt: entry => onAttempt.push(entry)
    });

    check(fs.existsSync(outputPath), '匿名降级后下载成功');
    const firstFailure = onAttempt.find(entry => !entry.ok);
    check(Boolean(firstFailure) && firstFailure.withCookie === true, '先记录了一次带 Cookie 的失败');
    equal(firstFailure.reason, ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED, '该次失败归类为 Cookie 失效');
    check(onAttempt.some(entry => entry.ok && entry.withCookie === false), '随后匿名成功');
    equal(http.countByUrl('/view'), 2, 'Cookie 与匿名各请求了一次 view');

    cleanupDir(dir);
  });

  // --- 11. 全部 412 → RISK_CONTROL_412 ---
  await test('所有路径均 412 → RISK_CONTROL_412', async () => {
    const dir = makeTempDir('all-412');
    const cookiePath = writeCookieFile(dir);

    const http = createHttpMock(() => ({ status: 412, headers: { 'content-type': 'text/html' }, data: { code: -412 } }));
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, { cookiesPath: cookiePath });
      check(false, '全 412 场景应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.RISK_CONTROL_412, '错误码为 RISK_CONTROL_412');
      check(error.message.includes('风控'), 'message 提示风控', error.message);
      check(Array.isArray(error.attempts) && error.attempts.length >= 2, '记录了 Cookie 与匿名两次尝试');
      check(error.attempts.every(attempt => attempt.code === ERROR_CODES.RISK_CONTROL_412), '两次尝试都归类为 412');
      check(error.retryable === true, '标记为可重试');
    }

    check(!fs.existsSync(path.join(dir, `${BV}.mp4`)), '失败后没有残留文件');
    cleanupDir(dir);
  });

  // --- 12. 视频不可访问 → 不进入匿名重试 ---
  await test('视频不可访问 → VIDEO_INACCESSIBLE 且不重试', async () => {
    const dir = makeTempDir('inaccessible');
    const cookiePath = writeCookieFile(dir);

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody({ code: 62002, message: '稿件不可见' });
      return playUrlBody({ durl: singlePartDurl() });
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, { cookiesPath: cookiePath });
      check(false, '不可访问场景应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.VIDEO_INACCESSIBLE, '错误码为 VIDEO_INACCESSIBLE');
      equal(error.reason, ERROR_REASONS.VIDEO_INVISIBLE, '原因为稿件不可见');
      equal(error.retryable, false, '标记为不可重试');
    }

    equal(http.countByUrl('/view'), 1, 'view 只请求一次，未做无意义重试');
    equal(http.countByUrl('/playurl'), 0, '未进入 playurl 阶段');
    cleanupDir(dir);
  });

  // --- 13. 无 durl 也无 dash → NO_PLAYABLE_STREAM ---
  await test('无 durl / dash → DOWNLOAD_FAILED + NO_PLAYABLE_STREAM', async () => {
    const dir = makeTempDir('no-stream');
    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      return playUrlBody({});
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
      check(false, '无可用流时应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.DOWNLOAD_FAILED, '错误码为 DOWNLOAD_FAILED');
      equal(error.reason, ERROR_REASONS.NO_PLAYABLE_STREAM, '原因为 NO_PLAYABLE_STREAM');
      equal(error.stage, 'playurl', '阶段为 playurl');
    }

    cleanupDir(dir);
  });

  // --- 14. 响应流中断 → 不留下成功缓存 ---
  await test('响应流中断时不留下成功缓存', async () => {
    const dir = makeTempDir('interrupted');
    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return interruptedResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
      check(false, '流中断时应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.DOWNLOAD_FAILED, '流中断归类为 DOWNLOAD_FAILED');
      check(
        [ERROR_REASONS.STREAM_INTERRUPTED, ERROR_REASONS.SIZE_MISMATCH].includes(error.reason),
        '原因为流中断或大小不符',
        error.reason
      );
    }

    check(!fs.existsSync(path.join(dir, `${BV}.mp4`)), '没有生成成功缓存文件');
    const leftovers = fs.readdirSync(dir).filter(file => file.endsWith('.part'));
    equal(leftovers.length, 0, '没有残留 .part 文件');
    cleanupDir(dir);
  });

  // --- 15. 下载体积不符 → 判为失败并清理 ---
  await test('体积与 API 声明不符时判为失败', async () => {
    const dir = makeTempDir('size-mismatch');
    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) {
        return playUrlBody({ durl: [{ order: 1, size: VIDEO_BYTES * 2, url: 'https://cdn.test/truncated.mp4' }] });
      }
      return streamResponse(VIDEO_BYTES); // 实际只给一半
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
      check(false, '体积不符时应当失败');
    } catch (error) {
      equal(error.reason, ERROR_REASONS.SIZE_MISMATCH, '原因为 SIZE_MISMATCH');
      equal(error.stage, 'validate', '阶段为 validate');
    }

    check(!fs.existsSync(path.join(dir, `${BV}.mp4`)), '体积不符的文件未进入缓存');
    cleanupDir(dir);
  });

  // --- 16. HTML 风控页面 → RISK_CONTROL_412 ---
  await test('CDN 返回风控页面 → RISK_CONTROL_412', async () => {
    const dir = makeTempDir('rc-page');
    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return riskControlPageResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
      check(false, '风控页面应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.RISK_CONTROL_412, '风控页面归类为 RISK_CONTROL_412');
    }

    cleanupDir(dir);
  });

  // --- 17. 缓存完整性 ---
  await test('中断产物不被当成缓存命中', async () => {
    const dir = makeTempDir('cache-integrity');
    const outputPath = path.join(dir, `${BV}.mp4`);

    // 写入一个体积不足的假缓存
    fs.writeFileSync(outputPath, Buffer.alloc(64, 0));

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return streamResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    const result = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
    check(http.countByUrl('/view') === 1, '损坏缓存触发真实下载');
    equal(fs.statSync(result).size, VIDEO_BYTES, '最终文件为重新下载的完整文件');

    // 再跑一次应命中有效缓存
    const cachedResult = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
    equal(http.countByUrl('/view'), 1, '有效缓存命中时不再请求 view');
    equal(cachedResult, outputPath, '缓存命中返回同一路径');

    cleanupDir(dir);
  });

  // --- 18. 日志与错误对象不含 Cookie 明文 ---
  await test('日志与错误对象不含 Cookie 明文', async () => {
    const dir = makeTempDir('no-leak');
    const secret = 'SUPER_SECRET_SESSDATA_9137';
    const cookiePath = writeCookieFile(dir, { sessdata: secret });

    const captured = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    console.warn = (...args) => captured.push(args.map(String).join(' '));
    console.error = (...args) => captured.push(args.map(String).join(' '));
    console.log = (...args) => captured.push(args.map(String).join(' '));

    let thrown = null;
    try {
      const http = createHttpMock(() => ({ status: 412, headers: {}, data: { code: -412, message: `风控 SESSDATA=${secret}` } }));
      const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, { cookiesPath: cookiePath });
    } catch (error) {
      thrown = error;
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
    }

    check(Boolean(thrown), '确实抛出了错误');
    const serialized = JSON.stringify({
      message: thrown.message,
      attempts: thrown.attempts,
      code: thrown.code,
      reason: thrown.reason
    });
    check(!serialized.includes(secret), '错误对象不含 Cookie 明文');
    check(!captured.join('\n').includes(secret), '日志不含 Cookie 明文');

    cleanupDir(dir);
  });

  // --- 19. 错误模型字段完整性 ---
  await test('DownloadError 保留必需字段', () => {
    const error = new DownloadError({
      code: ERROR_CODES.DOWNLOAD_FAILED,
      reason: ERROR_REASONS.STREAM_INTERRUPTED,
      stage: 'download',
      retryable: true,
      attempts: [{ strategy: 'bilibili_api', withCookie: false }]
    });
    check(error instanceof Error, 'DownloadError 继承 Error');
    equal(error.code, ERROR_CODES.DOWNLOAD_FAILED, 'code 保留');
    equal(error.reason, ERROR_REASONS.STREAM_INTERRUPTED, 'reason 保留');
    equal(error.stage, 'download', 'stage 保留');
    equal(error.retryable, true, 'retryable 保留');
    check(Array.isArray(error.attempts), 'attempts 保留');
    check(typeof error.toJSON === 'function', '提供 toJSON');
  });

  // --- 20. 进度上报：去重 + 携带策略信息 ---
  await test('进度上报按百分位去重且携带策略', async () => {
    const dir = makeTempDir('progress');
    const totalBytes = 512 * 1024;
    const chunk = Buffer.alloc(16 * 1024, 9);

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) {
        return playUrlBody({ durl: [{ order: 1, size: totalBytes, url: 'https://cdn.test/big.mp4' }] });
      }
      return {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(totalBytes) },
        data: Readable.from(Array.from({ length: totalBytes / chunk.length }, () => chunk))
      };
    });

    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });
    const progressEvents = [];
    await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, progress => progressEvents.push(progress), {});

    const downloadEvents = progressEvents.filter(event => event.stage === 'download');
    const messages = downloadEvents.map(event => event.message);
    equal(messages.length, new Set(messages).size, '同一百分位只上报一次，不逐 chunk 刷屏');
    check(downloadEvents.length <= 110, '上报次数受百分位数量限制', String(downloadEvents.length));
    check(downloadEvents.length >= 2, '至少上报了开始与进度', String(downloadEvents.length));

    // percent 必须单调不减，客户端才能安全地直接用
    const percents = downloadEvents.map(event => event.percent);
    const monotonic = percents.every((value, index) => index === 0 || value >= percents[index - 1]);
    check(monotonic, 'percent 单调不减', JSON.stringify(percents));

    check(downloadEvents.some(event => event.strategy), '进度事件携带 strategy');
    check(downloadEvents.every(event => typeof event.message === 'string'), '进度事件都有可读 message');

    cleanupDir(dir);
  });

  // --- 21. 尝试记录携带 HTTP / API 状态 ---
  await test('尝试记录保留 HTTP 状态与 B 站业务码', async () => {
    const dir = makeTempDir('attempt-status');

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) {
        return { status: 200, data: { code: -404, message: '啥都木有', data: null } };
      }
      return playUrlBody({});
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});
      check(false, '应当失败');
    } catch (error) {
      const attempt = error.attempts[0];
      check(Boolean(attempt), '存在尝试记录');
      equal(attempt.apiCode, -404, '保留了 B 站业务码');
      equal(attempt.stage, 'video_info', '保留了失败阶段');
      equal(attempt.strategy, 'bilibili_api_anonymous', '保留了策略名');
    }

    cleanupDir(dir);
  });

  // --- 22. 上次中断残留的中间文件被清理 ---
  await test('清理上次中断残留的中间产物', async () => {
    const dir = makeTempDir('stale');
    const staleFiles = [
      `${BV}.durl-1.mp4`,
      `${BV}.durl-2.mp4`,
      `${BV}.mp4.part`,
      `${BV}.video.m4s`,
      `${BV}.audio.m4s`,
      `${BV}.concat.txt`,
      `${BV}.f80.mp4`
    ];
    // 全部写成合法大小的文件，确认清理是按文件名而不是按体积
    staleFiles.forEach(file => fs.writeFileSync(path.join(dir, file), Buffer.alloc(VIDEO_BYTES, 2)));

    const http = createHttpMock((entry) => {
      if (entry.url.includes('/view')) return viewBody();
      if (entry.url.includes('/playurl')) return playUrlBody({ durl: singlePartDurl() });
      return streamResponse();
    });
    const downloader = makeDownloader({ http, spawnImpl: createSpawnMock(), dir });

    const outputPath = await downloader.downloadVideo(`https://www.bilibili.com/video/${BV}`, null, {});

    const remaining = fs.readdirSync(dir).filter(file => staleFiles.includes(file));
    equal(remaining.length, 0, `残留中间文件已清理 ${JSON.stringify(remaining)}`);
    equal(fs.statSync(outputPath).size, VIDEO_BYTES, '整片文件正常产出');

    cleanupDir(dir);
  });

  // --- 23. 超时策略：按时长/体积缩放且不低于下限 ---
  await test('超时策略按时长/体积缩放且不低于下限', () => {
    const MB = 1024 * 1024;

    check(MERGE_TIMEOUT_FLOOR_MS >= 5 * 60 * 1000, '合并超时下限不低于 5 分钟', String(MERGE_TIMEOUT_FLOOR_MS));
    equal(MERGE_TIMEOUT_PER_MB_MS, 200, '合并超时系数为 200ms/MB');
    equal(PROBE_TIMEOUT_MS, 60 * 1000, 'ffprobe 探测固定 60 秒');

    equal(resolveMergeTimeoutMs([], { fileSize: () => 0 }), MERGE_TIMEOUT_FLOOR_MS, '无输入时取 5 分钟下限');
    equal(
      resolveMergeTimeoutMs([['-i', 'v.m4s']], { fileSize: () => 100 * MB }),
      MERGE_TIMEOUT_FLOOR_MS,
      '100MB 缩放值仍低于下限，取下限'
    );
    equal(
      resolveMergeTimeoutMs([['-i', 'v.m4s'], ['-i', 'a.m4s']], { fileSize: () => 1000 * MB }),
      2000 * MERGE_TIMEOUT_PER_MB_MS,
      '多输入体积累加后按 200ms/MB 缩放'
    );

    // concat 列表本身只有几 KB，必须展开成真实分片体积参与缩放
    const dir = makeTempDir('merge-timeout-policy');
    const listPath = path.join(dir, `${BV}.concat.txt`);
    const part1 = path.join(dir, `${BV}.durl-1.mp4`);
    const part2 = path.join(dir, `${BV}.durl-2.mp4`);
    fs.writeFileSync(listPath, `file '${part1}'\nfile '${part2}'\n`, 'utf8');
    const sizes = { [part1]: 1500 * MB, [part2]: 1500 * MB };
    equal(
      resolveMergeTimeoutMs([['-f', 'concat'], ['-safe', '0'], ['-i', listPath]], { fileSize: p => sizes[p] || 0 }),
      3000 * MERGE_TIMEOUT_PER_MB_MS,
      'concat 列表展开后按分片总体积缩放'
    );
    cleanupDir(dir);
  });

  // --- 24. 合并超时：抛 DownloadError、删 .part、杀进程树 ---
  await test('mergeWithFfmpeg 超时 → MERGE 失败、清理 .part、杀进程树', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('merge-timeout');
    const outputPath = path.join(dir, `${BV}.mp4`);
    const partPath = `${outputPath}.part`;
    // 模拟 ffmpeg 已经写了一半的半成品
    fs.writeFileSync(partPath, Buffer.alloc(4096, 1));

    let childRef = null;
    const spawnImpl = () => {
      childRef = new EventEmitter();
      childRef.stdout = new EventEmitter();
      childRef.stderr = new EventEmitter();
      childRef.kill = () => {};
      // 永不 emit close：模拟 ffmpeg 挂死
      return childRef;
    };

    const downloader = makeDownloader({
      http: createHttpMock(() => { throw new Error('不应发起请求'); }),
      spawnImpl,
      dir,
      mergeTimeoutMs: 30
    });

    let thrown = null;
    try {
      await downloader.mergeWithFfmpeg([
        ['-i', path.join(dir, `${BV}.video.m4s`)],
        ['-i', path.join(dir, `${BV}.audio.m4s`)]
      ], outputPath);
    } catch (error) {
      thrown = error;
    }

    check(thrown instanceof DownloadError, '超时抛出 DownloadError');
    equal(thrown?.stage, ERROR_STAGES.MERGE, 'stage 为 MERGE');
    equal(thrown?.reason, ERROR_REASONS.FFMPEG_FAILED, '复用 FFMPEG_FAILED 归类');
    equal(thrown?.code, ERROR_CODES.DOWNLOAD_FAILED, 'code 为 DOWNLOAD_FAILED');
    check(thrown?.message.includes('超时'), '错误信息能看出是超时', thrown?.message);
    check(!fs.existsSync(partPath), '半成品 .part 已删除');
    check(!fs.existsSync(outputPath), '没有生成成品文件');
    equal(killCalls.length, 1, 'killProcessTree 被调用一次');
    equal(killCalls[0], childRef, '杀掉的是 ffmpeg 子进程句柄');

    cleanupDir(dir);
  });

  // --- 25. 合并正常路径不受超时改造影响 ---
  await test('mergeWithFfmpeg 正常路径不受影响', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('merge-ok');
    const outputPath = path.join(dir, `${BV}.mp4`);

    const downloader = makeDownloader({
      http: createHttpMock(() => { throw new Error('不应发起请求'); }),
      spawnImpl: createSpawnMock(),
      dir,
      mergeTimeoutMs: 5000
    });

    const returned = await downloader.mergeWithFfmpeg([['-i', `${BV}.video.m4s`], ['-i', `${BV}.audio.m4s`]], outputPath);

    equal(returned, outputPath, '返回输出路径');
    check(fs.existsSync(outputPath), '重命名后的成品存在');
    equal(fs.statSync(outputPath).size, VIDEO_BYTES, '成品大小与 ffmpeg 写出的一致');
    check(!fs.existsSync(`${outputPath}.part`), '.part 已重命名，不残留');
    equal(killCalls.length, 0, '正常路径不杀进程');

    cleanupDir(dir);
  });

  // --- 26. ffprobe 超时：降级返回、不抛错、有 warn ---
  await test('probeHasVideoStream 超时降级为仅体积校验', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('probe-timeout');
    const filePath = path.join(dir, `${BV}.mp4`);
    fs.writeFileSync(filePath, Buffer.alloc(VIDEO_BYTES, 1));

    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      // 永不 emit close：模拟 ffprobe 挂死
      return child;
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));

    let result = null;
    let thrown = null;
    try {
      const downloader = makeDownloader({
        http: createHttpMock(() => { throw new Error('不应发起请求'); }),
        spawnImpl,
        dir,
        probeTimeoutMs: 30
      });
      result = await downloader.probeHasVideoStream(filePath);
    } catch (error) {
      thrown = error;
    } finally {
      console.warn = originalWarn;
    }

    check(!thrown, '探测超时不抛错');
    equal(result?.checked, false, 'checked=false（未完成探测）');
    equal(result?.hasVideo, null, 'hasVideo=null（不当成通过）');
    check(typeof result?.error === 'string' && result.error.includes('超时'), 'error 说明超时', String(result?.error));
    check(
      warnings.some(line => line.includes('ffprobe') && line.includes('30ms')),
      'console.warn 打出 label 与 timeoutMs',
      warnings.join(' | ')
    );
    equal(killCalls.length, 1, '超时的 ffprobe 进程树被终止');

    cleanupDir(dir);
  });

  // --- 27. ffprobe 正常路径不受超时改造影响 ---
  await test('probeHasVideoStream 正常路径不受影响', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('probe-ok');
    const downloader = makeDownloader({
      http: createHttpMock(() => { throw new Error('不应发起请求'); }),
      spawnImpl: createSpawnMock({ onProbe: () => ({ code: 0, stdout: 'video\n' }) }),
      dir,
      probeTimeoutMs: 5000
    });

    const result = await downloader.probeHasVideoStream(path.join(dir, `${BV}.mp4`));

    equal(result.checked, true, '探测完成 checked=true');
    equal(result.hasVideo, true, 'stdout 含 video → hasVideo=true');
    equal(killCalls.length, 0, '正常路径不杀进程');

    cleanupDir(dir);
  });

  // --- 汇总 ---
  console.log('\n========== 测试结果 ==========');
  console.log(`通过断言: ${passed}`);
  console.log(`失败项: ${failures.length}`);
  if (failures.length > 0) {
    console.error('\n失败明细:');
    failures.forEach(item => console.error(`  - ${item}`));
    process.exitCode = 1;
    return;
  }
  console.log('全部通过 ✓');
}

main().catch(error => {
  console.error('测试运行失败:', error);
  process.exitCode = 1;
});
