'use strict';

/**
 * 真实网络冒烟测试：验证 B 站下载链路与错误分类。
 *
 * 运行方式:
 *   node server/scripts/smokeDownload.js
 *
 * 可用环境变量覆盖测试目标（不要在代码里写死视频号）:
 *   VM_SMOKE_BVID          公开视频 BV 号，默认 BV1GJ411x7h7
 *   VM_SMOKE_MISSING_BVID  不存在的 BV 号，默认 BV1xx411c7mZ
 *   VM_SMOKE_KEEP_FILES    设为 1 时保留下载文件便于排查
 *
 * 不会读取也不会打印任何真实 Cookie；失效 Cookie 场景使用临时生成的过期文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BilibiliDownloader = require('../services/bilibiliDownloader');
const VideoAnalyzer = require('../services/videoAnalyzer');
const { ERROR_CODES, ERROR_REASONS } = BilibiliDownloader;

const PUBLIC_BVID = process.env.VM_SMOKE_BVID || 'BV1GJ411x7h7';
const MISSING_BVID = process.env.VM_SMOKE_MISSING_BVID || 'BV1xx411c7mZ';
const KEEP_FILES = process.env.VM_SMOKE_KEEP_FILES === '1';

const results = [];

function record(scenario, status, detail) {
  results.push({ scenario, status, detail });
  const icon = status === 'PASS' ? '✓' : (status === 'SKIP' ? '○' : '✗');
  console.log(`${icon} ${scenario}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function makeWorkDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-smoke-${name}-`));
}

function cleanup(dir) {
  if (KEEP_FILES) {
    console.log(`   （保留文件，目录: ${dir}）`);
    return;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function listResidue(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function writeExpiredCookieFile(dir) {
  const cookiePath = path.join(dir, 'expired-cookies.txt');
  fs.writeFileSync(
    cookiePath,
    '# Netscape HTTP Cookie File\n'
    + `.bilibili.com\tTRUE\t/\tFALSE\t1000000000\tSESSDATA\tEXPIRED_PLACEHOLDER\n`
    + `.bilibili.com\tTRUE\t/\tFALSE\t1000000000\tbili_jct\tEXPIRED_PLACEHOLDER\n`,
    'utf8'
  );
  return cookiePath;
}

async function scenarioAnonymousDownload() {
  console.log(`\n--- 场景 1：匿名下载公开视频 (${PUBLIC_BVID}) ---`);
  const dir = makeWorkDir('anon');
  try {
    const downloader = new BilibiliDownloader({ downloadDir: dir });
    const attempts = [];
    const outputPath = await downloader.downloadVideo(
      `https://www.bilibili.com/video/${PUBLIC_BVID}`,
      progress => console.log(`   [progress] ${progress.stage} ${progress.percent}% ${progress.message}`),
      { onAttempt: entry => attempts.push(entry) }
    );

    const stat = fs.statSync(outputPath);
    if (stat.size <= 0) throw new Error('文件为空');
    record('匿名下载公开视频', 'PASS', `${(stat.size / 1024 / 1024).toFixed(2)} MB，尝试记录 ${attempts.length} 条`);
    return { ok: true, size: stat.size };
  } catch (error) {
    record('匿名下载公开视频', 'FAIL', `${error.code || ''} ${error.reason || ''} ${error.message}`.trim());
    return { ok: false, error };
  } finally {
    cleanup(dir);
  }
}

async function scenarioExpiredCookieFallback() {
  console.log(`\n--- 场景 2：失效 Cookie 降级为匿名 (${PUBLIC_BVID}) ---`);
  const dir = makeWorkDir('expired-cookie');
  try {
    const cookiePath = writeExpiredCookieFile(dir);
    const downloader = new BilibiliDownloader({ downloadDir: dir });
    const attempts = [];
    const outputPath = await downloader.downloadVideo(
      `https://www.bilibili.com/video/${PUBLIC_BVID}`,
      null,
      { cookiesPath: cookiePath, onAttempt: entry => attempts.push(entry) }
    );

    const stat = fs.statSync(outputPath);
    const recordedExpiry = attempts.some(entry => entry.reason === ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED);
    record(
      '失效 Cookie 降级为匿名',
      'PASS',
      `下载成功 ${(stat.size / 1024 / 1024).toFixed(2)} MB；记录 COOKIE_INVALID_OR_EXPIRED=${recordedExpiry}`
    );
    return { ok: true };
  } catch (error) {
    record('失效 Cookie 降级为匿名', 'FAIL', `${error.code || ''} ${error.reason || ''} ${error.message}`.trim());
    return { ok: false, error };
  } finally {
    cleanup(dir);
  }
}

async function scenarioInaccessibleVideo() {
  console.log(`\n--- 场景 3：不存在的视频 → VIDEO_INACCESSIBLE (${MISSING_BVID}) ---`);
  const dir = makeWorkDir('missing');
  try {
    const downloader = new BilibiliDownloader({ downloadDir: dir });
    await downloader.downloadVideo(`https://www.bilibili.com/video/${MISSING_BVID}`, null, {});
    record('不存在视频的错误分类', 'FAIL', '本应失败却成功了');
    return { ok: false };
  } catch (error) {
    const code = error.code;
    const residue = listResidue(dir);
    if (code === ERROR_CODES.VIDEO_INACCESSIBLE) {
      record('不存在视频的错误分类', 'PASS', `code=${code} reason=${error.reason}，残留文件 ${residue.length} 个`);
      return { ok: true };
    }
    record('不存在视频的错误分类', 'FAIL', `期望 VIDEO_INACCESSIBLE，实际 ${code}/${error.reason}`);
    return { ok: false };
  } finally {
    cleanup(dir);
  }
}

async function scenarioInvalidInput() {
  console.log('\n--- 场景 4：非法 BV / URL → INVALID_INPUT ---');
  const dir = makeWorkDir('invalid');
  try {
    const downloader = new BilibiliDownloader({ downloadDir: dir });
    const outcomes = [];
    for (const bad of ['', 'https://www.bilibili.com/video/av12345', 'BV1AAAAAAAAA']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await downloader.downloadVideo(bad, null, {});
        outcomes.push(`${JSON.stringify(bad)}:未抛错`);
      } catch (error) {
        outcomes.push(`${JSON.stringify(bad)}:${error.code}`);
      }
    }
    const allInvalid = outcomes.every(item => item.endsWith(`:${ERROR_CODES.INVALID_INPUT}`));
    record('非法输入的 error code', allInvalid ? 'PASS' : 'FAIL', outcomes.join(', '));
    return { ok: allInvalid };
  } finally {
    cleanup(dir);
  }
}

async function scenarioNoResidueOnFailure() {
  console.log('\n--- 场景 5：失败后不留半成品 ---');
  const dir = makeWorkDir('residue');
  try {
    const downloader = new BilibiliDownloader({ downloadDir: dir });
    try {
      await downloader.downloadVideo(`https://www.bilibili.com/video/${MISSING_BVID}`, null, {});
    } catch (_) { /* 预期失败 */ }

    const residue = listResidue(dir);
    const bad = residue.filter(file => file.endsWith('.mp4') || file.endsWith('.part'));
    record('失败后无残留文件', bad.length === 0 ? 'PASS' : 'FAIL', `残留: ${JSON.stringify(bad)}`);
    return { ok: bad.length === 0 };
  } finally {
    cleanup(dir);
  }
}

