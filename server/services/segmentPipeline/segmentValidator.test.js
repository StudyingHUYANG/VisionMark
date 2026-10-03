'use strict';

/**
 * segmentValidator 单测（纯函数：无网络、无模型、无写盘）
 *
 * 运行方式: node server/services/segmentPipeline/segmentValidator.test.js
 *
 * 钉住的行为：
 *  ① 不变量：0 <= start < end <= duration；相邻片段 |next.start - prev.end| <= 容差
 *  ② duration <= 0 → 空 segments + duration_missing_or_zero 警告
 *  ③ segments 为空但 duration > 0 → 整段兜底 [0, duration]，reasons 含 fallbackReason
 *  ④ 重叠 / 空洞 / 首尾缺口被修复并留下对应警告
 *  ⑤ 非法 type / confidence 默认成 unknown / low 并告警
 *  ⑥ summary 兜底：区间内转录原文（segment_summary_filled_from_transcript）
 *     或结构性文本（segment_summary_filled_with_structural_text），二者都非空
 *  ⑦ 没有匹配到候选切点且无 fallbackReason → reasons 含 no_candidate_cut_matched；
 *     有 fallbackReason 时不重复添加 no_candidate_cut_matched
 *  ⑧ candidateCuts 的 adopted：落在片段边界 5 秒内为 true，否则 false
 *
 * 容差语义（源码未导出 COVERAGE_TOLERANCE_SECONDS，这里硬编码 1 并注明）：
 *  源码第 20 行 COVERAGE_TOLERANCE_SECONDS = 1；相邻片段小于容差的重叠/空洞
 *  是设计内行为（避免浮点误差触发无意义修复），不会产生修复警告。
 */

const {
  validateSegments,
  NO_CANDIDATE_CUT_REASON,
  ADOPTED_TOLERANCE_SECONDS
} = require('./segmentValidator');

/** 与源码第 20 行 COVERAGE_TOLERANCE_SECONDS 保持一致（未导出） */
const COVERAGE_TOLERANCE_SECONDS = 1;
/** 输出时间保留两位小数，比较相邻覆盖时再加上舍入余量 */
const ADJACENCY_TOLERANCE = COVERAGE_TOLERANCE_SECONDS + 0.01;

// ---------------------------------------------------------------------------
// 断言与测试框架（沿用 segmentContract.test.js 的脚手架）
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

/** 校验对所有输出片段恒成立的不变量 */
function checkInvariants(segments, duration, label) {
  for (const [index, segment] of segments.entries()) {
    check(segment.start >= 0, `${label} 片段${index + 1} start >= 0`, `实际 ${segment.start}`);
    check(segment.start < segment.end, `${label} 片段${index + 1} start < end`,
      `${segment.start} ~ ${segment.end}`);
    check(segment.end <= duration, `${label} 片段${index + 1} end <= duration`,
      `${segment.end} > ${duration}`);
    check(segment.summary.trim().length > 0, `${label} 片段${index + 1} summary 非空`);
    check(typeof segment.type === 'string' && segment.type.length > 0, `${label} 片段${index + 1} type 非空`);
    check(['high', 'medium', 'low'].includes(segment.confidence), `${label} 片段${index + 1} confidence 合法`);
  }
  for (let i = 1; i < segments.length; i += 1) {
    const diff = Math.abs(segments[i].start - segments[i - 1].end);
    check(diff <= ADJACENCY_TOLERANCE, `${label} 片段${i + 1} 与前一段首尾相接（容差内）`,
      `|${segments[i].start} - ${segments[i - 1].end}| = ${diff}`);
  }
}

