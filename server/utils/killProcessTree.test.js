'use strict';

/**
 * killProcessTree 测试：进程树收尾的分支行为 + 调用方不再裸 kill 的约定守卫
 *
 * 运行方式: node server/utils/killProcessTree.test.js
 *
 * 全程注入 spawnImpl 桩并显式指定 platform：
 * 不启动任何真实进程，不会真的执行 taskkill / python / ffmpeg。
 */

const fs = require('fs');
const path = require('path');

const { killProcessTree } = require('./killProcessTree');

const SERVER_ROOT = path.join(__dirname, '..');

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

/** 假 child：只记录 kill 收到什么参数 */
function makeChild(pid) {
  const killCalls = [];
  return {
    child: { pid, kill: (...args) => { killCalls.push(args); } },
    killCalls
  };
}

/** 假 spawnSync：记录每次调用的 (command, args, options) */
function makeSpawnStub(behavior = null) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (behavior === 'throw') throw new Error('taskkill 不存在');
    return { status: 0 };
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== killProcessTree 测试 ==========');

  await test('win32：走 taskkill /T /F 杀整棵进程树，不调 child.kill', async () => {
    const { child, killCalls } = makeChild(4321);
    const spawnImpl = makeSpawnStub();

    killProcessTree(child, { spawnImpl, platform: 'win32' });

    equal(spawnImpl.calls.length, 1, '调用了一次 taskkill');
    const call = spawnImpl.calls[0] || {};
    equal(call.command, 'taskkill', '命令是 taskkill');
    equal(JSON.stringify(call.args), JSON.stringify(['/pid', '4321', '/T', '/F']), '参数为 /pid <pid> /T /F');
    equal(call.options?.windowsHide, true, '不弹窗');
    equal(call.options?.stdio, 'ignore', '不接管输出');
    equal(killCalls.length, 0, '没有走 child.kill');
  });

  await test('非 win32：child.kill 收到 SIGKILL，不调 taskkill', async () => {
    const { child, killCalls } = makeChild(999);
    const spawnImpl = makeSpawnStub();

    killProcessTree(child, { spawnImpl, platform: 'linux' });

    equal(spawnImpl.calls.length, 0, '没有调用 taskkill');
    equal(killCalls.length, 1, '调用了一次 child.kill');
    equal(killCalls[0][0], 'SIGKILL', '信号是 SIGKILL');
  });

  await test('win32 但 child 没有 pid：不拼 taskkill，退回 child.kill', async () => {
    const { child, killCalls } = makeChild(undefined);
    const spawnImpl = makeSpawnStub();

    killProcessTree(child, { spawnImpl, platform: 'win32' });

    equal(spawnImpl.calls.length, 0, '没有 pid 就不该调 taskkill');
    equal(killCalls.length, 1, '退回 child.kill');
    equal(killCalls[0][0], 'SIGKILL', '非 win32 分支的信号');
  });

  await test('spawnImpl 抛错：回退到不带参数的 child.kill()，且不向外抛', async () => {
    const { child, killCalls } = makeChild(777);
    const spawnImpl = makeSpawnStub('throw');

    let thrown = null;
    try {
      killProcessTree(child, { spawnImpl, platform: 'win32' });
    } catch (error) {
      thrown = error;
    }

    equal(thrown, null, '没有向外抛错');
    equal(spawnImpl.calls.length, 1, '确实尝试过 taskkill');
    equal(killCalls.length, 1, '回退到 child.kill');
    equal(killCalls[0].length, 0, '回退调用不带信号参数');
  });

  await test('回退的 child.kill 自己再抛错：仍然不向外抛', async () => {
    const child = { pid: 555, kill: () => { throw new Error('进程已退出'); } };
    const spawnImpl = makeSpawnStub('throw');

    let thrown = null;
    try {
      killProcessTree(child, { spawnImpl, platform: 'win32' });
    } catch (error) {
      thrown = error;
    }

    equal(thrown, null, '兜底失败也不影响调用方');
  });

  await test('child 为 null / undefined：直接返回，不抛错也不调任何东西', async () => {
    const spawnImpl = makeSpawnStub();

    let thrown = null;
    try {
      killProcessTree(null, { spawnImpl, platform: 'win32' });
      killProcessTree(undefined, { spawnImpl, platform: 'win32' });
      killProcessTree(null);
    } catch (error) {
      thrown = error;
    }

    equal(thrown, null, '不抛错');
    equal(spawnImpl.calls.length, 0, '什么都没调用');
  });

  await test('约定守卫：三个调用方不再出现裸 kill（扫源码，不是行为测试）', async () => {
    // 这条测的是"约定"：超时收尾必须统一走 killProcessTree，而不是验证进程真的被杀掉
    // （那是 mock 自己的行为）。它只钉住源码别再退化回裸 kill——裸 kill 在 Windows 上
    // 会留下 python/ffmpeg 孤儿进程，而且这种回归不会让任何行为测试变红。
    const targets = [
      'services/visualCutDetector.js',
      'services/asr/transcribeAudio.js',
      'services/asr/whisperFallback.js'
    ];

    for (const relative of targets) {
      const source = fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8');
      const offenders = source
        .split(/\r?\n/)
        .map((line, index) => ({ text: line.trim(), number: index + 1 }))
        .filter(item => /\.kill\s*\(/.test(item.text));

      equal(
        offenders.length,
        0,
        `${relative} 没有裸 .kill() 调用`,
        offenders.map(item => `L${item.number}: ${item.text}`).join(' | ')
      );
      check(source.includes('killProcessTree'), `${relative} 改用了 killProcessTree`);
    }
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
