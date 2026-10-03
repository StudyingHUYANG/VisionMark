'use strict';

/**
 * 视觉候选切点 stats / 超时 / 排序稳定性测试
 *
 * 运行方式: node server/services/visualCutDetector.stats.test.js
 *
 * 不调用 Python：只覆盖 stats 组装、超时换算与目录扫描的排序稳定性。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

// 必须在 require visualCutDetector 之前替换 child_process.spawn：
// 模块加载时就解构了 spawn，之后再恢复也不影响它已捕获的引用。
// 这样超时用例能完全不起真实 ffmpeg，只观察定时器行为。
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const spawnCalls = [];
childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  spawnCalls.push({ command, args, options, child });
  return child;
};

const {
  analyzeVisualCuts,
  analyzeSceneCutsWithFfmpeg,
  resolveVisualCutTimeoutMs,
  buildMetricsFusionStats,
  framesFromTimestampedDirectory,
  DEFAULT_VISUAL_CUT_OPTIONS
} = require('./visualCutDetector');

// 恢复进程级 spawn，visualCutDetector 内部仍持有上面的假实现
childProcess.spawn = realSpawn;

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-vcd-${name}-`));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('========== 视觉切点 stats 测试 ==========');

  await test('超时：按帧数缩放，不再固定 120s', async () => {
    equal(resolveVisualCutTimeoutMs(10), 120000, '少帧用下限');
    equal(resolveVisualCutTimeoutMs(900), 225000, '900 帧按 250ms/帧放大');
    equal(resolveVisualCutTimeoutMs(900, { timeoutMs: 5000 }), 5000, '显式 timeoutMs 优先');
    check(
      resolveVisualCutTimeoutMs(3600) > resolveVisualCutTimeoutMs(900),
      '帧数越多给的时间越多，长视频不再必然超时'
    );
  });

  await test('stats：metrics_fusion 路径带齐影响结果的参数', async () => {
    const frames = Array.from({ length: 601 }, (_, index) => ({
      framePath: `C:/tmp/visual_${String(index + 1).padStart(6, '0')}.jpg`,
      time: Number((index / 1).toFixed(3))
    }));

    const stats = buildMetricsFusionStats({
      frames,
      options: {
        probe: { effectiveFps: 1, scaleWidth: 320, sampleFps: 1, durationSource: 'probe', cached: false }
      },
      parsedStats: {
        frameCount: 601,
        transitionCount: 600,
        threshold: 0.71,
        meanScore: 0.42,
        stdScore: 0.21,
        minGapSeconds: 15,
        baseThreshold: 0.55,
        peakStdFactor: 1.35,
        warmupSeconds: 1.5,
        ignoreEndSeconds: 15
      },
      timeoutMs: 150250
    });

    equal(stats.method, 'metrics_fusion', '标记算法路径');
    equal(stats.frameCount, 601, '帧数');
    equal(stats.effectiveFps, 1, '有效 fps');
    equal(stats.scaleWidth, 320, 'scale 宽度');
    equal(stats.threshold, 0.71, '自适应阈值');
    equal(stats.meanScore, 0.42, '分数均值');
    equal(stats.stdScore, 0.21, '分数标准差');
    equal(stats.minGapSeconds, 15, '最小间隔');
    equal(stats.maxCuts, DEFAULT_VISUAL_CUT_OPTIONS.maxCuts, '切点上限（取默认值）');
    equal(stats.timeoutMs, 150250, '本次超时预算');
    equal(stats.durationSource, 'probe', '时长来源');
    equal(stats.ignoreEndSeconds, 15, 'Python 侧其余字段未被丢弃');
  });

  await test('stats：帧数不足时也标明算法路径与参数', async () => {
    const result = await analyzeVisualCuts([
      { framePath: 'C:/tmp/a.jpg', time: 0 }
    ], {});

    equal(result.visualCuts.length, 0, '没有切点');
    equal(result.stats.method, 'metrics_fusion', '标记算法路径');
    equal(result.stats.frameCount, 1, '帧数');
    equal(result.stats.maxCuts, DEFAULT_VISUAL_CUT_OPTIONS.maxCuts, '切点上限');
    check(Number.isFinite(result.stats.timeoutMs), '带超时预算');
  });

  await test('stats：ffmpeg_scene 回退路径一眼可辨', async () => {
    const dir = makeTempDir('scene-missing');
    const result = await analyzeSceneCutsWithFfmpeg(path.join(dir, 'missing.mp4'), {});

    equal(result.stats.method, 'ffmpeg_scene', 'method 标为 ffmpeg_scene');
    equal(result.stats.frameCount, 0, '没有帧');
    equal(result.stats.maxCuts, null, 'ffmpeg 路径没有切点上限');
    equal(result.stats.minGapSeconds, 15, '最小间隔');
    equal(result.visualCuts.length, 0, '没有切点');

    cleanupDir(dir);
  });

  /** 取 ffmpeg 参数里 -vf 后面那串滤镜表达式 */
  function readFilterArg(args) {
    const index = args.indexOf('-vf');
    return index >= 0 ? args[index + 1] : null;
  }

  await test('ffmpeg_scene：sceneThreshold/minGapSeconds 传 null 时回退，不得变成 0', async () => {
    const dir = makeTempDir('scene-options-null');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(64, 1));

    spawnCalls.length = 0;
    const pending = analyzeSceneCutsWithFfmpeg(videoPath, { sceneThreshold: null, minGapSeconds: null });

    equal(spawnCalls.length, 1, '起了一个 ffmpeg 进程');
    equal(
      readFilterArg(spawnCalls[0].args),
      "select='gt(scene,0.32)',showinfo",
      '滤镜阈值是回退值 0.32，而不是 null 被强转出的 0（0 会选中几乎每一帧）'
    );

    spawnCalls[0].child.emit('close', 0);
    const result = await pending;

    equal(result.stats.threshold, 0.32, 'stats.threshold 回退 0.32');
    equal(result.stats.minGapSeconds, 15, 'stats.minGapSeconds 回退 15');
    check(
      result.stats.threshold !== 0 && result.stats.minGapSeconds !== 0,
      '两个字段都不能出现 0'
    );

    cleanupDir(dir);
  });

  await test('ffmpeg_scene：显式合法值被原样采用（不回退）', async () => {
    const dir = makeTempDir('scene-options-explicit');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(64, 1));

    spawnCalls.length = 0;
    const pending = analyzeSceneCutsWithFfmpeg(videoPath, { sceneThreshold: 0.5, minGapSeconds: 8 });

    equal(
      readFilterArg(spawnCalls[0].args),
      "select='gt(scene,0.5)',showinfo",
      '滤镜采用显式阈值 0.5'
    );

    // 两个 scene 变化相隔 9s：8s 最小间隔下都应保留；
    // 若被回退成 0，间隔约束失效的差别不在这里体现，但阈值/统计值会暴露。
    spawnCalls[0].child.stderr.emit('data', 'pts_time:1.000000 ... pts_time:10.000000 ...');
    spawnCalls[0].child.emit('close', 0);
    const result = await pending;

    equal(result.stats.threshold, 0.5, 'stats.threshold 采用显式值');
    equal(result.stats.minGapSeconds, 8, 'stats.minGapSeconds 采用显式值');
    equal(result.visualCuts.length, 2, '9s 间隔大于 8s 的最小间隔，两个切点都保留');

    cleanupDir(dir);
  });

  await test('超时：timeoutMs=null 时回退 120000ms，不会立即超时', async () => {
    const dir = makeTempDir('scene-timeout-null');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(64, 1));

    spawnCalls.length = 0;
    const pending = analyzeSceneCutsWithFfmpeg(videoPath, { timeoutMs: null });

    // 若把 null 当成 0ms，定时器会在下一个宏任务立刻 reject；这里给 100ms 观察窗口
    const raced = await Promise.race([
      pending.then(value => ({ type: 'resolved', value }), error => ({ type: 'error', error })),
      new Promise(resolve => setTimeout(() => resolve({ type: 'pending' }), 100))
    ]);
    equal(raced.type, 'pending', '100ms 内没有被超时打断（0ms 会立刻 reject）');

    equal(spawnCalls.length, 1, '起了且只起了一个 ffmpeg 进程');
    spawnCalls[0].child.emit('close', 0);

    const result = await pending;
    equal(result.stats.timeoutMs, 120000, '超时预算回退到 120000ms');
    equal(result.visualCuts.length, 0, '无 scene 输出时返回空切点');

    cleanupDir(dir);
  });

  await test('排序：同一时间戳的帧按路径稳定排序', async () => {
    const dir = makeTempDir('frames-order');
    // 同名时间戳、不同序号：只有次级排序键能保证两次运行顺序一致
    for (const name of ['frame_002_1000.jpg', 'frame_001_1000.jpg', 'frame_003_500.jpg']) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(8, 1));
    }

    const forward = framesFromTimestampedDirectory(dir);
    const names = forward.map(frame => path.basename(frame.framePath));

    equal(names[0], 'frame_003_500.jpg', '按时间升序');
    equal(names[1], 'frame_001_1000.jpg', '同时间戳按路径升序');
    equal(names[2], 'frame_002_1000.jpg', '同时间戳按路径升序');

    // 再扫一遍必须完全一致
    const again = framesFromTimestampedDirectory(dir).map(frame => path.basename(frame.framePath));
    check(JSON.stringify(again) === JSON.stringify(names), '两次扫描顺序一致', JSON.stringify(again));

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
