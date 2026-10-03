'use strict';

/**
 * numberUtils 测试
 *
 * 运行方式: node server/utils/numberUtils.test.js
 *
 * 重点钉住 Number(null) === 0 这个坑：toPositiveNumber 必须把
 * "未提供/非法"的值（null/undefined/''/NaN/Infinity/<=0/非数值）判成 null，
 * 只有能转成 > 0 的有限数才返回正数。
 */

const { toPositiveNumber } = require('./numberUtils');

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

function test(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    fn();
  } catch (error) {
    failures.push(`${name} 抛出异常: ${error.stack || error.message}`);
    console.error(`  ✗ 抛出异常: ${error.stack || error.message}`);
  }
}

console.log('========== numberUtils 测试 ==========');

test('toPositiveNumber：未提供/非法值一律返回 null', () => {
  equal(toPositiveNumber(null), null, 'null 返回 null（而不是 0）');
  equal(toPositiveNumber(undefined), null, 'undefined 返回 null');
  equal(toPositiveNumber(''), null, '空串返回 null');
  equal(toPositiveNumber('   '), null, '纯空白串返回 null');
  equal(toPositiveNumber('abc'), null, '非数值字符串返回 null');
  equal(toPositiveNumber(NaN), null, 'NaN 返回 null');
  equal(toPositiveNumber(Infinity), null, 'Infinity 返回 null');
  equal(toPositiveNumber(-Infinity), null, '-Infinity 返回 null');
  equal(toPositiveNumber(0), null, '0 返回 null');
  equal(toPositiveNumber('0'), null, '字符串 0 返回 null');
  equal(toPositiveNumber(-1), null, '负数返回 null');
  equal(toPositiveNumber('-2.5'), null, '负数字符串返回 null');
});

test('toPositiveNumber：能转成正数就返回该数', () => {
  equal(toPositiveNumber(1), 1, '整数原样返回');
  equal(toPositiveNumber(0.5), 0.5, '小数原样返回');
  equal(toPositiveNumber('120'), 120, '数值字符串转成数字');
  equal(toPositiveNumber(' 120 '), 120, '带空白的数值字符串可解析');
  check(Number.isFinite(toPositiveNumber(1e3)), '科学计数法也是有限数', String(toPositiveNumber(1e3)));
  equal(toPositiveNumber(1e3), 1000, '科学计数法取值正确');
});

console.log('\n========== 测试结果 ==========');
console.log(`通过断言: ${passed}`);
console.log(`失败项: ${failures.length}`);
if (failures.length > 0) {
  console.error('\n失败明细:');
  failures.forEach(item => console.error(`  - ${item}`));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
