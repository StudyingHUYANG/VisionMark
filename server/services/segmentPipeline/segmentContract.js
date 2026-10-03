'use strict';

/**
 * 片段契约适配模块（纯函数，不做任何 I/O）。
 *
 * 职责：把流水线内部草稿 segment 映射成跨模块契约对象，供后端持久化、检索建索引、前端展示。
 * 上游（validator）产出的是内部格式：
 *   { start, end, title, type, summary, confidence: 'high'|'medium'|'low', evidence: { candidateCutTimes, reasons } }
 * 出口是契约格式（11 个正式字段 + reasons 溯源字段）：
 *   { segmentId, bvid, page, title, startTime, endTime, description,
 *     evidence: { visual, speech, keyword, cut }, previewTimestamp, confidence, source, reasons }
 *
 * 约定：
 *   1. 正式产物就是契约格式，runSegmentPipeline 的 segments 直接是这批对象；
 *      内部格式只用于流水线内部流转与 debug 产物（debug 里字段名为 internalSegments）。
 *   2. segmentId = {bvid}_{page}_{start}_{end}，start/end 固定 2 位小数；
 *      不含随机数、时间戳、自增计数或 UUID，同一份输入两次运行结果一致。
 *   3. evidence 四桶只放真实证据，不合成：
 *      - visual / keyword / cut：片段起点或终点 5 秒内（沿用 validator 的 ADOPTED_TOLERANCE_SECONDS）
 *        的候选切点时间；visual/keyword 按 candidateCuts[].sources 过滤来源，cut 收全部来源。
 *      - speech：片段区间内的转录文本片段（复用 evidenceBuilder.transcriptSnippet）。
 *      四桶全空时必须写入明确原因值，做到可追溯。
 *   4. confidence 由内部枚举按 CONFIDENCE_MAP 映射为 0~1 数字。
 *   5. 任何修复（截断、重叠、补描述、去重）都写进 warnings，不静默改数据。
 */

const { toFiniteNumber, transcriptSnippet, uniqueSorted, createWarningCollector } = require('./evidenceBuilder');
const {
  ADOPTED_TOLERANCE_SECONDS,
  NO_CANDIDATE_CUT_REASON,
  formatClock
} = require('./segmentValidator');

/** 契约 source 的固定取值 */
const SEGMENT_SOURCE = 'segment_pipeline';
/**
 * page 恒为 1：当前代码没有分 P 概念，下载与分析都只处理 URL 指向的单个视频文件。
 * 已知限制，见接口说明文档。
 */
const PAGE = 1;
/** 契约 evidence 的四个桶，顺序即输出顺序 */
const EVIDENCE_KEYS = ['visual', 'speech', 'keyword', 'cut'];
/** 内部枚举 confidence → 契约数字 confidence（审核方定稿映射，不要自行调整） */
const CONFIDENCE_MAP = { high: 0.8, medium: 0.5, low: 0.2 };
/** 没有 bvid 时 segmentId 的前缀，保证 id 依然稳定 */
const UNKNOWN_BVID = 'unknown';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function roundSeconds(value) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  return Number(number.toFixed(2));
}

function normalizeBvid(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return UNKNOWN_BVID;
}

/** 与 validator 的 isBoundaryMatch 同一判定：切点落在起点或终点 5 秒内 */
function isBoundaryMatch(time, segment) {
  if (!Number.isFinite(time)) return false;
  return Math.abs(time - segment.startTime) <= ADOPTED_TOLERANCE_SECONDS
    || Math.abs(time - segment.endTime) <= ADOPTED_TOLERANCE_SECONDS;
}

/**
 * segmentId：{bvid}_{page}_{start}_{end}，start/end 固定 2 位小数。
 * 只由这四个值决定，不含随机数/时间戳/自增计数。
 */
function buildSegmentId({ bvid, startTime, endTime, page = PAGE }) {
  return `${bvid}_${page}_${startTime.toFixed(2)}_${endTime.toFixed(2)}`;
}

