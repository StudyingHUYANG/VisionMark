'use strict';

/**
 * 关键词切点解析测试
 *
 * 运行方式: node server/services/segment/keywordCuts.test.js
 *
 * 本轮只覆盖 parseTimeToSeconds 的空值语义与 detectKeywordCuts 的时间回归：
 * - null / undefined / '' 必须返回 null，不能被 Number(null) === 0 变成 0；
 * - 数字 0 是合法时间戳（视频开头），不能被 > 0 规则误杀；
 * - 正常带时间戳的转录，切点时间与修复前完全一致。
 *
 * 不触碰 calculateMatchScore / KEYWORD_RULES 的匹配口径（另有人拍板）。
 */

const {
  parseTimeToSeconds,
  parseTranscriptWithTimestamps,
  detectKeywordCuts
} = require('./keywordCuts');

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

function deepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, label, `期望 ${e}，实际 ${a}`);
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

async function main() {
  console.log('========== 关键词切点测试 ==========');

  await test('parseTimeToSeconds：null / undefined / 空串返回 null，而不是 0', async () => {
    equal(parseTimeToSeconds(null), null, 'null → null（Number(null) === 0 是修复的坑）');
    equal(parseTimeToSeconds(undefined), null, 'undefined → null');
    equal(parseTimeToSeconds(''), null, '空串 → null');
    equal(parseTimeToSeconds(NaN), null, 'NaN → null');
    equal(parseTimeToSeconds(Infinity), null, 'Infinity → null');
    equal(parseTimeToSeconds('abc'), null, '非时间字符串 → null');
    equal(parseTimeToSeconds('1:2:3:4'), null, '分段数不合法 → null');
    equal(parseTimeToSeconds({}), null, '对象 → null');
  });

  await test('parseTimeToSeconds：数字 0 是合法时间戳，必须保留', async () => {
    equal(parseTimeToSeconds(0), 0, '数字 0 → 0（视频开头，不能被 > 0 规则误杀）');
    equal(parseTimeToSeconds('0'), 0, '字符串 "0" → 0');
    equal(parseTimeToSeconds(62.5), 62.5, '小数秒原样返回');
  });

  await test('parseTimeToSeconds：常见时间格式', async () => {
    equal(parseTimeToSeconds(90), 90, '纯秒数');
    equal(parseTimeToSeconds('1:02'), 62, 'MM:SS');
    equal(parseTimeToSeconds('01:02:03'), 3723, 'HH:MM:SS');
    equal(parseTimeToSeconds('1：02'), 62, '全角冒号按半角处理');
  });

  await test('detectKeywordCuts：正常带时间戳的转录，切点时间不受空值修复影响', async () => {
    const transcript = [
      '[0:05] 大家好，我是科技主播',
      '[0:30] 今天要聊的是新产品发布',
      '[1:45] 本期视频由某某公司赞助',
      '[2:30] 这个产品的特点是...',
      '[5:00] 总结一下，这款产品很不错',
      '[5:45] 感谢观看，一键三连'
    ].join('\n');

    const detections = detectKeywordCuts(transcript);

    // 修复前实测的完整时间序列：105s 处 3 条、300s 处 2 条、345s 处 3 条
    deepEqual(
      detections.map(item => item.time),
      [105, 105, 105, 300, 300, 345, 345, 345],
      '切点时间与修复前逐条一致'
    );
    check(
      detections.every(item => item.time > 0),
      '正常转录里不应出现 0 秒切点（没有时间信息的行不进结果）'
    );
    check(
      detections.some(item => item.time === 105 && item.keyword === '本期视频由'),
      '1:45 的广告口播在 105s 被检出'
    );

    // 同一输入跑两次，结果稳定
    deepEqual(detectKeywordCuts(transcript), detections, '同输入两次结果一致');
  });

  await test('parseTranscriptWithTimestamps：缺失/空 start 仍安全落到 0 兜底', async () => {
    const segments = parseTranscriptWithTimestamps([
      { text: '没有时间信息', start: null },
      { text: '空串时间', start: '' },
      { text: '正常段', start: 0 },
      { text: '时间戳段', start: '1:02', end: '1:10' }
    ]);

    // parseTimeToSeconds 返回 null 后由调用方决定兜底（这里兜 0），不再由 Number(null) 悄悄给 0
    deepEqual(segments.map(item => item.time), [0, 0, 0, 62], '空值兜底 0，合法值不受影响');
    equal(segments[3].end, 70, 'end 时间正常解析');
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
