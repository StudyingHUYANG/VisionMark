'use strict';

/**
 * 语义合并：把候选切点交给模型归并成最终片段。
 *
 * 关键约束：模型只能在「候选切点 / 0 / duration」这些锚点上取边界，
 * 超差时强制拉回最近锚点，绝不接受模型凭空创造的时间点。
 * 任何一步失败（无模型 / 请求异常 / 非 JSON / 空结果 / 字段非法）都降级到
 * fallbackSegmentMerge，不向上抛异常。
 */

const { buildSemanticMergePrompt, extractJsonFromModelOutput } = require('./semanticMergePrompt');
const {
  toFiniteNumber,
  parseTimeToSeconds,
  normalizeTranscript,
  transcriptSnippet,
  uniqueSorted,
  createWarningCollector
} = require('./evidenceBuilder');

const VALID_TYPES = new Set(['intro', 'content', 'ad', 'summary', 'transition', 'unknown']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

/** 与 prompt 中「不能偏离最近候选切点超过 5 秒」的约定保持一致 */
const BOUNDARY_SNAP_TOLERANCE_SECONDS = 5;
/** fallback 合并时两个边界至少相差这么多秒，避免产生零长片段 */
const MIN_BOUNDARY_GAP_SECONDS = 1;
/** fallback 里判定「这个边界来自哪个候选切点」的容差 */
const BOUNDARY_MATCH_TOLERANCE_SECONDS = 1;
/**
 * 模型声明原因值的命名空间前缀。
 *
 * 为什么必须加：契约的 reasons 是溯源字段（内部取值如 boundary_from_candidate_cut /
 * validator_fallback / fallback_merge / snapped_to_*），下游会把它当作「流水线为什么这么切」
 * 的证据来解读。若不加前缀，模型只要在 evidence.reasons 里写 "validator_fallback"，
 * 就能冒充内部降级原因、把溯源信息搞脏——与「模型声明的 candidateCutTimes 必须落在真实
 * 候选切点上」是同一类防护。加前缀后模型原文仍保留、可回溯，但不可能再冒充内部原因值。
 */
const MODEL_REASON_PREFIX = 'model_reason:';
/** 模型原因原文的截断长度：防止超长文本把契约 reasons 字段撑爆（前缀不计入） */
const MODEL_REASON_MAX_LENGTH = 60;
function confidenceFromScore(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function resolveCandidateCutTimes(candidateCuts) {
  if (!Array.isArray(candidateCuts)) return [];
  return [...new Set(
    candidateCuts
      .map(cut => toFiniteNumber(cut?.time))
      .filter(time => time !== null && time >= 0)
  )].sort((a, b) => a - b);
}

/**
 * 把模型给的边界吸附到锚点（候选切点 / 0 / duration）。
 * 容差内记为 snapped，超差记为 forced —— 两者都会写进 evidence.reasons，便于回溯。
 */
function snapBoundary(value, context = {}) {
  if (!Number.isFinite(value)) return { time: null, reason: null };

  const { candidateCutTimes = [], duration = 0 } = context;
  const anchors = [];

  if (Number.isFinite(duration) && duration > 0) {
    anchors.push({ time: 0, label: 'start_of_video' });
    anchors.push({ time: duration, label: 'end_of_video' });
  }
  for (const time of candidateCutTimes) {
    anchors.push({ time, label: 'candidate_cut' });
  }

  if (anchors.length === 0) return { time: value, reason: null };

  let best = null;
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.time - value);
    if (best === null || distance < best.distance) {
      best = { time: anchor.time, label: anchor.label, distance };
    }
  }

  if (best.distance === 0) return { time: best.time, reason: null };
  if (best.distance <= BOUNDARY_SNAP_TOLERANCE_SECONDS) {
    return { time: best.time, reason: `snapped_to_${best.label}` };
  }
  return { time: best.time, reason: `forced_to_${best.label}` };
}

/**
 * 核对模型声明的候选切点：只接受真实候选切点集合里的时间。
 *
 * 为什么不能直接采信：契约层（segmentContract）虽然会从真实 candidateCuts 反查证据，
 * 但内部 evidence.candidateCutTimes 会被 segmentValidator.attachCandidateCutEvidence
 * 合并进证据数组、并出现在 debug 产物里；若放任模型随口写数字，等于在内部证据中
 * 留下「凭空创造的时间点」，与文件头「绝不接受模型凭空创造的时间点」的约束矛盾。
 *
 * 判定容差与 snapBoundary 保持一致：容差内视为同一个切点，但保留真实切点的时间值
 * （避免 45.25999 这类模型近似小数进入证据）；容差外直接丢弃并留 warning。
 * 真实候选切点集合为空时无从核对，原样放行，避免把全部声明误判为非法。
 */
