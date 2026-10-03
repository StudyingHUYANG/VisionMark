'use strict';

/**
 * VideoAnalyzer.cleanup 测试：归属判据（前缀不误伤）/ 清理覆盖 / keep 选项 / 失败容错
 * 以及 debugArtifactWriter.removeArtifactsFor
 *
 * 运行方式: node server/services/videoAnalyzer.cleanup.test.js
 *
 * 不联网、不跑 ffmpeg/python：只在临时目录里造假产物，
 * debug 产物走真实的 server/debug/segment-pipeline（该目录在 .gitignore 里），
 * 用例结束会把测试用的 id 清干净。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VideoAnalyzer = require('./videoAnalyzer');
const { writeDebugArtifacts, removeArtifactsFor, DEBUG_DIR } = require('./segmentPipeline/debugArtifactWriter');

/** 互为前缀的两个 id：这是老实现 startsWith(bvid) 误伤别人的最小复现 */
const BV_A = 'BV1aa';
const BV_B = 'BV1aab';

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

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-cleanup-${name}-`));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/** 该 bvid 全套产物的相对路径（含下载中间产物），用于"一个不少"的精确比对 */
function artifactNames(bvid) {
  return [
    `${bvid}.mp4`,
    `${bvid}.wav`,
    `${bvid}.asr.mp3`,
    `${bvid}.mp4.part`,
    `${bvid}.concat.txt`,
    `${bvid}_frames`,
    `${bvid}_visual_frames`,
    `temp/${bvid}_cookies.txt`
  ].sort();
}

/** 目录下该 bvid 还剩下哪些产物 */
function surviving(dir, bvid) {
  return artifactNames(bvid).filter(rel => fs.existsSync(path.join(dir, rel)));
}

/** 造一整套产物：视频 / wav / 压缩副本 / 下载中间产物 / 两套帧目录 / 临时 cookies */
function seedArtifacts(dir, bvid) {
  for (const rel of artifactNames(bvid)) {
    const target = path.join(dir, rel);
    if (rel.endsWith('_frames') || rel.endsWith('_visual_frames')) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, rel.endsWith('_frames') ? 'frame_001_0.jpg' : 'manifest.json'), '{}');
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(16, 1));
  }
}

function makeAnalyzer(dir) {
  return new VideoAnalyzer(dir, null, {});
}

/** 用例结束务必把测试用的 debug 产物清掉，别污染真实目录 */
function wipeDebugArtifacts(...ids) {
  for (const id of ids) removeArtifactsFor(id);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== VideoAnalyzer.cleanup 测试 ==========');

  await test('前缀不误伤：cleanup(BV1aa) 清光自己的，BV1aab 一个不少', async () => {
    const dir = makeTempDir('prefix');
    seedArtifacts(dir, BV_A);
    seedArtifacts(dir, BV_B);
    const debugA = writeDebugArtifacts({ videoId: BV_A }, {}).artifactPaths[0];
    const debugB = writeDebugArtifacts({ videoId: BV_B }, {}).artifactPaths[0];
    check(Boolean(debugA && fs.existsSync(debugA)), 'BV1aa 的 debug 产物已写入');
    check(Boolean(debugB && fs.existsSync(debugB)), 'BV1aab 的 debug 产物已写入');

    const result = makeAnalyzer(dir).cleanup(BV_A);

    equal(surviving(dir, BV_A).length, 0, 'BV1aa 的产物全部消失', surviving(dir, BV_A).join(','));
    const leftB = surviving(dir, BV_B);
    equal(leftB.length, artifactNames(BV_B).length, 'BV1aab 的产物一个不少', leftB.join(','));
    check(!fs.existsSync(debugA), 'BV1aa 的 debug 产物已删除');
    check(fs.existsSync(debugB), 'BV1aab 的 debug 产物仍在');
    equal(result.debugArtifacts, 1, 'debug 产物计数为 1');

    wipeDebugArtifacts(BV_A, BV_B);
    cleanupDir(dir);
  });

  await test('覆盖完整：单 bvid 全套产物被清干净，removed 数量对得上', async () => {
    const dir = makeTempDir('sweep');
    seedArtifacts(dir, BV_A);
    const debugA = writeDebugArtifacts({ videoId: BV_A }, {}).artifactPaths[0];

    const result = makeAnalyzer(dir).cleanup(BV_A);

    equal(surviving(dir, BV_A).length, 0, '产物全部消失', surviving(dir, BV_A).join(','));
    check(!fs.existsSync(debugA), 'debug 产物已删除');
    // 5 个文件 + 2 个目录 + cookies = 8
    equal(result.removed.length, 8, 'removed 数量与实际删除相符');
    equal(result.failed.length, 0, '没有失败项');
    equal(result.debugArtifacts, 1, 'debug 产物计数为 1');
    check(
      result.removed.some(p => p.endsWith(`${BV_A}_visual_frames`)),
      '视觉帧目录也在清理范围内'
    );

    wipeDebugArtifacts(BV_A);
    cleanupDir(dir);
  });

  await test('keepVideo：视频本体保留，其余照删', async () => {
    const dir = makeTempDir('keep-video');
    seedArtifacts(dir, BV_A);
    const debugA = writeDebugArtifacts({ videoId: BV_A }, {}).artifactPaths[0];

    const result = makeAnalyzer(dir).cleanup(BV_A, { keepVideo: true });

    check(fs.existsSync(path.join(dir, `${BV_A}.mp4`)), '视频本体保留');
    check(!fs.existsSync(path.join(dir, `${BV_A}.wav`)), 'wav 照删');
    check(!fs.existsSync(path.join(dir, `${BV_A}.mp4.part`)), '下载中间产物照删');
    check(!fs.existsSync(path.join(dir, `${BV_A}_frames`)), '关键帧目录照删');
    check(!fs.existsSync(debugA), 'debug 产物照删');
    check(!result.removed.some(p => p.endsWith(`${BV_A}.mp4`)), 'removed 里没有视频本体');

    wipeDebugArtifacts(BV_A);
    cleanupDir(dir);
  });

  await test('keepDebug：debug 产物保留，其余照删', async () => {
    const dir = makeTempDir('keep-debug');
    seedArtifacts(dir, BV_A);
    const debugA = writeDebugArtifacts({ videoId: BV_A }, {}).artifactPaths[0];

    const result = makeAnalyzer(dir).cleanup(BV_A, { keepDebug: true });

    check(fs.existsSync(debugA), 'debug 产物保留');
    equal(result.debugArtifacts, 0, 'keepDebug 时不统计 debug 删除数');
    check(!fs.existsSync(path.join(dir, `${BV_A}.mp4`)), '视频照删');
    check(surviving(dir, BV_A).length === 0, 'debug 之外全部消失', surviving(dir, BV_A).join(','));

    wipeDebugArtifacts(BV_A);
    cleanupDir(dir);
  });

  await test('失败容错：单个文件删不掉时仍正常返回，失败项进 failed', async () => {
    const dir = makeTempDir('failure');
    seedArtifacts(dir, BV_A);
    const locked = path.join(dir, `${BV_A}.wav`);

    // Windows 上文件被占用时 unlink 会 EPERM/EBUSY，但"占用"依赖外部状态；
    // 这里用桩稳定复现同一分支，测的是我们自己的容错，不是桩的行为
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (path.resolve(String(target)) === path.resolve(locked)) {
        const error = new Error('EBUSY: 文件被占用');
        error.code = 'EBUSY';
        throw error;
      }
      return originalUnlinkSync(target);
    };

    let result = null;
    let thrown = null;
    try {
      result = makeAnalyzer(dir).cleanup(BV_A);
    } catch (error) {
      thrown = error;
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    equal(thrown, null, '清理失败不向外抛');
    equal(result?.failed.length, 1, '失败项进了 failed');
    check(result?.failed[0] === locked, 'failed 里就是那个文件', result?.failed.join(','));
    check(fs.existsSync(locked), '删不掉的文件仍然在');
    // 其余 7 项不受影响（5 个文件 + 2 个目录，其中 1 个文件失败）
    equal(result?.removed.length, 7, '其余产物照常删除');
    check(!fs.existsSync(path.join(dir, `${BV_A}_frames`)), '同一轮里别的产物没有被带崩');

    cleanupDir(dir);
  });

  await test('removeArtifactsFor：只删自己的产物，目录不存在返回 0', async () => {
    const debugA = writeDebugArtifacts({ videoId: BV_A }, {}).artifactPaths[0];
    const debugB = writeDebugArtifacts({ videoId: BV_B }, {}).artifactPaths[0];

    equal(removeArtifactsFor(BV_A), 1, '删掉 BV1aa 的 1 个产物');
    check(!fs.existsSync(debugA), 'BV1aa 的产物已删除');
    check(fs.existsSync(debugB), 'BV1aab 的产物没被牵连');
    equal(removeArtifactsFor(BV_A), 0, '重复调用没有可删的，返回 0');

    // 目录不存在时直接返回 0：DEBUG_DIR 是模块常量，只能从 fs.existsSync 这一层注入
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (target) => (
      path.resolve(String(target)) === path.resolve(DEBUG_DIR) ? false : originalExistsSync(target)
    );
    let count = null;
    try {
      count = removeArtifactsFor(BV_B);
      equal(count, 0, '目录不存在返回 0');
    } finally {
      fs.existsSync = originalExistsSync;
      wipeDebugArtifacts(BV_A, BV_B);
    }
    check(fs.existsSync(debugB) === false, '清理后 BV1aab 的产物已收尾');
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
