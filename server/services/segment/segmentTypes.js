const CANDIDATE_CUT_SOURCES = new Set(['visual', 'audio', 'keyword', 'gap', 'mixed']);
const SEGMENT_TYPES = new Set(['content', 'ad', 'intro', 'outro', 'summary', 'unknown']);
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);

function toFiniteNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeReasons(reasons) {
  if (!Array.isArray(reasons)) return [];

  return reasons
    .map((reason) => String(reason || '').trim())
    .filter(Boolean);
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value;
}

function normalizeCandidateCut(cut = {}) {
  const source = CANDIDATE_CUT_SOURCES.has(cut.source) ? cut.source : 'mixed';
  const normalized = {
    time: Math.max(0, toFiniteNumber(cut.time)),
    score: Math.max(0, toFiniteNumber(cut.score)),
    reasons: normalizeReasons(cut.reasons),
    source
  };

  if (cut.method) {
    normalized.method = String(cut.method);
  }

  const context = normalizePlainObject(cut.context);
  if (context) {
    normalized.context = context;
  }

  return normalized;
}

function isValidCandidateCut(cut) {
  if (!cut || typeof cut !== 'object') return false;

  const normalized = normalizeCandidateCut(cut);
  return (
    Number.isFinite(normalized.time) &&
    normalized.time >= 0 &&
    Number.isFinite(normalized.score) &&
    normalized.score >= 0 &&
    normalized.reasons.length > 0 &&
    CANDIDATE_CUT_SOURCES.has(normalized.source)
  );
}

function normalizeTranscriptItem(item = {}) {
  return {
    start: Math.max(0, toFiniteNumber(item.start)),
    end: Math.max(0, toFiniteNumber(item.end)),
    text: String(item.text || '').trim()
  };
}

function normalizeSegmentResult(segment = {}) {
  const normalized = {
    start: Math.max(0, toFiniteNumber(segment.start)),
    end: Math.max(0, toFiniteNumber(segment.end)),
    title: String(segment.title || '').trim(),
    type: SEGMENT_TYPES.has(segment.type) ? segment.type : 'unknown'
  };

  if (segment.summary) {
    normalized.summary = String(segment.summary);
  }

  if (CONFIDENCE_LEVELS.has(segment.confidence)) {
    normalized.confidence = segment.confidence;
  }

  return normalized;
}

module.exports = {
  normalizeCandidateCut,
  isValidCandidateCut,
  normalizeTranscriptItem,
  normalizeSegmentResult
};