function normalizeDeclaredCutTimes(values, candidateCutTimes, warn) {
  const declared = Array.isArray(values)
    ? values
      .map(parseTimeToSeconds)
      .filter(time => time !== null && time >= 0)
    : [];

  const candidates = Array.isArray(candidateCutTimes) ? candidateCutTimes : [];
  if (candidates.length === 0) return declared;

  const kept = [];
  for (const time of declared) {
    let nearest = null;
    for (const candidate of candidates) {
      if (nearest === null || Math.abs(candidate - time) < Math.abs(nearest - time)) {
        nearest = candidate;
      }
    }
    if (nearest !== null && Math.abs(nearest - time) <= BOUNDARY_SNAP_TOLERANCE_SECONDS) {
      kept.push(nearest);
    } else {
      warn(`dropped_ai_declared_cut_not_in_candidates:${time}`);
    }
  }
  return kept;
}

function clampToDuration(time, duration) {
  if (!Number.isFinite(time)) return null;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, time);
  return Math.max(0, Math.min(duration, time));
}

/**
 * 模型声明的原因值 → 带命名空间的原因值。
 *
 * 空字符串 / 纯空白 / 非字符串照旧丢弃；合法项 trim 后截断到 MODEL_REASON_MAX_LENGTH
 * 再拼前缀。去重不在这里做：与 snapReasons 合并后由 uniqueSorted 统一处理，
 * 保证「模型声明」与「内部原因」在同一集合里只出现一次。
 */
function normalizeModelReasons(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter(reason => typeof reason === 'string' && reason.trim())
    .map(reason => `${MODEL_REASON_PREFIX}${reason.trim().slice(0, MODEL_REASON_MAX_LENGTH)}`);
}

/**
 * 单个 AI segment 归一化。
 * 时间无法解析、吸附后区间非法时返回 null，由调用方统计并决定是否降级。
 */
function normalizeSegment(segment, index, context = {}) {
  const { duration = 0, warn = () => {} } = context;
  const title = typeof segment?.title === 'string' && segment.title.trim()
    ? segment.title.trim()
    : `Segment ${index + 1}`;

  const rawStart = parseTimeToSeconds(segment?.start);
  const rawEnd = parseTimeToSeconds(segment?.end);
  if (rawStart === null || rawEnd === null) {
    warn(`dropped_ai_segment_missing_time:${title}`);
    return null;
  }

  const startSnap = snapBoundary(rawStart, context);
  const endSnap = snapBoundary(rawEnd, context);
  const start = clampToDuration(startSnap.time, duration);
  const end = clampToDuration(endSnap.time, duration);

  if (start === null || end === null || !(end > start)) {
    warn(`dropped_ai_segment_invalid_range:${title}`);
    return null;
  }

  // 模型声明的原因值加 model_reason: 前缀（见常量注释）；下方 snapReasons 是内部溯源，保持裸值
  const reasons = normalizeModelReasons(segment?.evidence?.reasons);
  const declaredCuts = normalizeDeclaredCutTimes(
    segment?.evidence?.candidateCutTimes,
    context.candidateCutTimes,
    warn
  );

  const snapReasons = [startSnap.reason, endSnap.reason].filter(Boolean);

  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    title,
    type: VALID_TYPES.has(segment?.type) ? segment.type : 'unknown',
    summary: typeof segment?.summary === 'string' ? segment.summary.trim() : '',
    confidence: VALID_CONFIDENCE.has(segment?.confidence) ? segment.confidence : 'low',
    evidence: {
      candidateCutTimes: [...new Set(declaredCuts)].sort((a, b) => a - b),
      reasons: uniqueSorted([...reasons, ...snapReasons])
    }
  };
}

/**
 * 无模型可用时的降级合并：直接按候选切点切分，保证连续覆盖 [0, duration]。
 */