/** 同视频内 id 不得重复：重复时补确定性后缀，并留下警告 */
function ensureUniqueId(id, usedIds, warn) {
  if (!usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let suffix = 2;
  while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
  const unique = `${id}_${suffix}`;
  usedIds.add(unique);
  warn(`duplicate_segment_id_suffixed:${id}`);
  return unique;
}

// ---------------------------------------------------------------------------
// evidence 四桶
// ---------------------------------------------------------------------------

/** 该片段边界附近（起点或终点 5 秒内）的候选切点时间，按需按来源过滤 */
function collectBoundaryCutTimes(candidateCuts, segment, source) {
  const times = (Array.isArray(candidateCuts) ? candidateCuts : [])
    .filter(cut => cut && Number.isFinite(cut.time))
    .filter(cut => isBoundaryMatch(cut.time, segment))
    .filter(cut => {
      if (!source) return true;
      const sources = Array.isArray(cut.sources) ? cut.sources : [];
      return sources.includes(source);
    })
    .map(cut => roundSeconds(cut.time));

  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * 只保留带时间戳的转录行。
 * 没有时间戳时行的 start 是数组下标（行号），直接按区间取会把行号当时间，落到错误的片段里。
 */
function timestampedTranscript(transcript) {
  if (!Array.isArray(transcript)) return transcript;
  return transcript.filter(row => row && row.hasTimestamp === true);
}

/** 片段区间内的转录文本片段；没有转录或区间内无内容时返回空数组 */
function collectSpeech(transcript, segment) {
  const snippet = transcriptSnippet(timestampedTranscript(transcript), segment.startTime, segment.endTime);
  return snippet ? [snippet] : [];
}

/**
 * 构建四桶。四桶全空时，把明确原因值写进 cut 桶（优先用 validator 给的原因，
 * 没有原因时用 no_candidate_cut_matched），保证「依据非空」这条验收规则成立且可追溯。
 */
function buildEvidence(draft, context, warn) {
  const segment = { startTime: draft.startTime, endTime: draft.endTime };
  const evidence = {
    visual: collectBoundaryCutTimes(context.candidateCuts, segment, 'visual'),
    speech: collectSpeech(context.transcript, segment),
    keyword: collectBoundaryCutTimes(context.candidateCuts, segment, 'keyword'),
    cut: collectBoundaryCutTimes(context.candidateCuts, segment, null)
  };

  if (EVIDENCE_KEYS.every(key => evidence[key].length === 0)) {
    // resolveReasons 保证非空：没有声明原因时给 no_candidate_cut_matched
    evidence.cut = resolveReasons(draft, warn);
    warn(`segment_without_cut_evidence:${draft.title || 'unknown'}`);
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// 其它字段
// ---------------------------------------------------------------------------

/**
 * previewTimestamp：优先取距区间中点最近的候选切点时间（候选切点须在区间内，
 * 否则会违反 startTime <= previewTimestamp <= endTime），没有候选切点时取中点。
 */
function pickPreviewTimestamp(draft, candidateCuts) {
  const midpoint = (draft.startTime + draft.endTime) / 2;
  const inside = (Array.isArray(candidateCuts) ? candidateCuts : [])
    .filter(cut => cut && Number.isFinite(cut.time)
      && cut.time >= draft.startTime && cut.time <= draft.endTime);

  if (inside.length === 0) return roundSeconds(midpoint);

  const nearest = inside
    .slice()
    .sort((a, b) => Math.abs(a.time - midpoint) - Math.abs(b.time - midpoint) || a.time - b.time)[0];

  return roundSeconds(Math.min(Math.max(nearest.time, draft.startTime), draft.endTime));
}

/** 内部枚举 → 0~1 数字；枚举非法时按 low 处理 */
function mapConfidence(internalConfidence) {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_MAP, internalConfidence)
    ? CONFIDENCE_MAP[internalConfidence]
    : CONFIDENCE_MAP.low;
}

/** 边界依据：validator 已给原因，这里只去重；为空时补明确原因值 */
function resolveReasons(draft, warn) {
  const reasons = uniqueSorted(
    (Array.isArray(draft?.evidence?.reasons) ? draft.evidence.reasons : [])
      .filter(reason => typeof reason === 'string' && reason.trim())
  );
  if (reasons.length > 0) return reasons;
  warn(`segment_without_reasons:${draft?.title || 'unknown'}`);
  return [NO_CANDIDATE_CUT_REASON];
}

/** description 取自内部 summary（validator 已含兜底），这里保证绝不为空 */
function resolveDescription(draft, warn) {
  const description = typeof draft?.summary === 'string' ? draft.summary.trim() : '';
  if (description) return description;
  warn(`segment_description_filled_with_structural_text:${draft?.title || 'unknown'}`);
  return `本片段未获得内容描述；区间 ${formatClock(draft.startTime)} - ${formatClock(draft.endTime)}。`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 单个内部 segment → 契约 segment；时间非法时返回 null 并记警告 */
function buildContractSegment(draft, context, usedIds, warn) {
  const name = draft?.title || 'unknown';
  const rawStart = roundSeconds(draft?.start);
  const rawEnd = roundSeconds(draft?.end);

  if (rawStart === null || rawEnd === null) {
    warn(`dropped_segment_missing_time:${name}`);
    return null;
  }

  const duration = toFiniteNumber(context.duration);
  let startTime = Math.max(0, rawStart);
  if (startTime !== rawStart) warn(`clamped_segment_start_to_zero:${name}`);

  let endTime = rawEnd;
  if (duration !== null && duration > 0 && endTime > duration) {
    warn(`clamped_segment_end_to_duration:${name}`);
    endTime = duration;
  }

  // 片段不得无解释地互相覆盖：与前一段区间重叠时收窄起点
  const previousEnd = toFiniteNumber(context.previousEnd);
  if (previousEnd !== null && startTime < previousEnd) {
    warn(`repaired_segment_overlap_in_contract:${name}`);
    startTime = previousEnd;
  }

  if (!(endTime > startTime)) {
    warn(`dropped_segment_invalid_range:${name}`);
    return null;
  }

  const bvid = context.bvid;
  const normalizedDraft = { ...draft, startTime, endTime };

  return {
    segmentId: ensureUniqueId(buildSegmentId({ bvid, startTime, endTime }), usedIds, warn),
    bvid,
    page: PAGE,
    title: name,
    startTime,
    endTime,
    description: resolveDescription(normalizedDraft, warn),
    evidence: buildEvidence(normalizedDraft, context, warn),
    previewTimestamp: pickPreviewTimestamp(normalizedDraft, context.candidateCuts),
    confidence: mapConfidence(draft?.confidence),
    source: SEGMENT_SOURCE,
    // 溯源字段：记录边界依据与降级原因，供回溯使用，不替代 evidence
    reasons: resolveReasons(draft, warn)
  };
}

/**
 * 契约化入口。
 *
 * @param {Array} segments validator 产出的内部片段（按时间升序）
 * @param {Object} context { bvid, duration, candidateCuts, transcript }
 * @returns {{ segments: Array, warnings: string[] }}
 */
function toContractSegments(segments, context = {}) {
  const warnings = [];
  const warn = createWarningCollector(warnings);

  const safeContext = {
    bvid: normalizeBvid(context.bvid),
    duration: toFiniteNumber(context.duration),
    candidateCuts: Array.isArray(context.candidateCuts) ? context.candidateCuts : [],
    transcript: context.transcript || []
  };

  const usedIds = new Set();
  const contractSegments = [];
  let previousEnd = null;

  for (const draft of Array.isArray(segments) ? segments : []) {
    const segment = buildContractSegment(draft, { ...safeContext, previousEnd }, usedIds, warn);
    if (!segment) continue;

    previousEnd = segment.endTime;
    contractSegments.push(segment);
  }

  if (contractSegments.length === 0) warn('no_contract_segments');

  return { segments: contractSegments, warnings };
}

module.exports = {
  toContractSegments,
  buildSegmentId,
  pickPreviewTimestamp,
  mapConfidence,
  PAGE,
  SEGMENT_SOURCE,
  EVIDENCE_KEYS,
  CONFIDENCE_MAP,
  NO_CANDIDATE_CUT_REASON
};
