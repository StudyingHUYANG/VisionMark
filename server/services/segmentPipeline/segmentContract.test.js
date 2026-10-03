'use strict';

/**
 * 片段契约测试
 *
 * 运行方式: node server/services/segmentPipeline/segmentContract.test.js
 *
 * 覆盖:
 * ① 11 个契约字段全部存在且类型正确
 * ② 0 <= startTime < endTime <= duration，previewTimestamp 落在区间内
 * ③ segmentId 同输入两次一致、同视频内不重复
 * ④ evidence 至少一个桶非空；无证据时 reasons / cut 有明确原因值
 * ⑤ 降级路径（duration=0、segments 为空、候选切点为空）不抛异常且返回契约格式
 *
 * 全部用例均为确定性测试：不访问网络、不使用真实 API Key / Cookie、不写数据库。
 */

const { toContractSegments, CONFIDENCE_MAP, NO_CANDIDATE_CUT_REASON, PAGE } = require('./segmentContract');
const { runSegmentPipeline } = require('./index');

// ---------------------------------------------------------------------------
// 断言与测试框架（保持与仓库现有脚本风格一致）
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
// 契约校验（按执行说明第四节的验收规则）
// ---------------------------------------------------------------------------

const CONTRACT_FIELDS = [
  ['segmentId', 'string'],
  ['bvid', 'string'],
  ['page', 'number'],
  ['title', 'string'],
  ['startTime', 'number'],
  ['endTime', 'number'],
  ['description', 'string'],
  ['evidence', 'object'],
  ['previewTimestamp', 'number'],
  ['confidence', 'number'],
  ['source', 'string']
];
const EVIDENCE_KEYS = ['visual', 'speech', 'keyword', 'cut'];
/** 内部格式字段不得出现在正式产物里 */
const FORBIDDEN_FIELDS = ['start', 'end', 'summary', 'type', 'candidateCutTimes'];

