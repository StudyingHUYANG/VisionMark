'use strict';

/**
 * VideoAnalyzer 下载策略顺序 / Cookie 降级 / 错误分类 测试
 *
 * 运行方式: node server/services/videoAnalyzer.download.test.js
 *
 * mock 掉 child_process.spawn（python 与 ffprobe/ffmpeg 全部拦截）与 BilibiliDownloader，
 * 只使用本机临时目录，不访问真实网络、不读取真实 Cookie。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// 必须在 require videoAnalyzer / bilibiliDownloader 之前把 killProcessTree 换成记录桩：
// 两个模块都在加载时解构该依赖（同 audioCuts.test.js / bilibiliDownloader.test.js 的手法），
// 晚替换拿到的是真实现，停滞用例会真的执行 taskkill。
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

const VideoAnalyzer = require('./videoAnalyzer');
const BilibiliDownloader = require('./bilibiliDownloader');
const {
  ERROR_CODES,
  ERROR_REASONS: REASONS,
  ERROR_STAGES,
  DownloadError,
  buildUserFacingMessage
} = BilibiliDownloader;

// ---------------------------------------------------------------------------
// 测试脚手架
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

const BV = 'BV1GJ411x7h7';
const VIDEO_BYTES = 48 * 1024;
const RISK_412_STDERR = 'ERROR: HTTP Error 412: Precondition Failed';
const COOKIE_STDERR = 'ERROR: cookies are invalid or expired, login required';

/** spawn mock：同时处理 python(yt-dlp)、ffprobe 与 ffmpeg */
function createSpawnMock(handler = () => ({ code: 0 })) {
  const calls = [];
  const spawnImpl = (cmd, args = [], options = {}) => {
    const call = { cmd, args, options };
    calls.push(call);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    setImmediate(() => {
      const isProbe = String(cmd).includes('ffprobe') || args.includes('-show_entries');

      if (isProbe) {
        child.stdout.emit('data', Buffer.from('video\n'));
        child.emit('close', 0);
        return;
      }

      if (cmd !== 'python') {
        // ffmpeg 合并等
        child.emit('close', 0);
        return;
      }

      const outcome = handler(call, calls.filter(item => item.cmd === 'python').length) || {};
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));

      if ((outcome.code ?? 0) === 0 && outcome.writeFile !== false) {
        const outIndex = args.indexOf('-o');
        const template = outIndex >= 0 ? args[outIndex + 1] : null;
        if (template) {
          fs.writeFileSync(template.replace('%(ext)s', 'mp4'), Buffer.alloc(VIDEO_BYTES, 5));
        }
      }

      child.emit('close', outcome.code ?? 0);
    });

    return child;
  };

  spawnImpl.calls = calls;
  spawnImpl.pythonCalls = () => calls.filter(call => call.cmd === 'python');
  return spawnImpl;
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

/**
 * 只驱动 python(yt-dlp) 生命周期的 spawn mock：ffprobe/ffmpeg 快速成功，
 * python 交给 onPython(child, call, index) 自行控制何时输出/何时结束/是否永远静默，
 * 用于验证停滞看门狗的时间行为。
 */
function createLifetimeSpawnMock(onPython) {
  const calls = [];
  const spawnImpl = (cmd, args = [], options = {}) => {
    const call = { cmd, args, options };
    calls.push(call);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    setImmediate(() => {
      const isProbe = String(cmd).includes('ffprobe') || args.includes('-show_entries');
      if (isProbe) {
        child.stdout.emit('data', Buffer.from('video\n'));
        child.emit('close', 0);
        return;
      }
      if (cmd !== 'python') {
        child.emit('close', 0);
        return;
      }
      const pythonIndex = calls.filter(item => item.cmd === 'python').length; // 1-based
      onPython(child, call, pythonIndex);
    });

    return child;
  };

  spawnImpl.calls = calls;
  spawnImpl.pythonCalls = () => calls.filter(call => call.cmd === 'python');
  return spawnImpl;
}

