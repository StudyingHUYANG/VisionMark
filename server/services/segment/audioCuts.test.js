/**
 * 音频切点检测测试
 *
 * 运行方式: node server/services/segment/audioCuts.test.js
 *
 * 测试内容:
 * 1. 参数/错误处理
 * 2. 子命令超时：reject 错误码、进程树收尾、超时策略、正常返回清理定时器
 * 3. 静音检测与音量检测（需 downloads 下有真实 .wav，缺失则跳过）
 *
 * 超时用例全部注入 exec 桩，不启动真实 ffmpeg。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// 必须在 require audioCuts 之前把 killProcessTree 换成记录桩：
// audioCuts 在模块加载时 require 它，晚替换拿到的是真实现，超时用例会真的 taskkill。
// ---------------------------------------------------------------------------
const KILL_PROCESS_TREE_PATH = require.resolve('../../utils/killProcessTree');
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

const {
  detectAudioCuts,
  execWithTimeout,
  resolveAudioCutsTimeoutMs,
  AUDIO_CUTS_TIMEOUT_POLICIES
} = require('./audioCuts');

const DOWNLOADS_DIR = path.join(__dirname, '../../../downloads');

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

// ---------------------------------------------------------------------------
// exec 桩
// ---------------------------------------------------------------------------

/** 记录调用但永不回调，模拟 ffmpeg 挂死 */
function makeHangingExec() {
  const calls = [];
  const execImpl = (command, opts) => {
    const child = { pid: 10000 + calls.length };
    calls.push({ command, opts, child });
    return child;
  };
  execImpl.calls = calls;
  return execImpl;
}

/** 记录调用并异步回调成功结果 */
function makeSucceedingExec(stdout = '', stderr = '') {
  const calls = [];
  const execImpl = (command, opts, cb) => {
    const child = { pid: 20000 + calls.length };
    calls.push({ command, opts, child });
    setImmediate(() => cb(null, stdout, stderr));
    return child;
  };
  execImpl.calls = calls;
  return execImpl;
}

// ---------------------------------------------------------------------------
// 超时用例
// ---------------------------------------------------------------------------

async function testExecWithTimeoutReject() {
  await test('execWithTimeout：超时 reject AUDIO_CUTS_TIMEOUT 且带 label/timeoutMs', async () => {
    const execImpl = makeHangingExec();
    const startedAt = Date.now();

    let error = null;
    try {
      await execWithTimeout('"ffmpeg" -i fake.wav -af silencedetect -f null -', {
        label: 'silencedetect',
        timeoutMs: 30,
        execImpl
      });
    } catch (e) {
      error = e;
    }

    check(error !== null, '应当 reject');
    equal(error?.code, 'AUDIO_CUTS_TIMEOUT', '错误码为 AUDIO_CUTS_TIMEOUT');
    equal(error?.label, 'silencedetect', '错误带 label');
    equal(error?.timeoutMs, 30, '错误带 timeoutMs');
    check(Date.now() - startedAt < 5000, '用注入的短超时触发，而不是等 120 秒下限');
  });
}

async function testTimeoutKillsProcessTree() {
  await test('execWithTimeout：超时调用 killProcessTree 杀进程树', async () => {
    killCalls.length = 0;
    const execImpl = makeHangingExec();

    try {
      await execWithTimeout('"ffmpeg" -i fake.wav -f null -', { label: 'astats-window', timeoutMs: 20, execImpl });
    } catch (_) {
      // 预期超时
    }

    equal(killCalls.length, 1, 'killProcessTree 被调用一次');
    equal(killCalls[0], execImpl.calls[0].child, '杀的是 exec 返回的子进程句柄');
  });
}