function hasWarning(warnings, prefix) {
  return warnings.some(message => message.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  await test('① 不变量：正常/重叠/空洞/首尾缺口输入都满足区间与相邻约束', () => {
    const cases = [
      ['正常两段', 80, [{ start: 0, end: 40 }, { start: 40, end: 80 }]],
      ['重叠', 80, [{ start: 0, end: 50 }, { start: 40, end: 80 }]],
      ['空洞', 80, [{ start: 0, end: 30 }, { start: 50, end: 80 }]],
      ['首缺口', 80, [{ start: 10, end: 40 }, { start: 40, end: 80 }]],
      ['尾缺口', 80, [{ start: 0, end: 50 }]],
      ['乱序输入', 80, [{ start: 50, end: 80 }, { start: 0, end: 30 }]],
      ['越界与负值', 80, [{ start: -10, end: 30 }, { start: 20, end: 500 }]]
    ];

    for (const [label, duration, segments] of cases) {
      const result = validateSegments({ duration, segments, transcript: [] });
      check(result.segments.length > 0, `${label} 产出片段`);
      checkInvariants(result.segments, duration, label);
    }

    // 小于容差的重叠/空洞是设计内行为，不触发修复
    const toleratedOverlap = validateSegments({
      duration: 80,
      segments: [{ start: 0, end: 50 }, { start: 49, end: 80 }],
      transcript: []
    });
    check(!hasWarning(toleratedOverlap.warnings, 'repaired_segment_overlap'),
      '恰好 1 秒重叠（等于容差）不修复');
    checkInvariants(toleratedOverlap.segments, 80, '容差内重叠');

    const toleratedGap = validateSegments({
      duration: 80,
      segments: [{ start: 0, end: 30 }, { start: 31, end: 80 }],
      transcript: []
    });
    check(!hasWarning(toleratedGap.warnings, 'repaired_segment_gap'), '恰好 1 秒空洞（等于容差）不修复');
    checkInvariants(toleratedGap.segments, 80, '容差内空洞');
  });

  await test('② duration <= 0：返回空 segments 并告警 duration_missing_or_zero', () => {
    for (const duration of [0, -5, 'abc', undefined, null]) {
      const result = validateSegments({
        duration,
        segments: [{ start: 0, end: 10 }],
        candidateCuts: [{ time: 5, score: 0.5 }]
      });
      equal(result.segments.length, 0, `duration=${JSON.stringify(duration)} 时不臆造片段`);
      check(result.warnings.includes('duration_missing_or_zero'), `duration=${JSON.stringify(duration)} 有原因警告`);
      equal(result.candidateCuts.length, 1, '候选切点原样返回');
      equal(result.candidateCuts[0].adopted, false, '无片段时 adopted 恒为 false');
    }
  });

  await test('③ segments 为空但 duration > 0：整段兜底 [0, duration]', () => {
    const result = validateSegments({
      duration: 120,
      segments: [],
      candidateCuts: [],
      transcript: [],
      fallbackReason: 'model_client_unavailable'
    });

    equal(result.segments.length, 1, '兜底成一个片段');
    equal(result.segments[0].start, 0, '兜底起点 0');
    equal(result.segments[0].end, 120, '兜底终点 duration');
    check(result.segments[0].evidence.reasons.includes('model_client_unavailable'),
      'reasons 含传入的 fallbackReason');
    check(hasWarning(result.warnings, 'no_valid_segments_full_length_fallback'), '留下兜底警告');
    checkInvariants(result.segments, 120, '整段兜底');

    // 没有 fallbackReason 时用 validator_fallback 兜底
    const noReason = validateSegments({ duration: 60, segments: [], transcript: [] });
    check(noReason.segments[0].evidence.reasons.includes('validator_fallback'),
      '无 fallbackReason 时用 validator_fallback');
  });

  await test('④ 重叠 / 空洞 / 首尾缺口被修复并留下对应警告', () => {
    const overlap = validateSegments({
      duration: 80,
      segments: [{ start: 0, end: 50 }, { start: 40, end: 80 }],
      transcript: []
    });
    check(overlap.warnings.includes('repaired_segment_overlap'), '重叠 → repaired_segment_overlap');
    equal(overlap.segments[1].start, 50, '后一段起点收窄到前一段终点');
    equal(overlap.segments[1].end, 80, '终点不变');

    const gap = validateSegments({
      duration: 80,
      segments: [{ start: 0, end: 30 }, { start: 50, end: 80 }],
      transcript: []
    });
    check(gap.warnings.includes('repaired_segment_gap'), '空洞 → repaired_segment_gap');
    equal(gap.segments[1].start, 30, '后一段起点前移到前一段终点');

    const leading = validateSegments({
      duration: 80,
      segments: [{ start: 10, end: 40 }, { start: 40, end: 80 }],
      transcript: []
    });
    check(leading.warnings.includes('repaired_leading_coverage_gap'), '首缺口 → repaired_leading_coverage_gap');
    equal(leading.segments[0].start, 0, '首段起点拉到 0');

    const trailing = validateSegments({
      duration: 80,
      segments: [{ start: 0, end: 50 }],
      transcript: []
    });
    check(trailing.warnings.includes('repaired_trailing_coverage_gap'), '尾缺口 → repaired_trailing_coverage_gap');
    equal(trailing.segments[0].end, 80, '末段终点拉到 duration');

    for (const [label, result, duration] of [
      ['重叠', overlap, 80], ['空洞', gap, 80], ['首缺口', leading, 80], ['尾缺口', trailing, 80]
    ]) {
      checkInvariants(result.segments, duration, label);
    }
  });

  await test('⑤ 非法 type / confidence 默认成 unknown / low 并告警', () => {
    const result = validateSegments({
      duration: 30,
      segments: [{
        start: 0,
        end: 30,
        title: '开场',
        type: 'bogus_type',
        confidence: 'super_high',
        summary: '已有摘要'
      }],
      transcript: []
    });

    equal(result.segments[0].type, 'unknown', '非法 type → unknown');
    equal(result.segments[0].confidence, 'low', '非法 confidence → low');
    check(result.warnings.includes('invalid_segment_type_defaulted_to_unknown'), 'type 降级有警告');
    check(result.warnings.includes('invalid_segment_confidence_defaulted_to_low'), 'confidence 降级有警告');
    checkInvariants(result.segments, 30, '类型降级');
  });

  await test('⑥ summary 兜底：转录原文 或 结构性文本（都非空）', () => {
    const fromTranscript = validateSegments({
      duration: 30,
      segments: [{ start: 0, end: 30, title: '开场', type: 'content', confidence: 'medium' }],
      transcript: [{ start: 5, end: 8, text: '这是区间内的转录原文', hasTimestamp: true }]
    });
    equal(fromTranscript.segments[0].summary, '这是区间内的转录原文', 'summary 用区间内转录原文');
    check(fromTranscript.warnings.includes('segment_summary_filled_from_transcript:开场'),
      '转录兜底有 segment_summary_filled_from_transcript 警告');
    check(fromTranscript.segments[0].summary.trim().length > 0, 'summary 非空');

    const structural = validateSegments({
      duration: 30,
      segments: [{ start: 0, end: 30, title: '开场', type: 'content', confidence: 'medium' }],
      transcript: []
    });
    check(structural.segments[0].summary.includes('本片段未获得内容描述'), '无转录时用结构性文本');
    check(structural.warnings.includes('segment_summary_filled_with_structural_text:开场'),
      '结构性文本兜底有 segment_summary_filled_with_structural_text 警告');
    check(structural.segments[0].summary.trim().length > 0, '结构性 summary 非空');

    // 已有 summary 时两条兜底路径都不触发
    const provided = validateSegments({
      duration: 30,
      segments: [{ start: 0, end: 30, title: '开场', type: 'content', confidence: 'medium', summary: '模型给的摘要' }],
      transcript: [{ start: 5, end: 8, text: '转录原文', hasTimestamp: true }]
    });
    equal(provided.segments[0].summary, '模型给的摘要', '已有 summary 不被覆盖');
    check(!hasWarning(provided.warnings, 'segment_summary_filled'), '已有 summary 时无兜底警告');
  });

  await test('⑦ 无候选切点匹配时写入 NO_CANDIDATE_CUT_REASON；有 fallbackReason 时不重复', () => {
    const noMatch = validateSegments({
      duration: 60,
      segments: [{ start: 0, end: 60 }],
      candidateCuts: [{ time: 90, score: 0.5 }],
      transcript: []
    });
    check(noMatch.segments[0].evidence.reasons.includes(NO_CANDIDATE_CUT_REASON),
      `无匹配切点 → reasons 含 ${NO_CANDIDATE_CUT_REASON}`);
    check(hasWarning(noMatch.warnings, 'segment_without_traceable_evidence'), '留下不可溯源警告');
    equal(noMatch.candidateCuts[0].adopted, false, '区间外候选切点 adopted=false');

    const withFallback = validateSegments({
      duration: 60,
      segments: [{ start: 0, end: 60 }],
      candidateCuts: [{ time: 90, score: 0.5 }],
      transcript: [],
      fallbackReason: 'model_client_unavailable'
    });
    check(withFallback.segments[0].evidence.reasons.includes('model_client_unavailable'),
      '有 fallbackReason 时写入该原因');
    check(!withFallback.segments[0].evidence.reasons.includes(NO_CANDIDATE_CUT_REASON),
      '有 fallbackReason 时不再添加 no_candidate_cut_matched');

    // 有匹配到边界切点时也不添加
    const matched = validateSegments({
      duration: 60,
      segments: [{ start: 0, end: 60 }],
      candidateCuts: [{ time: 60, score: 0.8 }],
      transcript: []
    });
    check(!matched.segments[0].evidence.reasons.includes(NO_CANDIDATE_CUT_REASON),
      '匹配到边界切点时无 no_candidate_cut_matched');
    equal(matched.segments[0].evidence.candidateCutTimes.length, 1, '边界切点回填进 candidateCutTimes');
  });

  await test('⑧ candidateCuts.adopted：边界 5 秒内为 true，否则 false', () => {
    const original = [
      { time: 5, score: 0.6, reasons: ['visual_change'], sources: ['visual'] },
      { time: 5.01, score: 0.6, reasons: ['visual_change'], sources: ['visual'] },
      { time: 20, score: 0.7, reasons: ['audio_pause'], sources: ['audio'] },
      { time: 45, score: 0.5, reasons: ['keyword:要点'], sources: ['keyword'] }
    ];
    const result = validateSegments({
      duration: 60,
      segments: [{ start: 0, end: 20 }, { start: 20, end: 60 }],
      candidateCuts: original,
      transcript: []
    });

    const adoptedByTime = new Map(result.candidateCuts.map(cut => [cut.time, cut.adopted]));
    equal(adoptedByTime.get(5), true, '距首段起点恰好 5 秒 → adopted=true（<= 容差）');
    equal(adoptedByTime.get(5.01), false, '距边界 5.01 秒 → adopted=false');
    equal(adoptedByTime.get(20), true, '落在一段终点 / 另一段起点 → adopted=true');
    equal(adoptedByTime.get(45), false, '距最近边界 15 秒 → adopted=false');
    equal(ADOPTED_TOLERANCE_SECONDS, 5, '采用容差常量为 5 秒');
    equal(JSON.stringify(result.candidateCuts.map(cut => cut.time)), JSON.stringify([5, 5.01, 20, 45]),
      'candidateCuts 按时间升序返回');

    // 原输入对象不被就地修改
    equal(original[0].adopted, undefined, '原 candidateCuts 对象不被就地改写');
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