function fallbackSegmentMerge(candidateCuts, duration = 0, transcript = '') {
  const validDuration = toFiniteNumber(duration);
  if (validDuration === null || validDuration <= 0) return [];

  const sortedCuts = (Array.isArray(candidateCuts) ? candidateCuts : [])
    .map(cut => ({ cut, time: toFiniteNumber(cut?.time) }))
    .filter(item => item.time !== null && item.time > 0 && item.time < validDuration)
    .sort((a, b) => a.time - b.time);

  const cutTimes = [...new Set(sortedCuts.map(item => item.time))].sort((a, b) => a - b);

  const boundaries = [0, ...cutTimes, validDuration]
    .filter((time, index, list) => index === 0 || time - list[index - 1] >= MIN_BOUNDARY_GAP_SECONDS);

  if (boundaries.length < 2) boundaries.push(validDuration);

  const rows = Array.isArray(transcript) ? transcript : normalizeTranscript(transcript);
  const hasTranscript = rows.length > 0;

  const averageScore = cutTimes.length > 0
    ? sortedCuts.reduce((sum, item) => sum + (toFiniteNumber(item.cut?.score) ?? 0), 0) / sortedCuts.length
    : 0;
  const baseScore = hasTranscript ? Math.max(averageScore, 0.45) : averageScore;
  const fallbackConfidence = confidenceFromScore(baseScore);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (!(end > start)) continue;

    const matched = sortedCuts.find(item => Math.abs(item.time - end) <= BOUNDARY_MATCH_TOLERANCE_SECONDS);
    const matchedReasons = Array.isArray(matched?.cut?.reasons) ? matched.cut.reasons.filter(Boolean) : [];
    const matchedSources = Array.isArray(matched?.cut?.sources) ? matched.cut.sources.filter(Boolean) : [];

    segments.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      title: `Segment ${segments.length + 1}`,
      type: 'content',
      summary: transcriptSnippet(rows, start, end),
      confidence: fallbackConfidence,
      evidence: {
        candidateCutTimes: matched ? [Number(matched.time.toFixed(2))] : [],
        reasons: matched
          ? uniqueSorted([...matchedReasons, 'boundary_from_candidate_cut', ...matchedSources.map(s => `source:${s}`)])
          : ['fallback_merge']
      }
    });
  }

  return segments;
}

async function mergeSegmentsWithAI(input = {}, modelClient = null) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const duration = toFiniteNumber(safeInput.duration) ?? 0;
  const candidateCuts = Array.isArray(safeInput.candidateCuts) ? safeInput.candidateCuts : [];
  const candidateCutTimes = resolveCandidateCutTimes(candidateCuts);

  const warnings = [];
  const warn = createWarningCollector(warnings);
  const context = { duration, candidateCutTimes, warn };

  let prompt = null;
  try {
    prompt = buildSemanticMergePrompt(safeInput);
  } catch (error) {
    warn(`prompt_build_failed:${error.message}`);
  }

  const debug = {
    usedAI: false,
    fallbackReason: null,
    aiPromptPreview: typeof prompt === 'string' ? prompt.slice(0, 2000) : null,
    aiRawOutput: null,
    warnings
  };

  const useFallback = (reason) => {
    debug.fallbackReason = reason;
    debug.usedAI = false;
    return {
      segments: fallbackSegmentMerge(candidateCuts, duration, safeInput.transcript),
      debug
    };
  };

  if (!modelClient || typeof modelClient.chat?.completions?.create !== 'function') {
    return useFallback('model_client_unavailable');
  }
  if (typeof prompt !== 'string' || !prompt) {
    return useFallback('prompt_unavailable');
  }
  if (!(duration > 0)) {
    return useFallback('duration_missing_or_zero');
  }

  let content = '';
  try {
    const response = await modelClient.chat.completions.create({
      model: safeInput.modelConfig?.textModel || safeInput.modelConfig?.visionModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2200,
      temperature: 0.2
    });
    content = response?.choices?.[0]?.message?.content || '';
  } catch (error) {
    return useFallback(`ai_merge_failed:${error.message}`);
  }

  debug.aiRawOutput = content;

  const parsed = extractJsonFromModelOutput(content);
  if (!parsed) return useFallback('invalid_ai_json');

  const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  if (rawSegments.length === 0) return useFallback('ai_returned_no_segments');

  const segments = rawSegments
    .map((segment, index) => normalizeSegment(segment, index, context))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (segments.length === 0) return useFallback('ai_segments_unusable');

  debug.usedAI = true;
  debug.fallbackReason = null;
  return { segments, debug };
}

module.exports = {
  mergeSegmentsWithAI,
  fallbackSegmentMerge,
  normalizeSegment,
  snapBoundary,
  BOUNDARY_SNAP_TOLERANCE_SECONDS,
  MODEL_REASON_PREFIX,
  MODEL_REASON_MAX_LENGTH
};