async function testNormalReturnCleansTimer() {
  await test('execWithTimeout：正常返回不杀进程且清掉超时定时器', async () => {
    killCalls.length = 0;
    const execImpl = makeSucceedingExec('stdout-data', 'stderr-data');

    // 用假 timer 断言清理，避免测试自己真的留一个 5 秒定时器在事件循环里
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let timersCreated = 0;
    let timersCleared = 0;
    global.setTimeout = (fn, ms) => {
      timersCreated += 1;
      return realSetTimeout(fn, ms);
    };
    global.clearTimeout = (id) => {
      timersCleared += 1;
      return realClearTimeout(id);
    };

    let result = null;
    try {
      result = await execWithTimeout('"ffmpeg" -i fake.wav -f null -', {
        label: 'normal',
        timeoutMs: 5000,
        execImpl
      });
      // 留一点时间：若定时器没被清掉，超时兜底会在这里触发 kill
      await new Promise(resolve => realSetTimeout(resolve, 30));
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }

    equal(result?.stdout, 'stdout-data', 'resolve 出 stdout');
    equal(result?.stderr, 'stderr-data', 'resolve 出 stderr');
    equal(timersCreated, 1, '注册了一次超时定时器');
    equal(timersCleared, 1, '正常返回时清掉了定时器');
    equal(killCalls.length, 0, '没有触发 killProcessTree');
  });
}

async function testNullTimeoutFallsBackToFloor() {
  await test('execWithTimeout：不传 timeoutMs 时用 120s 下限，而不是被 Number(null) 误判成 1ms', async () => {
    const execImpl = makeSucceedingExec();
    const realSetTimeout = global.setTimeout;
    let capturedMs = null;
    global.setTimeout = (fn, ms) => {
      capturedMs = ms;
      return realSetTimeout(fn, ms);
    };

    try {
      await execWithTimeout('"ffmpeg" -i fake.wav -f null -', { label: 'no-timeout', execImpl });
    } finally {
      global.setTimeout = realSetTimeout;
    }

    equal(capturedMs, 120000, '实际注册的超时是 120s 下限');
  });
}

async function testTimeoutPolicy() {
  await test('超时策略：随时长缩放且不低于下限，时长未知时等于下限', async () => {
    const decode = AUDIO_CUTS_TIMEOUT_POLICIES.decode;
    equal(resolveAudioCutsTimeoutMs(60, decode), 120000, '60s 短片按下限 120s');
    equal(resolveAudioCutsTimeoutMs(600, decode), 300000, '600s 按 500ms/秒缩放为 300s');
    equal(resolveAudioCutsTimeoutMs(0, decode), 120000, '时长为 0 退回下限');
    equal(resolveAudioCutsTimeoutMs(undefined, decode), 120000, '时长未知退回下限');
    equal(resolveAudioCutsTimeoutMs(NaN, decode), 120000, '时长 NaN 退回下限');

    const astats = AUDIO_CUTS_TIMEOUT_POLICIES.astats;
    equal(resolveAudioCutsTimeoutMs(600, astats), 480000, 'astats 按 800ms/秒缩放为 480s');
    equal(resolveAudioCutsTimeoutMs(60, astats), 120000, 'astats 短片同样不低于下限');

    for (const [name, policy] of Object.entries(AUDIO_CUTS_TIMEOUT_POLICIES)) {
      check(policy.minMs >= 120000, `${name} 下限不低于 120 秒`);
    }
  });
}

async function testDetectAudioCutsTimeoutTrace() {
  await test('detectAudioCuts：子命令超时留痕且返回空数组', async () => {
    // 假 WAV：44 字节头 + 1 秒 PCM 数据，让时长探测超时后还能走 WAV 头兜底分支
    const tempPath = path.join(os.tmpdir(), `audioCuts-timeout-${process.pid}.wav`);
    fs.writeFileSync(tempPath, Buffer.alloc(44 + 32000));

    killCalls.length = 0;
    const execImpl = makeHangingExec();
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...args) => {
      warns.push(args.join(' '));
    };

    let cuts = null;
    try {
      cuts = await detectAudioCuts(tempPath, { execImpl, timeoutMs: 20 });
    } finally {
      console.warn = realWarn;
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {
        // 清理失败不影响断言
      }
    }

    check(Array.isArray(cuts) && cuts.length === 0, '超时后仍返回数组（空），不改变返回类型');

    // exec 桩看不到 label（label 不进 exec 的 options），所以用"命令条数 + 各条 warn"来验证：
    // 3 条 = silencedetect/audio-duration/astats-window，超时后不再跑 astats-summary 备选
    equal(execImpl.calls.length, 3, '只跑了 3 条子命令，astats 超时后不再跑备选方案');
    equal(killCalls.length, 3, '三次超时都走了 killProcessTree');

    check(
      warns.some(line => line.includes('silencedetect') && line.includes('timeoutMs=20') && line.includes(tempPath)),
      'silencedetect 超时 warn 带 label、timeoutMs 与音频文件'
    );
    check(
      warns.some(line => line.includes('audio-duration') && line.includes('timeoutMs=20') && line.includes(tempPath)),
      'audio-duration 超时 warn 带 label、timeoutMs 与音频文件'
    );
    check(
      warns.some(line => line.includes('astats-window') && line.includes('timeoutMs=20') && line.includes(tempPath)),
      'astats-window 超时 warn 带 label、timeoutMs 与音频文件'
    );
    check(!warns.some(line => line.includes('(label=') && !line.includes(tempPath)), '所有超时 warn 都带音频文件路径');
  });
}