/** 按 yt-dlp 的 -o 模板写出产出文件，模拟一次成功下载 */
function writeYtDlpOutput(args) {
  const outIndex = args.indexOf('-o');
  const template = outIndex >= 0 ? args[outIndex + 1] : null;
  if (template) {
    fs.writeFileSync(template.replace('%(ext)s', 'mp4'), Buffer.alloc(VIDEO_BYTES, 5));
  }
}

function describeYtDlpCall(call) {
  const extractorArg = argValue(call.args, '--extractor-args') || '';
  return {
    withCookie: call.args.includes('--cookies'),
    useWbi: extractorArg.includes('use_wbi=true')
  };
}

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-va-${name}-`));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function writeCookieFile(dir) {
  const cookiePath = path.join(dir, 'cookies.txt');
  fs.writeFileSync(
    cookiePath,
    '# Netscape HTTP Cookie File\n'
    + `.bilibili.com\tTRUE\t/\tFALSE\t${Math.floor(Date.now() / 1000) + 86400}\tSESSDATA\tLEAK_CANARY_VALUE\n`,
    'utf8'
  );
  return cookiePath;
}

function makeAnalyzer(dir, spawnImpl, downloader, analyzerOptions = {}) {
  const realDownloader = downloader || new BilibiliDownloader({
    downloadDir: dir,
    spawnImpl,
    ffprobePath: 'ffprobe-mock'
  });
  const analyzer = new VideoAnalyzer(dir, null, { spawnImpl, downloader: realDownloader, ...analyzerOptions });
  analyzer.realDownloader = realDownloader;
  return analyzer;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== VideoAnalyzer 下载链路测试 ==========');

  // --- Y1: yt-dlp 内 Cookie → 匿名 降级顺序 ---
  await test('yt-dlp 按 Cookie → 匿名 顺序降级', async () => {
    const dir = makeTempDir('ytdlp-order');
    const cookiePath = writeCookieFile(dir);

    const spawnImpl = createSpawnMock((call) => {
      const { withCookie, useWbi } = describeYtDlpCall(call);
      // 带 Cookie 的两种参数都吃 412；匿名首次成功
      if (withCookie) return { code: 1, stderr: RISK_412_STDERR };
      return { code: 0, stderr: '' };
    });

    const analyzer = makeAnalyzer(dir, spawnImpl);
    const onAttempt = [];
    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {
      onAttempt: entry => onAttempt.push(entry)
    });

    check(fs.existsSync(outputPath), '最终产出视频文件');

    const plan = spawnImpl.pythonCalls().map(describeYtDlpCall);
    equal(plan.length, 3, '共执行 3 次 yt-dlp');
    equal(plan[0].withCookie, true, '第 1 次带 Cookie');
    equal(plan[0].useWbi, true, '第 1 次 use_wbi=true');
    equal(plan[1].withCookie, true, '第 2 次仍带 Cookie（412 兼容重试）');
    equal(plan[1].useWbi, false, '第 2 次 use_wbi=false');
    equal(plan[2].withCookie, false, '第 3 次改为匿名');
    equal(plan[2].useWbi, true, '第 3 次匿名 use_wbi=true');

    equal(onAttempt.filter(entry => entry.ok).length, 1, '只有一次成功尝试');
    check(onAttempt.some(entry => entry.code === ERROR_CODES.RISK_CONTROL_412), '记录了 412 失败尝试');

    cleanupDir(dir);
  });

  // --- Y2: yt-dlp 全部 412 ---
  await test('yt-dlp 所有尝试均 412 → RISK_CONTROL_412', async () => {
    const dir = makeTempDir('ytdlp-412');
    const cookiePath = writeCookieFile(dir);

    const spawnImpl = createSpawnMock(() => ({ code: 1, stderr: RISK_412_STDERR }));
    const analyzer = makeAnalyzer(dir, spawnImpl);

    try {
      await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});
      check(false, '全 412 场景应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.RISK_CONTROL_412, '错误码为 RISK_CONTROL_412');
      check(error.retryable === true, '标记为可重试');
      check(error.attempts.length >= 3, '记录了全部尝试', String(error.attempts?.length));
    }

    check(!fs.existsSync(path.join(dir, `${BV}.mp4`)), '不留下半成品');
    equal(spawnImpl.pythonCalls().length, 4, '尝试次数有上限（4 次）');

    cleanupDir(dir);
  });

  // --- Y3: Cookie 失效时跳过剩余 Cookie 重试 ---
  await test('Cookie 失效时不再重复 Cookie 路径', async () => {
    const dir = makeTempDir('ytdlp-cookie-dead');
    const cookiePath = writeCookieFile(dir);

    const spawnImpl = createSpawnMock((call) => {
      const { withCookie } = describeYtDlpCall(call);
      if (withCookie) return { code: 1, stderr: COOKIE_STDERR };
      return { code: 0, stderr: '' };
    });

    const analyzer = makeAnalyzer(dir, spawnImpl);
    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});

    check(fs.existsSync(outputPath), '匿名路径成功');
    const plan = spawnImpl.pythonCalls().map(describeYtDlpCall);
    equal(plan.length, 2, '共 2 次：一次 Cookie、一次匿名');
    equal(plan.filter(item => item.withCookie).length, 1, 'Cookie 路径只尝试一次');

    cleanupDir(dir);
  });

  // --- Y4: 无 Cookie 时直接匿名 ---
  await test('无 Cookie 时直接走匿名路径', async () => {
    const dir = makeTempDir('ytdlp-no-cookie');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));
    const analyzer = makeAnalyzer(dir, spawnImpl);

    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});

    check(fs.existsSync(outputPath), '匿名下载成功');
    const plan = spawnImpl.pythonCalls().map(describeYtDlpCall);
    equal(plan.length, 1, '只执行一次');
    equal(plan[0].withCookie, false, '未携带 Cookie');

    cleanupDir(dir);
  });

  // --- Y5: 输出必须 remux 为 mp4 ---
  await test('yt-dlp 参数强制 remux 为 mp4', async () => {
    const dir = makeTempDir('ytdlp-remux');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));
    const analyzer = makeAnalyzer(dir, spawnImpl);

    await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});

    const first = spawnImpl.pythonCalls()[0];
    check(first.args.includes('--remux-video'), '包含 --remux-video');
    equal(argValue(first.args, '--remux-video'), 'mp4', '--remux-video mp4');

    cleanupDir(dir);
  });

  // --- Y5b: yt-dlp 参数包含 --socket-timeout ---
  await test('yt-dlp 参数包含 --socket-timeout 30', async () => {
    const dir = makeTempDir('ytdlp-socket-timeout');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));
    const analyzer = makeAnalyzer(dir, spawnImpl);

    await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});

    const first = spawnImpl.pythonCalls()[0];
    check(first.args.includes('--socket-timeout'), '包含 --socket-timeout');
    equal(argValue(first.args, '--socket-timeout'), '30', 'socket 读超时为 30 秒');
    equal(VideoAnalyzer.YT_DLP_SOCKET_TIMEOUT_SECONDS, 30, '常量与命令行参数保持一致');

    cleanupDir(dir);
  });

  // --- S1: 完全静默 → 判定停滞、杀进程树、错误可重试 ---
  await test('yt-dlp 长时间无输出 → 判定停滞并终止进程树', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('ytdlp-stall');
    let ytDlpChild = null;

    const spawnImpl = createLifetimeSpawnMock((child) => {
      ytDlpChild = child;
      // 先吐一行进度（应重置看门狗），随后永久静默：不 emit close
      child.stdout.emit('data', Buffer.from('[download]  50.0% of 10.00MiB\n'));
    });

    const analyzer = makeAnalyzer(dir, spawnImpl, null, { stallTimeoutMs: 60 });

    let thrown = null;
    try {
      await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});
    } catch (error) {
      thrown = error;
    }

    check(Boolean(thrown), '停滞时抛出错误');
    equal(thrown?.reason, REASONS.PROCESS_STALLED, '归类为 PROCESS_STALLED');
    equal(thrown?.code, ERROR_CODES.DOWNLOAD_FAILED, 'code 为 DOWNLOAD_FAILED');
    equal(thrown?.stage, ERROR_STAGES.YT_DLP, 'stage 为 yt_dlp');
    check(thrown?.retryable === true, '标记为可重试，后续策略仍会被尝试');
    check(Boolean(thrown?.message) && thrown.message.includes('无任何输出'), '错误信息能看出是停滞', thrown?.message);
    equal(killCalls.length, 1, 'killProcessTree 被调用一次');
    equal(killCalls[0], ytDlpChild, '杀掉的是 yt-dlp 子进程句柄');

    cleanupDir(dir);
  });

  // --- S2: 持续有输出 → 不因总时长超过阈值被误杀（防"误杀正常长下载"回归） ---
  await test('yt-dlp 持续输出时不会被停滞看门狗误杀', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('ytdlp-alive');
    const stallMs = 60;
    const intervalMs = 20;
    const ticks = 10; // 总时长约 200ms，明显超过 60ms 阈值

    const spawnImpl = createLifetimeSpawnMock((child, call) => {
      let remaining = ticks;
      const tick = () => {
        if (remaining > 0) {
          remaining -= 1;
          // 每次输出间隔都小于停滞阈值 → 看门狗应被持续重置
          child.stderr.emit('data', Buffer.from('[download]  10.0% of 1.00MiB\n'));
          setTimeout(tick, intervalMs);
          return;
        }
        writeYtDlpOutput(call.args);
        child.emit('close', 0);
      };
      tick();
    });

    const analyzer = makeAnalyzer(dir, spawnImpl, null, { stallTimeoutMs: stallMs });
    const startedAt = Date.now();
    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});
    const elapsed = Date.now() - startedAt;

    check(elapsed > stallMs, '总时长明显超过停滞阈值', `${elapsed}ms > ${stallMs}ms`);
    check(elapsed >= intervalMs * ticks, '持续输出的总时长符合预期', `${elapsed}ms`);
    equal(killCalls.length, 0, '持续有输出时不会被误杀');
    check(fs.existsSync(outputPath), '正常产出视频文件');

    cleanupDir(dir);
  });

  // --- S3: 首次尝试停滞 → 后续策略仍被尝试并成功 ---
  await test('首次尝试停滞后策略降级仍然生效', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('ytdlp-stall-fallback');
    const cookiePath = writeCookieFile(dir);

    const spawnImpl = createLifetimeSpawnMock((child, call, index) => {
      if (index === 1) {
        // Cookie 路径停滞：一行输出后永久静默
        child.stderr.emit('data', Buffer.from('[download]   0.5% of 100.00MiB\n'));
        return;
      }
      // 匿名策略正常完成
      child.stdout.emit('data', Buffer.from('[download] 100.0% of 100.00MiB\n'));
      writeYtDlpOutput(call.args);
      child.emit('close', 0);
    });

    const analyzer = makeAnalyzer(dir, spawnImpl, null, { stallTimeoutMs: 60 });
    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});

    const plan = spawnImpl.pythonCalls().map(describeYtDlpCall);
    equal(plan.length, 2, '停滞后的匿名策略仍被尝试');
    equal(plan[0].withCookie, true, '第 1 次为 Cookie 策略');
    equal(plan[0].useWbi, true, '第 1 次 use_wbi=true');
    equal(plan[1].withCookie, false, '第 2 次降级为匿名策略');
    check(fs.existsSync(outputPath), '降级后下载成功');
    equal(killCalls.length, 1, '只有停滞的那次被终止进程树');

    cleanupDir(dir);
  });

  // --- S4: 所有尝试都停滞 → finalizeDownloadError 仍归类为 PROCESS_STALLED ---
  await test('所有尝试都停滞时最终错误分类正确且文案可读', async () => {
    killCalls.length = 0;
    const dir = makeTempDir('ytdlp-all-stall');
    const cookiePath = writeCookieFile(dir);

    const spawnImpl = createLifetimeSpawnMock((child) => {
      // 每次尝试都是"一行输出后永久静默"
      child.stderr.emit('data', Buffer.from('[download]   0.5% of 100.00MiB\n'));
    });

    const analyzer = makeAnalyzer(dir, spawnImpl, null, { stallTimeoutMs: 40 });

    let thrown = null;
    try {
      await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});
    } catch (error) {
      thrown = error;
    }

    equal(thrown?.reason, REASONS.PROCESS_STALLED, '最终 reason 仍为 PROCESS_STALLED');
    equal(thrown?.code, ERROR_CODES.DOWNLOAD_FAILED, '最终 code 为 DOWNLOAD_FAILED');
    check(thrown?.retryable === true, '最终仍标记为可重试');
    check(thrown?.attempts.length >= 2, '记录了 Cookie 与匿名两次尝试', String(thrown?.attempts?.length));
    check(thrown.attempts.every(entry => entry.reason === REASONS.PROCESS_STALLED), '每次尝试都归类为停滞');
    equal(killCalls.length, 2, '两次停滞各终止一次进程树');
    check(
      buildUserFacingMessage(thrown).includes('没有任何输出'),
      '用户文案不是笼统的"下载失败"',
      buildUserFacingMessage(thrown)
    );

    cleanupDir(dir);
  });

  // --- Y6: yt-dlp 失败不留下残缺文件 ---
  await test('yt-dlp 失败后不留下文件', async () => {
    const dir = makeTempDir('ytdlp-nofile');
    const spawnImpl = createSpawnMock((call) => {
      // 退出码 0 但没有产出文件，模拟异常中断
      return { code: 0, writeFile: false, stderr: '' };
    });
    const analyzer = makeAnalyzer(dir, spawnImpl);

    try {
      await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});
      check(false, '没有产出文件时应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.DOWNLOAD_FAILED, '归类为 DOWNLOAD_FAILED');
      equal(error.reason, REASONS.FILE_NOT_FOUND, '原因为 FILE_NOT_FOUND');
    }

    check(!fs.existsSync(path.join(dir, `${BV}.mp4`)), '没有残缺文件');
    cleanupDir(dir);
  });

  // --- H1: 混合策略顺序 B 站 → yt-dlp ---
  await test('混合策略：B 站失败后回退 yt-dlp', async () => {
    const dir = makeTempDir('hybrid-order');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));

    const order = [];
    const stubDownloader = {
      downloadVideo: async () => {
        order.push('bilibili');
        throw new DownloadError({
          code: ERROR_CODES.DOWNLOAD_FAILED,
          reason: REASONS.NETWORK_ERROR,
          stage: 'download',
          retryable: true
        });
      },
      isUsableCache: async () => false,
      validateVideoFile: async () => ({ size: VIDEO_BYTES, probed: false })
    };

    const analyzer = makeAnalyzer(dir, spawnImpl, stubDownloader);
    const outputPath = await analyzer.downloadVideoHybrid(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});

    order.push('yt_dlp');
    check(fs.existsSync(outputPath), '回退 yt-dlp 后成功');
    equal(order[0], 'bilibili', '先尝试 B 站接口');
    check(spawnImpl.pythonCalls().length === 1, '随后调用了一次 yt-dlp');

    cleanupDir(dir);
  });

  // --- H2: 混合策略全 412 ---
  await test('混合策略：全路径 412 → RISK_CONTROL_412', async () => {
    const dir = makeTempDir('hybrid-412');
    const cookiePath = writeCookieFile(dir);
    const spawnImpl = createSpawnMock(() => ({ code: 1, stderr: RISK_412_STDERR }));

    const stubDownloader = {
      downloadVideo: async (url, onProgress, options) => {
        // 模拟 BilibiliDownloader：Cookie 与匿名都 412
        if (options?.onAttempt) {
          options.onAttempt({ strategy: 'bilibili_api', withCookie: true, ok: false, code: ERROR_CODES.RISK_CONTROL_412, reason: REASONS.HTTP_412, stage: 'video_info' });
          options.onAttempt({ strategy: 'bilibili_api_anonymous', withCookie: false, ok: false, code: ERROR_CODES.RISK_CONTROL_412, reason: REASONS.HTTP_412, stage: 'video_info' });
        }
        throw new DownloadError({ code: ERROR_CODES.RISK_CONTROL_412, reason: REASONS.HTTP_412, stage: 'video_info', retryable: true });
      },
      isUsableCache: async () => false,
      validateVideoFile: async () => ({ size: VIDEO_BYTES, probed: false })
    };

    const analyzer = makeAnalyzer(dir, spawnImpl, stubDownloader);

    try {
      await analyzer.downloadVideoHybrid(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});
      check(false, '全 412 应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.RISK_CONTROL_412, '最终错误码为 RISK_CONTROL_412');
      check(error.message.includes('风控'), 'message 可操作', error.message);
      check(error.attempts.length >= 4, '汇总了所有策略的尝试记录', String(error.attempts?.length));
    }

    cleanupDir(dir);
  });

  // --- H3: 视频不可访问时不进入 yt-dlp ---
  await test('混合策略：不可访问视频不进入 yt-dlp', async () => {
    const dir = makeTempDir('hybrid-inaccessible');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));

    const stubDownloader = {
      downloadVideo: async () => {
        throw new DownloadError({
          code: ERROR_CODES.VIDEO_INACCESSIBLE,
          reason: REASONS.VIDEO_DELETED,
          stage: 'video_info',
          retryable: false
        });
      },
      isUsableCache: async () => false,
      validateVideoFile: async () => ({ size: VIDEO_BYTES, probed: false })
    };

    const analyzer = makeAnalyzer(dir, spawnImpl, stubDownloader);

    try {
      await analyzer.downloadVideoHybrid(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});
      check(false, '不可访问应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.VIDEO_INACCESSIBLE, '错误码为 VIDEO_INACCESSIBLE');
    }

    equal(spawnImpl.pythonCalls().length, 0, '没有进入 yt-dlp 重试');
    cleanupDir(dir);
  });

  // --- H4: 非法输入不进入 yt-dlp ---
  await test('混合策略：INVALID_INPUT 立即中止', async () => {
    const dir = makeTempDir('hybrid-invalid');
    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));

    const stubDownloader = {
      downloadVideo: async () => {
        throw new DownloadError({
          code: ERROR_CODES.INVALID_INPUT,
          reason: REASONS.INVALID_BVID,
          stage: 'video_info',
          retryable: false
        });
      },
      isUsableCache: async () => false,
      validateVideoFile: async () => ({ size: VIDEO_BYTES, probed: false })
    };

    const analyzer = makeAnalyzer(dir, spawnImpl, stubDownloader);

    try {
      await analyzer.downloadVideoHybrid(BV, 'bad-url', null, null, {});
      check(false, '非法输入应当失败');
    } catch (error) {
      equal(error.code, ERROR_CODES.INVALID_INPUT, '错误码为 INVALID_INPUT');
    }

    equal(spawnImpl.pythonCalls().length, 0, '没有进入 yt-dlp');
    cleanupDir(dir);
  });

  // --- H5: 损坏缓存不被复用 ---
  await test('损坏的缓存文件不被复用为成功结果', async () => {
    const dir = makeTempDir('hybrid-cache');
    fs.writeFileSync(path.join(dir, `${BV}.mp4`), Buffer.alloc(32, 0)); // 明显不完整的假缓存

    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));
    const analyzer = makeAnalyzer(dir, spawnImpl);

    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});

    equal(fs.statSync(outputPath).size, VIDEO_BYTES, '重新下载为完整文件');
    equal(spawnImpl.pythonCalls().length, 1, '确实重新下载了');

    cleanupDir(dir);
  });

  // --- H6: yt-dlp stderr 中的 Cookie 被脱敏 ---
  await test('yt-dlp stderr 中的 Cookie 明文被脱敏', async () => {    const dir = makeTempDir('hybrid-scrub');
    const cookiePath = writeCookieFile(dir);
    const canary = 'LEAK_CANARY_VALUE';

    const captured = [];
    const originals = { warn: console.warn, error: console.error, log: console.log };
    console.warn = (...args) => captured.push(args.map(String).join(' '));
    console.error = (...args) => captured.push(args.map(String).join(' '));
    console.log = (...args) => captured.push(args.map(String).join(' '));

    let thrown = null;
    try {
      const spawnImpl = createSpawnMock(() => ({
        code: 1,
        stderr: `ERROR: cookie header rejected: SESSDATA=${canary}`
      }));
      const analyzer = makeAnalyzer(dir, spawnImpl);
      await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, cookiePath, {});
    } catch (error) {
      thrown = error;
    } finally {
      console.warn = originals.warn;
      console.error = originals.error;
      console.log = originals.log;
    }

    check(Boolean(thrown), '确实失败并抛出错误');
    check(!captured.join('\n').includes(canary), '日志中不含 Cookie 明文');
    check(
      !JSON.stringify({ message: thrown.message, attempts: thrown.attempts }).includes(canary),
      '错误对象中不含 Cookie 明文'
    );

    cleanupDir(dir);
  });

  // --- H6b: 中途产物不能被当成整片缓存 ---
  await test('durl 中间分片不被当成整片缓存', async () => {
    const dir = makeTempDir('stale-part-cache');
    // 模拟「多分片下载中途被杀」：只剩一个中间分片，没有规范的 {bvid}.mp4
    fs.writeFileSync(path.join(dir, `${BV}.durl-1.mp4`), Buffer.alloc(VIDEO_BYTES, 4));

    const spawnImpl = createSpawnMock(() => ({ code: 0, stderr: '' }));

    // 用 mock http 走 B 站接口路径，保持确定性
    const http = async (config) => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO_BYTES) },
      data: require('stream').Readable.from([Buffer.alloc(VIDEO_BYTES, 8)])
    });
    http.get = async (url) => {
      if (url.includes('/view')) {
        return { status: 200, data: { code: 0, message: 'OK', data: { bvid: BV, pages: [{ cid: 1 }] } } };
      }
      return {
        status: 200,
        data: {
          code: 0,
          message: 'OK',
          data: { quality: 64, durl: [{ order: 1, size: VIDEO_BYTES, url: 'https://cdn.test/part.mp4' }] }
        }
      };
    };

    const downloader = new BilibiliDownloader({ downloadDir: dir, http, spawnImpl, ffprobePath: 'ffprobe-mock' });
    const analyzer = makeAnalyzer(dir, spawnImpl, downloader);

    const hit = await analyzer.findUsableCachedVideo(BV);
    equal(hit, null, '中间分片不被识别为缓存');

    const outputPath = await analyzer.downloadVideo(BV, `https://www.bilibili.com/video/${BV}`, null, null, {});
    equal(path.basename(outputPath), `${BV}.mp4`, '产出规范文件名');
    check(!fs.existsSync(path.join(dir, `${BV}.durl-1.mp4`)), '残留中间分片已被清理');

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
