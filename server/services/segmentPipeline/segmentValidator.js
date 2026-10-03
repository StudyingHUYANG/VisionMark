'use strict';

/**
 * 分段校验与修复。
 *
 * 对外承诺：返回的每个 segment 一定满足
 *   0 <= start < end <= duration
 * 且相邻 segment 首尾相接（无重叠、无空洞），每个 segment 都带非空 summary 与可回溯的 evidence。
 * 所有修复、降级、丢证据的动作都会写进 warnings 或 evidence.reasons，不静默处理。
 */

const { toFiniteNumber, uniqueSorted, transcriptSnippet, createWarningCollector } = require('./evidenceBuilder');

const VALID_TYPES = new Set(['intro', 'content', 'ad', 'summary', 'transition', 'unknown']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

/** segment 边界与候选切点相差多少秒以内，才算「采用了这个切点」 */
const ADOPTED_TOLERANCE_SECONDS = 5;
/** 判定重叠/空洞时的容差，避免浮点误差触发无意义的修复 */
const COVERAGE_TOLERANCE_SECONDS = 1;
const MIN_SEGMENT_WARN_SECONDS = 5;

function uniqueSortedNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Number.isFinite))]
    .sort((a, b) => a - b);
}

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeCandidateCuts(candidateCuts) {
  if (!Array.isArray(candidateCuts)) return [];

  return candidateCuts
    .map(cut => {
      const time = toFiniteNumber(cut?.time);
      if (time === null || time < 0) return null;
      const score = toFiniteNumber(cut?.score);
      return {
        ...cut,
        time,
        score: score === null ? 0 : Math.max(0, Math.min(1, score)),
        reasons: Array.isArray(cut?.reasons) ? cut.reasons.filter(Boolean) : [],
        sources: Array.isArray(cut?.sources) ? cut.sources.filter(Boolean) : [],
        adopted: false
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function normalizeSegmentShape(segment, index, start, end, warn) {
  let type = segment?.type;
  if (!VALID_TYPES.has(type)) {
    if (type !== undefined) warn('invalid_segment_type_defaulted_to_unknown');
    type = 'unknown';
  }

  let confidence = segment?.confidence;
  if (!VALID_CONFIDENCE.has(confidence)) {
    if (confidence !== undefined) warn('invalid_segment_confidence_defaulted_to_low');
    confidence = 'low';
  }

  const rawCuts = segment?.evidence?.candidateCutTimes;
  const candidateCutTimes = Array.isArray(rawCuts)
    ? rawCuts.map(toFiniteNumber).filter(time => time !== null && time >= 0)
    : [];

  const rawReasons = segment?.evidence?.reasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter(reason => typeof reason === 'string' && reason.trim())
    : [];

  return {
    start,
    end,
    title: normalizeText(segment?.title, `Segment ${index + 1}`),
    type,
    summary: typeof segment?.summary === 'string' ? segment.summary.trim() : '',
    confidence,
    evidence: { candidateCutTimes, reasons }
  };
}

function normalizeSegments(segments, duration, warn) {
  if (!Array.isArray(segments)) return [];

  return segments
    .map((segment, index) => {
      const name = normalizeText(segment?.title, `Segment ${index + 1}`);
      const rawStart = toFiniteNumber(segment?.start);
      const rawEnd = toFiniteNumber(segment?.end);

      if (rawStart === null || rawEnd === null) {
        warn(`dropped_segment_missing_time:${name}`);
        return null;
      }

      const start = Math.max(0, Math.min(duration, rawStart));
      const end = Math.max(0, Math.min(duration, rawEnd));

      if (!(end > start)) {
        warn(`dropped_segment_invalid_range:${name}`);
        return null;
      }
      if (start !== rawStart || end !== rawEnd) {
        warn(`clamped_segment_to_duration:${name}`);
      }

      return normalizeSegmentShape(segment, index, start, end, warn);
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function buildFullLengthFallback(duration, fallbackReason) {
  return {
    start: 0,
    end: duration,
    title: 'Segment 1',
    type: 'unknown',
    summary: '',
    confidence: 'low',
    evidence: {
      candidateCutTimes: [],
      reasons: [fallbackReason || 'validator_fallback']
    }
  };
}

/** 修复首尾缺口、重叠与空洞，保证输出连续覆盖整段时长 */
function repairCoverage(segments, duration, warn) {
  const repaired = [];

  for (const segment of segments) {
    const current = { ...segment };
    const previous = repaired[repaired.length - 1];

    if (!previous) {
      if (current.start > 0) {
        warn('repaired_leading_coverage_gap');
        current.start = 0;
      }
    } else if (current.start < previous.end - COVERAGE_TOLERANCE_SECONDS) {
      warn('repaired_segment_overlap');
      current.start = previous.end;
    } else if (current.start > previous.end + COVERAGE_TOLERANCE_SECONDS) {
      warn('repaired_segment_gap');
      current.start = previous.end;
    }

    if (!(current.end > current.start)) {
      warn(`dropped_segment_after_repair:${current.title}`);
      continue;
    }
    if (current.end - current.start < MIN_SEGMENT_WARN_SECONDS) {
      warn(`short_segment_under_${MIN_SEGMENT_WARN_SECONDS}s:${current.title}`);
    }

    repaired.push(current);
  }

  if (repaired.length > 0) {
    const last = repaired[repaired.length - 1];
    if (last.end < duration - COVERAGE_TOLERANCE_SECONDS) {
      warn('repaired_trailing_coverage_gap');
      last.end = duration;
    } else if (last.end > duration) {
      warn('clamped_segment_end_to_duration');
      last.end = duration;
    }
  }

  return repaired;
}

function isBoundaryMatch(time, segment) {
  if (!Number.isFinite(time) || !segment) return false;
  return Math.abs(time - segment.start) <= ADOPTED_TOLERANCE_SECONDS
    || Math.abs(time - segment.end) <= ADOPTED_TOLERANCE_SECONDS;
}

/** 没有匹配到候选切点时写进 evidence.reasons 的明确原因值，供契约输出回溯 */
const NO_CANDIDATE_CUT_REASON = 'no_candidate_cut_matched';

/**
 * 把落在 segment 边界附近的候选切点回填进 evidence，保证切点与片段互相可追溯。
 * 没有匹配到切点时不能只留 warning：必须写入明确原因值，保证每个片段都有可追溯依据。
 */
function attachCandidateCutEvidence(segments, candidateCuts, fallbackReason, warn) {
  return segments.map(segment => {
    const matched = candidateCuts
      .filter(cut => isBoundaryMatch(cut.time, segment))
      .map(cut => Number(cut.time.toFixed(2)));

    const candidateCutTimes = uniqueSortedNumbers([
      ...(segment.evidence?.candidateCutTimes || []),
      ...matched
    ]);

    const reasons = uniqueSorted(segment.evidence?.reasons || []);

    if (candidateCutTimes.length === 0 && !fallbackReason) {
      warn(`segment_without_traceable_evidence:${segment.title}`);
      reasons.push(NO_CANDIDATE_CUT_REASON);
    }
    if (fallbackReason && !reasons.includes(fallbackReason)) {
      reasons.push(fallbackReason);
    }

    return { ...segment, evidence: { candidateCutTimes, reasons } };
  });
}

/**
 * summary 兜底。
 * 优先用该区间的转录原文（真实素材，只做拼接截断、不改写）；
 * 完全没有素材时才退到结构性描述，绝不用模型或规则编造视频内容。
 */
function ensureSummary(segments, transcript, warn) {
  const hasTranscript = Boolean(transcript);

  return segments.map(segment => {
    if (segment.summary) return segment;

    const snippet = hasTranscript ? transcriptSnippet(transcript, segment.start, segment.end) : '';
    if (snippet) {
      warn(`segment_summary_filled_from_transcript:${segment.title}`);
      return { ...segment, summary: snippet };
    }

    warn(`segment_summary_filled_with_structural_text:${segment.title}`);
    return {
      ...segment,
      summary: `本片段未获得内容描述；区间 ${formatClock(segment.start)} - ${formatClock(segment.end)}，类型 ${segment.type}。`
    };
  });
}

function finalizeSegment(segment, duration) {
  const start = Math.max(0, Number(segment.start.toFixed(2)));
  const end = Math.min(Number(segment.end.toFixed(2)), duration);
  return { ...segment, start, end };
}

function markAdopted(candidateCuts, segments) {
  return candidateCuts.map(cut => ({
    ...cut,
    adopted: segments.some(segment => isBoundaryMatch(cut.time, segment))
  }));
}

function validateSegments({
  duration = 0,
  candidateCuts = [],
  segments = [],
  transcript = [],
  fallbackReason = null
} = {}) {
  const warnings = [];
  const warn = createWarningCollector(warnings);

  const parsedDuration = toFiniteNumber(duration);
  const validDuration = parsedDuration !== null && parsedDuration > 0 ? parsedDuration : 0;
  const safeCuts = normalizeCandidateCuts(candidateCuts);

  // 时长未知时不臆造区间，返回空结果并说明原因
  if (validDuration <= 0) {
    warn('duration_missing_or_zero');
    return {
      segments: [],
      candidateCuts: markAdopted(safeCuts, []),
      warnings
    };
  }

  let normalized = normalizeSegments(segments, validDuration, warn);

  if (normalized.length === 0) {
    warn('no_valid_segments_full_length_fallback');
    normalized = [buildFullLengthFallback(validDuration, fallbackReason)];
  }

  const repaired = repairCoverage(normalized, validDuration, warn);
  const traced = attachCandidateCutEvidence(repaired, safeCuts, fallbackReason, warn);
  const described = ensureSummary(traced, transcript, warn);

  return {
    segments: described.map(segment => finalizeSegment(segment, validDuration)),
    candidateCuts: markAdopted(safeCuts, described),
    warnings
  };
}

module.exports = {
  validateSegments,
  formatClock,
  NO_CANDIDATE_CUT_REASON,
  ADOPTED_TOLERANCE_SECONDS,
  VALID_TYPES,
  VALID_CONFIDENCE
};
