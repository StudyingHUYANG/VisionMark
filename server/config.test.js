'use strict';

/**
 * config 测试：PORT 从环境变量读取与非法值回退、JWT_SECRET 默认值告警
 *
 * 运行方式: node server/config.test.js
 *
 * config.js 在 require 时读取 process.env，所以每条用例都要先删 require.cache
 * 再重新 require；用例之间恢复 process.env，避免互相污染。
 */

const CONFIG_PATH = require.resolve('./config.js');
const ENV_KEYS = ['PORT', 'JWT_SECRET'];

// 记录测试开始时的原始环境，结束时还原
const ORIGINAL_ENV = {};
for (const key of ENV_KEYS) {
  ORIGINAL_ENV[key] = process.env[key];
}

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
// 辅助：环境变量与模块加载
// ---------------------------------------------------------------------------

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
}

/** 清掉模块缓存后重新 require，拿到按当前 env 重新求值的 config */
function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return require(CONFIG_PATH);
}

/** 临时替换 console.warn 捕获告警，加载完成后恢复（即使加载抛错也恢复） */
function loadConfigCapturingWarnings() {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { config: loadConfig(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== config 测试 ==========');

  await test('未设置 PORT：回退 8080，且不产生 PORT 告警', async () => {
    restoreEnv();
    delete process.env.PORT;
    process.env.JWT_SECRET = 'test-jwt-secret'; // 压掉 JWT 告警，只盯 PORT

    const { config, warnings } = loadConfigCapturingWarnings();

    equal(config.PORT, 8080, 'PORT 回退到 8080');
    equal(warnings.filter(w => /PORT/.test(w)).length, 0, '没有 PORT 相关告警');
  });

  await test('PORT=9000：直接采用 9000', async () => {
    restoreEnv();
    process.env.PORT = '9000';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();

    equal(config.PORT, 9000, 'PORT 为 9000');
    equal(warnings.length, 0, '没有告警');
  });

  await test("PORT=' 9000 '（带空格）：trim 后采用 9000", async () => {
    restoreEnv();
    process.env.PORT = ' 9000 ';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();

    equal(config.PORT, 9000, '前后空格被忽略');
    equal(warnings.length, 0, '没有告警');
  });

  await test('PORT=65535：边界上限可用', async () => {
    restoreEnv();
    process.env.PORT = '65535';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();

    equal(config.PORT, 65535, 'PORT 为 65535');
    equal(warnings.length, 0, '没有告警');
  });

  await test('PORT=abc：回退 8080 且产生一条 PORT 告警', async () => {
    restoreEnv();
    process.env.PORT = 'abc';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();
    const portWarnings = warnings.filter(w => /PORT/.test(w) && /8080/.test(w));

    equal(config.PORT, 8080, 'PORT 回退到 8080');
    equal(portWarnings.length, 1, '产生一条说明回退的 PORT 告警', JSON.stringify(warnings));
  });

  await test('PORT=0：超出范围，回退 8080 且产生一条 PORT 告警', async () => {
    restoreEnv();
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();
    const portWarnings = warnings.filter(w => /PORT/.test(w) && /8080/.test(w));

    equal(config.PORT, 8080, 'PORT 回退到 8080');
    equal(portWarnings.length, 1, '产生一条说明回退的 PORT 告警', JSON.stringify(warnings));
  });

  await test('PORT=99999：超出范围，回退 8080 且产生一条 PORT 告警', async () => {
    restoreEnv();
    process.env.PORT = '99999';
    process.env.JWT_SECRET = 'test-jwt-secret';

    const { config, warnings } = loadConfigCapturingWarnings();
    const portWarnings = warnings.filter(w => /PORT/.test(w) && /8080/.test(w));

    equal(config.PORT, 8080, 'PORT 回退到 8080');
    equal(portWarnings.length, 1, '产生一条说明回退的 PORT 告警', JSON.stringify(warnings));
  });

  await test('未设置 JWT_SECRET：保留默认值行为，但产生醒目告警', async () => {
    restoreEnv();
    delete process.env.JWT_SECRET;
    process.env.PORT = '8080';

    const { config, warnings } = loadConfigCapturingWarnings();
    const jwtWarnings = warnings.filter(w => /JWT_SECRET/.test(w));

    equal(config.JWT_SECRET, 'secret-key-v1', '仍回退内置默认密钥（不抛错，保住本地开发）');
    equal(jwtWarnings.length, 1, '产生一条 JWT_SECRET 告警', JSON.stringify(warnings));
    check(/生产/.test(jwtWarnings[0] || ''), '告警说明生产环境必须配置');
  });

  await test('设置了 JWT_SECRET：使用环境变量值且不告警', async () => {
    restoreEnv();
    process.env.JWT_SECRET = 'prod-secret-来自env';
    process.env.PORT = '8080';

    const { config, warnings } = loadConfigCapturingWarnings();

    equal(config.JWT_SECRET, 'prod-secret-来自env', '使用环境变量里的密钥');
    equal(warnings.length, 0, '没有告警');
  });

  // --- 收尾：还原环境变量与模块缓存 ---
  restoreEnv();
  delete require.cache[CONFIG_PATH];

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
  restoreEnv();
  console.error('测试运行失败:', error);
  process.exitCode = 1;
});