async function scenarioHybridEntryPoint() {
  console.log(`\n--- 场景 6：生产入口 VideoAnalyzer.downloadVideoHybrid (${PUBLIC_BVID}) ---`);
  const dir = makeWorkDir('hybrid');
  try {
    // 这是 analyzeVideo 实际调用的入口，验证它同样能跑通
    const analyzer = new VideoAnalyzer(dir, null);
    const outputPath = await analyzer.downloadVideoHybrid(
      PUBLIC_BVID,
      `https://www.bilibili.com/video/${PUBLIC_BVID}`,
      null,
      null,
      {}
    );

    const stat = fs.statSync(outputPath);
    if (stat.size <= 0) throw new Error('文件为空');
    record('生产入口 downloadVideoHybrid', 'PASS', `${(stat.size / 1024 / 1024).toFixed(2)} MB`);
    return { ok: true };
  } catch (error) {
    record('生产入口 downloadVideoHybrid', 'FAIL', `${error.code || ''} ${error.reason || ''} ${error.message}`.trim());
    return { ok: false, error };
  } finally {
    cleanup(dir);
  }
}

async function main() {
  console.log('========== B 站下载链路真实网络冒烟测试 ==========');
  console.log(`公开视频: ${PUBLIC_BVID}`);
  console.log(`不存在视频: ${MISSING_BVID}`);

  const outcomes = [];
  outcomes.push(await scenarioAnonymousDownload());
  outcomes.push(await scenarioExpiredCookieFallback());
  outcomes.push(await scenarioInaccessibleVideo());
  outcomes.push(await scenarioInvalidInput());
  outcomes.push(await scenarioNoResidueOnFailure());
  outcomes.push(await scenarioHybridEntryPoint());

  console.log('\n========== 汇总 ==========');
  for (const item of results) {
    console.log(`[${item.status}] ${item.scenario} — ${item.detail}`);
  }

  const failed = outcomes.filter(item => !item.ok).length;
  console.log(`\n失败场景数: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  console.error('冒烟测试运行失败:', error);
  process.exitCode = 1;
});
