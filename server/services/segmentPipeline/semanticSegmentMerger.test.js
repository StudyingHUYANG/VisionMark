'use strict';

/**
 * 语义合并（semanticSegmentMerger）测试
 *
 * 运行方式: node server/services/segmentPipeline/semanticSegmentMerger.test.js
 *
 * 覆盖:
 * ① 模型声明的真实候选切点保留，并归一化成真实切点的时间值（不保留模型近似小数）；
 *    模型声明的 reasons 带 model_reason: 前缀
 * ② 模型声明的非候选切点被丢弃，debug.warnings 留下 dropped_ai_declared_cut_not_in_candidates:*
 * ③ 真实候选切点为空时不做核对，模型声明原样保留
 * ④ 非 JSON / 空 segments / 请求抛错三种情况降级到 fallbackSegmentMerge，fallbackReason 正确
 * ⑤ snapBoundary 容差内记 snapped_to_*、超差记 forced_to_*（钉住现状）
 * ⑥ 模型声明内部原因值（validator_fallback）：只以 model_reason: 前缀出现，不得冒充内部溯源
 * ⑦ 多个声明原因：合法项命名空间化 + 去重，空串/非字符串丢弃，超长截断
 * ⑧ snapped_to_* / forced_to_* 仍为裸值（内部溯源回归）
 * ⑨ 端到端（validateSegments + toContractSegments）：契约 reasons 里没有裸的内部原因值
 *
 * 全部用例均为确定性测试：不访问网络、不使用真实 API Key / Cookie、不调用真实大模型。
 */

const {
  mergeSegmentsWithAI,
  fallbackSegmentMerge,
  snapBoundary,
  BOUNDARY_SNAP_TOLERANCE_SECONDS,
  MODEL_REASON_PREFIX,
  MODEL_REASON_MAX_LENGTH
} = require('./semanticSegmentMerger');
const { validateSegments } = require('./segmentValidator');
const { toContractSegments } = require('./segmentContract');

// ---------------------------------------------------------------------------
// 断言与测试框架（保持与 segmentContract.test.js 一致的脚本风格）
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
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  check(actualJson === expectedJson, label, `期望 ${expectedJson}，实际 ${actualJson}`);
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
// 测试素材与假 modelClient
// ---------------------------------------------------------------------------

/** 真实候选切点集合（与 API 返回的 candidateCuts 对应） */
const CANDIDATE_CUTS = [
  { time: 45.26, score: 0.98, reasons: ['visual_change'], sources: ['visual', 'audio', 'text'] },
  { time: 120.82, score: 0.99, reasons: ['keyword:总结一下'], sources: ['keyword', 'visual', 'text'] }
];

const BASE_INPUT = {
  bvid: 'BV1test',
  duration: 180,
  candidateCuts: CANDIDATE_CUTS,
  transcript: []
};

function segmentJson(segment) {
  return JSON.stringify({ segments: [segment] });
}

/** 返回固定文本的假 modelClient，不触网 */
function modelClientReturning(content) {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content } }] })
      }
    }
  };
}

/** 请求直接抛错的假 modelClient */
function modelClientThrowing(message) {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error(message);
        }
      }
    }
  };
}

function hasWarning(warnings, prefix) {
  return warnings.some(item => item.startsWith(prefix));
}