// ---------------------------------------------------------------------------
// 原有用例
// ---------------------------------------------------------------------------

/** 查找可用的 .wav 测试文件 */
function findTestAudio() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.wav'));
  return files.length > 0 ? path.join(DOWNLOADS_DIR, files[0]) : null;
}

async function testErrorHandling() {
  await test('错误处理：不存在的文件抛错', async () => {
    let error = null;
    try {
      await detectAudioCuts('/non/existent/file.wav');
    } catch (e) {
      error = e;
    }

    check(error !== null, '不存在的文件应当抛错');
    check(String(error?.message || '').includes('音频文件不存在'), '错误信息说明音频文件不存在');
  });
}

async function testDetectAudioCuts() {
  await test('detectAudioCuts：真实音频输出格式（无 .wav 时跳过）', async () => {
    const audioPath = findTestAudio();
    if (!audioPath) {
      console.log('⚠ 未找到测试音频文件，跳过测试');
      console.log(`  请确保 ${DOWNLOADS_DIR} 中有 .wav 文件`);
      return;
    }

    console.log(`使用测试文件: ${audioPath}`);
    const stats = fs.statSync(audioPath);
    console.log(`文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    const startTime = Date.now();
    const cuts = await detectAudioCuts(audioPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n检测结果 (耗时 ${elapsed}s):`);
    console.log(`  总切点数: ${cuts.length}`);

    const silenceCuts = cuts.filter(c => c.reasons.includes('silence'));
    const volumeCuts = cuts.filter(c => c.reasons.includes('volume_change'));
    const bothCuts = cuts.filter(c => c.reasons.includes('silence') && c.reasons.includes('volume_change'));

    console.log(`  静音切点: ${silenceCuts.length}`);
    console.log(`  音量变化切点: ${volumeCuts.length}`);
    console.log(`  叠加切点: ${bothCuts.length}`);

    if (cuts.length > 0) {
      console.log('\n  前10个切点:');
      cuts.slice(0, 10).forEach(cut => {
        console.log(`    time=${cut.time.toFixed(1)}s, score=${cut.score}, reasons=[${cut.reasons.join(', ')}]`);
      });
    }

    // 验证输出格式
    check(Array.isArray(cuts), '返回值为数组');
    for (const cut of cuts) {
      check(typeof cut.time === 'number' && cut.time >= 0, `time 应为非负数 (${cut.time})`);
      check(typeof cut.score === 'number' && cut.score >= 0 && cut.score <= 1, `score 应在 0-1 范围 (${cut.score})`);
      check(Array.isArray(cut.reasons) && cut.reasons.length > 0, 'reasons 应为非空数组');
    }
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== 音频切点检测测试 ==========');

  await testErrorHandling();
  await testExecWithTimeoutReject();
  await testTimeoutKillsProcessTree();
  await testNormalReturnCleansTimer();
  await testNullTimeoutFallsBackToFloor();
  await testTimeoutPolicy();
  await testDetectAudioCutsTimeoutTrace();
  await testDetectAudioCuts();

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
