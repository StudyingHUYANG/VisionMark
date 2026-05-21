const { buildSemanticMergePrompt, extractJsonObject } = require('./semanticMergePrompt');

const VALID_TYPES = new Set(['intro', 'content', 'ad', 'summary', 'transition', 'unknown']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

function confidenceFromScore(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function normalizeSegment(segment, index, duration) {
  const start = Math.max(0, Number(segment?.start));
  const end = Math.min(duration, Number(segment?.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;

  const type = VALID_TYPES.has(segment?.type) ? segment.type : 'unknown';
  const confidence = VALID_CONFIDENCE.has(segment?.confidence) ? segment.confidence : 'low';
  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    title: String(segment?.title || `Segment ${index + 1}`).trim() || `Segment ${index + 1}`,
    type,
    summary: String(segment?.summary || '').trim(),
    confidence,
    evidence: {
      candidateCutTimes: Array.isArray(segment?.evidence?.candidateCutTimes)
        ? segment.evidence.candidateCutTimes.map(Number).filter(Number.isFinite)
        : [],
      reasons: Array.isArray(segment?.evidence?.reasons) ? segment.evidence.reasons.filter(Boolean) : []
    }
  };
}

function fallbackSegmentMerge(candidateCuts = [], duration = 0, transcript = '') {
  const validDuration = Math.max(0, Number(duration) || 0);
  const cutTimes = candidateCuts
    .map(cut => Number(cut.time))
    .filter(time => Number.isFinite(time) && time > 0 && time < validDuration)
    .sort((a, b) => a - b);

  const boundaries = [0, ...cutTimes, validDuration].filter((time, index, list) => {
    return index === 0 || Math.abs(time - list[index - 1]) >= 1;
  });

  if (boundaries.length < 2 && validDuration > 0) boundaries.push(validDuration);

  const averageScore = candidateCuts.length
    ? candidateCuts.reduce((sum, cut) => sum + (Number(cut.score) || 0), 0) / candidateCuts.length
    : 0;
  const fallbackConfidence = transcript ? confidenceFromScore(Math.max(averageScore, 0.45)) : confidenceFromScore(averageScore);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end <= start) continue;
    const boundaryCut = candidateCuts.find(cut => Math.abs(Number(cut.time) - end) <= 1);
    segments.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      title: `Segment ${segments.length + 1}`,
      type: 'unknown',
      summary: '',
      confidence: fallbackConfidence,
      evidence: {
        candidateCutTimes: boundaryCut ? [boundaryCut.time] : [],
        reasons: boundaryCut ? [...(boundaryCut.reasons || [])] : ['fallback_merge']
      }
    });
  }

  return segments;
}

async function mergeSegmentsWithAI(input = {}, modelClient = null) {
  const prompt = buildSemanticMergePrompt(input);
  const duration = Number(input.duration) || 0;
  const debug = {
    usedAI: false,
    fallbackReason: null,
    aiPromptPreview: prompt.slice(0, 2000),
    aiRawOutput: null
  };

  if (!modelClient || typeof modelClient.chat?.completions?.create !== 'function') {
    debug.fallbackReason = 'model_client_unavailable';
    return {
      segments: fallbackSegmentMerge(input.candidateCuts, duration, input.transcript),
      debug
    };
  }

  try {
    const response = await modelClient.chat.completions.create({
      model: input.modelConfig?.textModel || input.modelConfig?.visionModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2200,
      temperature: 0.2
    });
    const content = response?.choices?.[0]?.message?.content || '';
    debug.aiRawOutput = content;
    const parsed = extractJsonObject(content);
    const segments = (Array.isArray(parsed?.segments) ? parsed.segments : [])
      .map((segment, index) => normalizeSegment(segment, index, duration))
      .filter(Boolean);

    if (!segments.length) {
      throw new Error('ai_returned_no_segments');
    }

    debug.usedAI = true;
    return { segments, debug };
  } catch (error) {
    debug.fallbackReason = `ai_merge_failed:${error.message}`;
    return {
      segments: fallbackSegmentMerge(input.candidateCuts, duration, input.transcript),
      debug
    };
  }
}

module.exports = {
  mergeSegmentsWithAI,
  fallbackSegmentMerge
};