const DROPPED_CUT_PREFIX = 'dropped_ai_declared_cut_not_in_candidates:';

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  await test('① 模型声明的真实候选切点：保留并归一化为真实时间值', async () => {
    const result = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(segmentJson({
      start: 0,
      end: 45.259, // 模型写的近似小数，应吸附/归一化到真实切点 45.26
      title: '开场',
      type: 'intro',
      summary: '开场介绍',
      confidence: 'high',
      evidence: {
        candidateCutTimes: [45.259, 45.26, 120.82], // 前两个都落在真实切点 45.26 的容差内
        reasons: ['visual_change']
      }
    })));

    equal(result.debug.usedAI, true, '走 AI 归并路径');
    equal(result.segments.length, 1, '产出 1 个片段');
    // 45.259 / 45.26 归一化成真实的 45.26 并去重，120.82 是真实切点原样保留
    deepEqual(result.segments[0].evidence.candidateCutTimes, [45.26, 120.82],
      '证据切点归一化成真实时间值并去重排序');
    check(!result.segments[0].evidence.candidateCutTimes.includes(45.259),
      '不保留模型写的近似小数 45.259');
    check(!hasWarning(result.debug.warnings, DROPPED_CUT_PREFIX),
      '真实切点不产生丢弃警告', JSON.stringify(result.debug.warnings));
    // 45.259 吸附到 45.26 会产生内部裸值 snapped_to_candidate_cut；模型声明的 visual_change 必须带前缀
    deepEqual(result.segments[0].evidence.reasons,
      [`${MODEL_REASON_PREFIX}visual_change`, 'snapped_to_candidate_cut'],
      '模型声明的 reasons 带 model_reason: 前缀，内部 snap 原因保持裸值（新行为）');
    check(!result.segments[0].evidence.reasons.includes('visual_change'),
      '输出中不得出现裸的 visual_change');
  });

  await test('② 模型声明的非候选切点：丢弃并写入 debug.warnings', async () => {
    const result = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(segmentJson({
      start: 0,
      end: 180,
      title: '整段',
      type: 'content',
      summary: '',
      confidence: 'low',
      evidence: {
        candidateCutTimes: [45.26, 60, 121.5], // 60 是凭空创造；121.5 在 120.82 的容差内
        reasons: ['visual_change']
      }
    })));

    equal(result.debug.usedAI, true, '走 AI 归并路径');
    deepEqual(result.segments[0].evidence.candidateCutTimes, [45.26, 120.82],
      '容差内的 121.5 归一化为真实切点 120.82');
    check(result.debug.warnings.includes(`${DROPPED_CUT_PREFIX}60`),
      'debug.warnings 记录被丢弃的凭空切点',
      JSON.stringify(result.debug.warnings));
    check(!hasWarning(result.debug.warnings, `${DROPPED_CUT_PREFIX}45.26`),
      '真实切点 45.26 不产生丢弃警告');
    check(!hasWarning(result.debug.warnings, `${DROPPED_CUT_PREFIX}121.5`),
      '容差内的 121.5 不产生丢弃警告');
  });

  await test('③ 真实候选切点为空时：不做核对、原样保留', async () => {
    const result = await mergeSegmentsWithAI({
      bvid: 'BV1test',
      duration: 120,
      candidateCuts: [],
      transcript: []
    }, modelClientReturning(segmentJson({
      start: 0,
      end: 120,
      title: '整段',
      type: 'content',
      summary: '',
      confidence: 'low',
      evidence: { candidateCutTimes: [30.5, 60], reasons: ['visual_change'] }
    })));

    equal(result.debug.usedAI, true, '走 AI 归并路径');
    deepEqual(result.segments[0].evidence.candidateCutTimes, [30.5, 60],
      '无候选切点可比对时原样保留模型声明');
    check(!hasWarning(result.debug.warnings, DROPPED_CUT_PREFIX),
      '无候选切点时不判非法、不留丢弃警告', JSON.stringify(result.debug.warnings));
  });

  await test('④ 三类 AI 失败：降级 fallbackSegmentMerge 且 fallbackReason 正确', async () => {
    // 非 JSON 输出
    const invalidJson = await mergeSegmentsWithAI(BASE_INPUT,
      modelClientReturning('抱歉，我这次无法按要求输出。'));
    equal(invalidJson.debug.usedAI, false, '非 JSON 不使用 AI 结果');
    equal(invalidJson.debug.fallbackReason, 'invalid_ai_json', 'fallbackReason 为 invalid_ai_json');
    check(Array.isArray(invalidJson.segments) && invalidJson.segments.length > 0,
      '降级路径仍产出片段');
    check(hasWarning(invalidJson.debug.warnings, DROPPED_CUT_PREFIX) === false,
      '未走到模型声明核对，不产生丢弃警告');

    // segments 为空
    const emptySegments = await mergeSegmentsWithAI(BASE_INPUT,
      modelClientReturning(JSON.stringify({ segments: [] })));
    equal(emptySegments.debug.usedAI, false, '空 segments 不使用 AI 结果');
    equal(emptySegments.debug.fallbackReason, 'ai_returned_no_segments',
      'fallbackReason 为 ai_returned_no_segments');

    // 请求抛错
    const thrown = await mergeSegmentsWithAI(BASE_INPUT, modelClientThrowing('network down'));
    equal(thrown.debug.usedAI, false, '请求抛错不使用 AI 结果');
    check(thrown.debug.fallbackReason?.startsWith('ai_merge_failed:'),
      'fallbackReason 以 ai_merge_failed: 开头', String(thrown.debug.fallbackReason));
    equal(thrown.debug.fallbackReason, 'ai_merge_failed:network down',
      'fallbackReason 带上原始错误信息');

    // 降级结果与 fallbackSegmentMerge 的确定性输出一致
    deepEqual(
      thrown.segments.map(item => [item.start, item.end]),
      fallbackSegmentMerge(CANDIDATE_CUTS, 180, []).map(item => [item.start, item.end]),
      '降级输出与 fallbackSegmentMerge 一致'
    );
  });

  await test('⑤ snapBoundary：容差内 snapped_to_*、超差 forced_to_*（现状钉住）', () => {
    const context = { duration: 180, candidateCutTimes: [45.26, 120.82] };

    equal(BOUNDARY_SNAP_TOLERANCE_SECONDS, 5, '吸附容差为 5 秒（与 prompt 约定一致）');

    const exact = snapBoundary(120.82, context);
    equal(exact.reason, null, '正好落在锚点时不记 reason');
    equal(exact.time, 120.82, '正好落在锚点时时间不变');

    const within = snapBoundary(47, context);
    equal(within.reason, 'snapped_to_candidate_cut', '容差内吸附记为 snapped_to_candidate_cut');
    equal(within.time, 45.26, '容差内吸附到最近的候选切点');

    const edge = snapBoundary(50.26, context); // 与 45.26 恰好相差 5 秒
    equal(edge.reason, 'snapped_to_candidate_cut', '容差边界值（恰好 5 秒）仍记为 snapped');
    equal(edge.time, 45.26, '容差边界值吸附到候选切点');

    const beyond = snapBoundary(60, context);
    equal(beyond.reason, 'forced_to_candidate_cut', '超差强吸附记为 forced_to_candidate_cut');
    equal(beyond.time, 45.26, '超差时仍拉回最近的候选切点');

    const startSnap = snapBoundary(2, context);
    equal(startSnap.reason, 'snapped_to_start_of_video', '靠近 0 记 snapped_to_start_of_video');
    equal(startSnap.time, 0, '靠近 0 吸附到 0');

    const endSnap = snapBoundary(178, context);
    equal(endSnap.reason, 'snapped_to_end_of_video', '靠近 duration 记 snapped_to_end_of_video');
    equal(endSnap.time, 180, '靠近 duration 吸附到 duration');

    const forcedEnd = snapBoundary(300, context);
    equal(forcedEnd.reason, 'forced_to_end_of_video', '远超 duration 记 forced_to_end_of_video');
    equal(forcedEnd.time, 180, '远超 duration 拉回 duration');

    const noAnchors = snapBoundary(12.5, { duration: 0, candidateCutTimes: [] });
    equal(noAnchors.reason, null, '没有任何锚点时不做吸附');
    equal(noAnchors.time, 12.5, '没有任何锚点时原样返回');

    const invalid = snapBoundary(null, context);
    equal(invalid.time, null, '非数字边界返回 null');
    equal(invalid.reason, null, '非数字边界不记 reason');
  });

  await test('⑥ 模型声明内部原因值：加 model_reason: 前缀，不冒充内部溯源', async () => {
    // 边界与真实候选切点 45.26 / 视频起点 0 完全重合，且不设 fallbackReason：
    // 内部路径（snap / 降级 / validator）都不会真的产生 validator_fallback，测的才是"模型伪造"
    const result = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(segmentJson({
      start: 0,
      end: 45.26,
      title: '开场',
      type: 'intro',
      summary: '开场介绍',
      confidence: 'high',
      evidence: { candidateCutTimes: [45.26], reasons: ['validator_fallback'] }
    })));

    equal(result.debug.usedAI, true, '走 AI 归并路径');
    equal(result.debug.fallbackReason, null, '未降级：内部不会写入 validator_fallback');
    deepEqual(result.segments[0].evidence.reasons, [`${MODEL_REASON_PREFIX}validator_fallback`],
      '模型声明的 validator_fallback 只以 model_reason: 前缀出现');
    check(!result.segments[0].evidence.reasons.includes('validator_fallback'),
      '输出中不得出现裸的 validator_fallback');
  });

  await test('⑦ 多个声明原因：命名空间化 + 去重 + 截断，非法项丢弃', async () => {
    const result = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(segmentJson({
      start: 0,
      end: 45.26,
      title: '开场',
      type: 'intro',
      summary: '开场介绍',
      confidence: 'high',
      evidence: {
        candidateCutTimes: [45.26],
        reasons: ['visual_change', 'visual_change', '', '   ', 42, null, { note: '非字符串' }, '  padded  ', 'A'.repeat(80)]
      }
    })));

    const reasons = result.segments[0].evidence.reasons;
    deepEqual(reasons, [
      `${MODEL_REASON_PREFIX}${'A'.repeat(MODEL_REASON_MAX_LENGTH)}`,
      `${MODEL_REASON_PREFIX}padded`,
      `${MODEL_REASON_PREFIX}visual_change`
    ], '合法项加前缀并去重；空串/纯空白/非字符串丢弃；超长截断');
    check(!reasons.includes('visual_change'), '去重后不留裸值');
    check(reasons.every(reason => reason.length <= MODEL_REASON_PREFIX.length + MODEL_REASON_MAX_LENGTH),
      '每条长度不超过前缀 + 截断上限', JSON.stringify(reasons));
    check(!reasons.some(reason => reason.includes('A'.repeat(MODEL_REASON_MAX_LENGTH + 1))),
      '超长原文被截断到上限以内');
  });

  await test('⑧ snapped_to_* / forced_to_* 仍为裸值（内部溯源回归）', async () => {
    const result = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(segmentJson({
      start: 2,    // 容差内吸附到 0 → snapped_to_start_of_video
      end: 300,    // 远超 duration，强制拉回 180 → forced_to_end_of_video
      title: '整段',
      type: 'content',
      summary: '',
      confidence: 'low',
      evidence: { candidateCutTimes: [], reasons: ['visual_change'] }
    })));

    equal(result.segments[0].start, 0, '起点吸附到 0');
    equal(result.segments[0].end, 180, '终点强制拉回 duration');
    deepEqual(result.segments[0].evidence.reasons, [
      'forced_to_end_of_video',
      `${MODEL_REASON_PREFIX}visual_change`,
      'snapped_to_start_of_video'
    ], '内部 snap 原因保持裸值，模型声明项加前缀');
    check(result.segments[0].evidence.reasons.includes('snapped_to_start_of_video')
      && result.segments[0].evidence.reasons.includes('forced_to_end_of_video'),
      'snapped_to_* / forced_to_* 裸值保留');
  });

  await test('⑨ 端到端：模型声明的内部原因值不会以裸值进入契约 reasons', async () => {
    const merged = await mergeSegmentsWithAI(BASE_INPUT, modelClientReturning(JSON.stringify({
      segments: [
        {
          start: 0,
          end: 45.26,
          title: '开场',
          type: 'intro',
          summary: '开场介绍',
          confidence: 'high',
          evidence: { candidateCutTimes: [45.26], reasons: ['validator_fallback'] }
        },
        {
          start: 45.26,
          end: 180,
          title: '主体',
          type: 'content',
          summary: '主体内容',
          confidence: 'medium',
          evidence: { candidateCutTimes: [120.82], reasons: [] }
        }
      ]
    })));

    equal(merged.debug.usedAI, true, '走 AI 归并路径');
    equal(merged.debug.fallbackReason, null, '未降级：validator 不会补 validator_fallback');

    const validated = validateSegments({
      duration: 180,
      candidateCuts: CANDIDATE_CUTS,
      segments: merged.segments,
      transcript: [],
      fallbackReason: merged.debug.fallbackReason
    });
    const contract = toContractSegments(validated.segments, {
      bvid: 'BV1test',
      duration: 180,
      candidateCuts: validated.candidateCuts,
      transcript: []
    });

    const first = contract.segments[0];
    check(first?.reasons?.includes(`${MODEL_REASON_PREFIX}validator_fallback`),
      '契约 reasons 保留带前缀的模型声明', JSON.stringify(first?.reasons));
    check(contract.segments.every(segment => !segment.reasons.includes('validator_fallback')),
      '契约 reasons 中不存在裸的 validator_fallback',
      JSON.stringify(contract.segments.map(segment => segment.reasons)));
    check(validated.segments.every(segment => !segment.evidence.reasons.includes('validator_fallback')),
      'validator 中间产物里同样没有裸的 validator_fallback');
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
