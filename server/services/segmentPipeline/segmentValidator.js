function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const VALID_TYPES = new Set(['intro', 'content', 'ad', 'summary', 'transition', 'unknown']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

function markAdopted(candidateCuts, segments) {
  return candidateCuts.map(cut => {
    const cutTime = toNumber(cut.time, -1);
    const adopted = segments.some(segment => {
      return Math.abs(toNumber(segment.start) - cutTime) <= 5 || Math.abs(toNumber(segment.end) - cutTime) <= 5;
    });
    return { ...cut, adopted };
  });
}

function validateSegments({ duration = 0, candidateCuts = [], segments = [], fallbackReason = null } = {}) {
  const warnings = [];
  const validDuration = Math.max(0, toNumber(duration));
  let normalized = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({
      ...segment,
      start: Math.max(0, Math.min(validDuration, toNumber(segment.start))),
      end: Math.max(0, Math.min(validDuration, toNumber(segment.end))),
      title: String(segment.title || `Segment ${index + 1}`).trim() || `Segment ${index + 1}`,
      type: VALID_TYPES.has(segment.type) ? segment.type : 'unknown',
      confidence: VALID_CONFIDENCE.has(segment.confidence) ? segment.confidence : 'low',
      summary: String(segment.summary || '').trim(),
      evidence: segment.evidence || { candidateCutTimes: [], reasons: [] }
    }))
    .filter(segment => {
      const valid = segment.end > segment.start;
      if (!valid) warnings.push(`Dropped invalid segment ${segment.title}`);
      return valid;
    })
    .sort((a, b) => a.start - b.start);

  if (!normalized.length && validDuration > 0) {
    warnings.push('No valid segments returned; generated full-length fallback segment');
    normalized = [{
      start: 0,
      end: validDuration,
      title: 'Segment 1',
      type: 'unknown',
      summary: '',
      confidence: 'low',
      evidence: { candidateCutTimes: [], reasons: [fallbackReason || 'validator_fallback'] }
    }];
  }

  const repaired = [];
  for (const segment of normalized) {
    const previous = repaired[repaired.length - 1];
    if (!previous && segment.start > 0) {
      warnings.push('Repaired leading coverage gap');
      segment.start = 0;
    }
    if (previous) {
      if (segment.start < previous.end) {
        warnings.push(`Repaired overlap before ${segment.title}`);
        segment.start = previous.end;
      }
      if (segment.start > previous.end + 1) {
        warnings.push(`Repaired coverage gap before ${segment.title}`);
        segment.start = previous.end;
      }
    }
    if (segment.end - segment.start < 5 && validDuration >= 5) {
      warnings.push(`Short segment under 5 seconds: ${segment.title}`);
    }
    if (!Array.isArray(segment.evidence?.candidateCutTimes)) {
      segment.evidence.candidateCutTimes = [];
    }
    if (!Array.isArray(segment.evidence?.reasons)) {
      segment.evidence.reasons = [];
    }
    if (!segment.evidence.candidateCutTimes.length && !fallbackReason) {
      warnings.push(`Segment lacks candidate cut trace: ${segment.title}`);
    }
    if (fallbackReason && !segment.evidence.reasons.includes(fallbackReason)) {
      segment.evidence.reasons.push(fallbackReason);
    }
    if (segment.end > segment.start) repaired.push(segment);
  }

  if (repaired.length && validDuration > 0) {
    const last = repaired[repaired.length - 1];
    if (last.end < validDuration) {
      warnings.push('Repaired trailing coverage gap');
      last.end = validDuration;
    }
    if (last.end > validDuration) {
      warnings.push('Clamped segment end to duration');
      last.end = validDuration;
    }
  }

  return {
    segments: repaired.map(segment => ({
      ...segment,
      start: Number(segment.start.toFixed(2)),
      end: Number(segment.end.toFixed(2))
    })),
    candidateCuts: markAdopted(candidateCuts, repaired),
    warnings
  };
}

module.exports = {
  validateSegments
};
