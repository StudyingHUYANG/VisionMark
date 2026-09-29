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

const VideoAnalyzer = require('./videoAnalyzer');
const BilibiliDownloader = require('./bilibiliDownloader');
const { ERROR_CODES, ERROR_REASONS: REASONS, DownloadError } = BilibiliDownloader;

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

function makeAnalyzer(dir, spawnImpl, downloader) {
  const realDownloader = downloader || new BilibiliDownloader({
    downloadDir: dir,
    spawnImpl,
    ffprobePath: 'ffprobe-mock'
  });
  const analyzer = new VideoAnalyzer(dir, null, { spawnImpl, downloader: realDownloader });
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