function checkContractSegment(segment, { duration, label }) {
  for (const [field, type] of CONTRACT_FIELDS) {
    check(Object.prototype.hasOwnProperty.call(segment, field), `${label} 含字段 ${field}`);
    check(typeof segment[field] === type, `${label} ${field} 类型为 ${type}`,
      `实际 ${typeof segment[field]}`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    check(!Object.prototype.hasOwnProperty.call(segment, field), `${label} 不含内部字段 ${field}`);
  }

  check(Number.isFinite(segment.startTime) && segment.startTime >= 0, `${label} startTime >= 0`);
  check(segment.endTime > segment.startTime, `${label} endTime > startTime`);
  check(segment.endTime <= duration, `${label} endTime <= duration`);
  check(segment.page === PAGE, `${label} page 恒为 ${PAGE}`);
  check(segment.source === 'segment_pipeline', `${label} source 为 segment_pipeline`);
  check(segment.description.trim().length > 0, `${label} description 非空`,
    `实际 ${JSON.stringify(segment.description)}`);
  check(segment.confidence >= 0 && segment.confidence <= 1, `${label} confidence 在 0~1`);

  check(segment.evidence && typeof segment.evidence === 'object', `${label} evidence 为对象`);
  for (const key of EVIDENCE_KEYS) {
    check(Array.isArray(segment.evidence?.[key]), `${label} evidence.${key} 为数组`);
  }
  const nonEmptyBuckets = EVIDENCE_KEYS.filter(key => (segment.evidence?.[key] || []).length > 0);
  check(nonEmptyBuckets.length >= 1, `${label} evidence 至少一个桶非空`);

  check(segment.previewTimestamp >= segment.startTime
    && segment.previewTimestamp <= segment.endTime,
    `${label} previewTimestamp 落在区间内`,
    `实际 ${segment.previewTimestamp}，区间 ${segment.startTime}~${segment.endTime}`);

  check(segment.segmentId === `${segment.bvid}_${segment.page}_${segment.startTime.toFixed(2)}_${segment.endTime.toFixed(2)}`,
    `${label} segmentId 形如 {bvid}_{page}_{start}_{end}（2 位小数）`,
    `实际 ${segment.segmentId}`);
}

function checkTimeline(segments, { duration, label }) {
  for (const [index, segment] of segments.entries()) {
    checkContractSegment(segment, { duration, label: `${label}片段${index + 1}` });
  }
  for (let i = 1; i < segments.length; i += 1) {
    check(segments[i].startTime >= segments[i - 1].endTime, `${label} 第 ${i + 1} 段不与前一段覆盖`);
  }
  const ids = segments.map(segment => segment.segmentId);
  equal(new Set(ids).size, ids.length, `${label} segmentId 无重复`);
}

// ---------------------------------------------------------------------------
// 测试素材
// ---------------------------------------------------------------------------

const TRANSCRIPT = [
  { start: 3, end: 3, text: '大家好，今天我们先介绍项目背景。', hasTimestamp: true },
  { start: 45, end: 45, text: '接下来我们看核心功能。', hasTimestamp: true },
  { start: 122, end: 122, text: '总结一下，主要结论是这样的。', hasTimestamp: true }
];

const PIPELINE_INPUT = {
  videoId: 'BV1test',
  bvid: 'BV1test',
  duration: 180,
  visualCuts: [
    { time: 44, score: 0.82, reasons: ['visual_change'] },
    { time: 118, score: 0.68, reasons: ['scene_change'] }
  ],
  audioCuts: [{ time: 47, score: 0.7, reasons: ['audio_pause'] }],
  keywordCuts: [{ time: 122, score: 0.9, reasons: ['keyword:总结一下'], keyword: '总结一下' }],
  transcript: TRANSCRIPT
};

/** 融合后的候选切点（与 PIPELINE_INPUT 对应），用于直接测适配模块 */
const FUSED_CANDIDATE_CUTS = [
  { time: 45.26, score: 0.985, reasons: ['visual_change'], sources: ['visual', 'audio', 'text'], adopted: true },
  { time: 120.82, score: 0.991, reasons: ['keyword:总结一下'], sources: ['keyword', 'visual', 'text'], adopted: true }
];

function draftSegment(overrides = {}) {
  return {
    start: 0,
    end: 45.26,
    title: 'Segment 1',
    type: 'content',
    summary: '开场介绍',
    confidence: 'high',
    evidence: { candidateCutTimes: [45.26], reasons: ['visual_change'] },
    ...overrides
  };
}

function adapt(segments, overrides = {}) {
  return toContractSegments(segments, {
    bvid: 'BV1test',
    duration: 180,
    candidateCuts: FUSED_CANDIDATE_CUTS,
    transcript: TRANSCRIPT,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  await test('① 契约字段与类型', () => {
    const { segments } = adapt([draftSegment()]);

    equal(segments.length, 1, '产出 1 个片段');
    checkTimeline(segments, { duration: 180, label: '契约' });
    equal(segments[0].previewTimestamp, 45.26, 'previewTimestamp 取区间内候选切点');
    equal(segments[0].confidence, CONFIDENCE_MAP.high, 'high 映射为 0.8');
    equal(segments[0].segmentId, 'BV1test_1_0.00_45.26', 'segmentId 固定 2 位小数');
  });

  await test('④ evidence 四桶按来源与区间归集', () => {
    // 与降级路径实际产出的三段边界一致：45.26 与 120.82 是融合后的候选切点
    const { segments } = adapt([
      draftSegment({ start: 0, end: 45.26 }),
      draftSegment({ start: 45.26, end: 120.82, title: 'Segment 2' }),
      draftSegment({ start: 120.82, end: 180, title: 'Segment 3' })
    ]);

    equal(segments[0].evidence.visual.length, 1, '边界切点按 visual 来源进 visual 桶');
    equal(segments[0].evidence.keyword.length, 0, 'visual 来源的切点不进 keyword 桶');
    equal(segments[0].evidence.cut.length, 1, 'cut 桶收全部来源的边界切点');
    equal(segments[0].evidence.speech.length, 1, 'speech 桶放区间内转录文本片段');
    check(segments[0].evidence.speech[0].includes('大家好，今天我们先介绍项目背景。'), 'speech 是转录原文');

    equal(segments[2].evidence.keyword.length, 1, 'keyword 来源的边界切点进 keyword 桶');
    equal(segments[2].evidence.cut[0], 120.82, 'cut 桶放切点时间');
    equal(segments[2].evidence.speech[0], '总结一下，主要结论是这样的。', 'speech 只取区间内的转录');
    equal(segments[1].evidence.speech.length, 0, '区间内没有转录时 speech 桶为空');

    check(typeof segments[0].evidence.visual[0] === 'number', 'visual 桶放的是时间（数字）');
    for (const segment of segments) {
      for (const key of EVIDENCE_KEYS) {
        for (const item of segment.evidence[key]) {
          check(typeof item !== 'number' || Number(item.toFixed(2)) === item, '证据时间保留 2 位小数');
        }
      }
    }

    // 没有时间戳的转录行 start 是行号，不能当证据时间用
    const untimed = adapt([draftSegment({ start: 0, end: 45.26 })], {
      transcript: [
        { start: 0, end: 0, text: '第一行', hasTimestamp: false },
        { start: 1, end: 1, text: '第二行', hasTimestamp: false }
      ]
    });
    equal(untimed.segments[0].evidence.speech.length, 0, '无时间戳转录不作为语音证据');
  });

  await test('④ 无证据时写入明确原因值', () => {
    const noEvidence = draftSegment({ evidence: { candidateCutTimes: [], reasons: ['validator_fallback'] } });
    const first = adapt([noEvidence], { candidateCuts: [], transcript: [] });
    equal(first.segments[0].evidence.cut[0], 'validator_fallback', 'cut 桶写入 validator 给出的原因值');
    check(first.segments[0].reasons.includes('validator_fallback'), 'reasons 保留原因值');
    check(first.warnings.includes('segment_without_cut_evidence:Segment 1'), '留下降级警告');

    const noReason = draftSegment({ evidence: { candidateCutTimes: [], reasons: [] } });
    const second = adapt([noReason], { candidateCuts: [], transcript: [] });
    equal(second.segments[0].evidence.cut[0], NO_CANDIDATE_CUT_REASON, '无原因时写入 no_candidate_cut_matched');
    check(second.warnings.includes('segment_without_reasons:Segment 1'), '缺原因有警告');
  });

  await test('② previewTimestamp 取值规则', () => {
    // 区间内没有候选切点 → 取中点
    const noCut = adapt([draftSegment({ start: 0, end: 45.26 })], { candidateCuts: [] });
    equal(noCut.segments[0].previewTimestamp, 22.63, '无候选切点时取区间中点');

    // 区间内有多个候选切点 → 取离中点最近的（中点 50，78 比 80 更近）
    const candidates = [
      { time: 10, score: 0.6, sources: ['visual'] },
      { time: 80, score: 0.6, sources: ['visual'] },
      { time: 78, score: 0.6, sources: ['visual'] }
    ];
    const nearest = adapt([draftSegment({ start: 0, end: 100 })], { candidateCuts: candidates });
    equal(nearest.segments[0].previewTimestamp, 78, '取距中点最近的候选切点');

    // 候选切点在区间外时不使用，避免越界
    const outside = adapt([draftSegment({ start: 0, end: 30 })], {
      candidateCuts: [{ time: 25, score: 0.6, sources: ['visual'] }, FUSED_CANDIDATE_CUTS[0]]
    });
    equal(outside.segments[0].previewTimestamp, 25, '区间外的候选切点不参与选择');
  });

  await test('③ segmentId 稳定且不重复', () => {
    const first = adapt([draftSegment(), draftSegment({ start: 45.26, end: 120.82, title: 'Segment 2', type: 'content' })]);
    const second = adapt([draftSegment(), draftSegment({ start: 45.26, end: 120.82, title: 'Segment 2', type: 'content' })]);

    equal(
      JSON.stringify(first.segments.map(item => item.segmentId)),
      JSON.stringify(second.segments.map(item => item.segmentId)),
      '同一输入两次得到完全一致的 segmentId'
    );
    checkTimeline(first.segments, { duration: 180, label: '重复输入' });

    // 同一区间重复出现时会被重叠修复收窄成零长片段并丢弃，因此不可能产出重复 id
    const duplicated = adapt([draftSegment(), draftSegment({ title: 'Segment 1 duplicate' })]);
    equal(duplicated.segments.length, 1, '重复区间被丢弃，不产出重复 id');
    check(duplicated.warnings.some(item => item.startsWith('dropped_segment_invalid_range')), '丢弃有警告');
    checkTimeline(duplicated.segments, { duration: 180, label: '重复输入' });
  });

  await test('② 越界与重叠被修复且留有警告', () => {
    const { segments, warnings } = adapt([
      draftSegment({ start: 10, end: 60 }),
      draftSegment({ start: 50, end: 500, title: 'Segment 2' })
    ]);

    equal(segments[0].startTime, 10, '首段起点保持');
    equal(segments[1].startTime, 60, '重叠区间收窄到前一段终点');
    equal(segments[1].endTime, 180, '超过视频时长的终点被截断');
    checkTimeline(segments, { duration: 180, label: '越界输入' });
    check(warnings.includes('repaired_segment_overlap_in_contract:Segment 2'), '重叠修复有警告');
    check(warnings.includes('clamped_segment_end_to_duration:Segment 2'), '越界截断有警告');
  });

  await test('⑤ 降级路径：duration=0 / segments 为空 / 候选切点为空', async () => {
    // duration = 0
    const zeroDuration = await runSegmentPipeline({ bvid: 'BV1test', transcript: TRANSCRIPT });
    check(Array.isArray(zeroDuration.segments), 'duration=0 时仍返回契约格式（segments 数组）');
    equal(zeroDuration.segments.length, 0, 'duration=0 时不臆造片段');
    check(zeroDuration.debug.warnings.includes('duration_missing_or_zero'), '说明原因');

    // segments 为空
    const emptySegments = adapt([]);
    check(Array.isArray(emptySegments.segments), 'segments 为空时返回数组');
    equal(emptySegments.segments.length, 0, 'segments 为空时不产出片段');
    check(emptySegments.warnings.includes('no_contract_segments'), '说明原因');

    // 候选切点为空 + 无任何检测器证据：30 秒短片段不会插入 time_padding 补点
    const noCuts = await runSegmentPipeline({ bvid: 'BV1test', duration: 30, transcript: [] });
    equal(noCuts.segments.length, 1, '无证据时降级为整段一个片段');
    checkTimeline(noCuts.segments, { duration: 30, label: '无证据降级' });
    equal(noCuts.segments[0].evidence.cut[0], 'fallback_merge', '无候选切点时 cut 桶写入明确原因值');
    equal(noCuts.segments[0].confidence, CONFIDENCE_MAP.low, 'low → 0.2');
    check(noCuts.segments[0].reasons.includes('model_client_unavailable'), 'reasons 记录降级原因');

    // 长视频会插入 time_padding 补点，同样必须返回契约格式
    const padded = await runSegmentPipeline({ bvid: 'BV1test', duration: 120, transcript: [] });
    check(padded.segments.length > 1, '超长空档插入补点后切出多段');
    checkTimeline(padded.segments, { duration: 120, label: '补点降级' });
  });

  await test('无模型客户端：runSegmentPipeline 直接返回契约格式', async () => {
    const result = await runSegmentPipeline(PIPELINE_INPUT);
    const again = await runSegmentPipeline(PIPELINE_INPUT);

    check(result.segments.length > 0, '降级路径仍产出片段');
    checkTimeline(result.segments, { duration: result.duration, label: '降级' });
    equal(result.debug.usedAI, false, '未使用模型');
    equal(
      JSON.stringify(result.segments.map(item => item.segmentId)),
      JSON.stringify(again.segments.map(item => item.segmentId)),
      '同输入两次运行的 segmentId 完全一致'
    );
    equal(result.segments[0].segmentId, 'BV1test_1_0.00_45.26', 'segmentId 与候选切点边界一致');
    equal(result.segments[0].confidence, CONFIDENCE_MAP.high, '降级路径 confidence 仍是 0~1 数字');
    check(result.segments[0].evidence.visual.length > 0, 'visual 桶有边界切点证据');
    check(result.segments[0].reasons.includes('model_client_unavailable'), 'reasons 记录降级原因');
  });

  await test('AI 归并路径：runSegmentPipeline 直接返回契约格式', async () => {
    const modelClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  segments: [
                    {
                      start: 0,
                      end: 60,
                      title: '开场',
                      type: 'intro',
                      summary: '开场介绍',
                      confidence: 'high',
                      evidence: { candidateCutTimes: [60], reasons: ['visual_change'] }
                    },
                    {
                      start: 60,
                      end: 120,
                      title: '正片',
                      type: 'content',
                      summary: '主要内容',
                      confidence: 'medium',
                      evidence: { candidateCutTimes: [60], reasons: ['visual_change'] }
                    }
                  ]
                })
              }
            }]
          })
        }
      }
    };

    const result = await runSegmentPipeline({
      bvid: 'BV1test',
      duration: 120,
      visualCuts: [{ time: 60, score: 0.8, reasons: ['visual_change'] }],
      transcript: TRANSCRIPT
    }, { modelClient });

    equal(result.debug.usedAI, true, '走 AI 归并路径');
    equal(result.segments.length, 2, '产出 2 个片段');
    equal(result.segments[0].title, '开场', '标题来自模型输出');
    checkTimeline(result.segments, { duration: 120, label: 'AI' });
    equal(result.segments[0].confidence, CONFIDENCE_MAP.high, 'high → 0.8');
    equal(result.segments[1].confidence, CONFIDENCE_MAP.medium, 'medium → 0.5');
    equal(result.segments[0].description, '开场介绍', 'description 取自内部 summary');
    check(result.segments[0].evidence.cut.includes(60), 'cut 桶带边界候选切点');
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
