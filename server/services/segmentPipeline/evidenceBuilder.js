function normalizeFrameTimes(frames) {
  if (!Array.isArray(frames)) return [];
  return frames
    .map(frame => {
      if (Number.isFinite(Number(frame))) return Number(frame);
      if (Number.isFinite(Number(frame?.time))) return Number(frame.time);
      if (Number.isFinite(Number(frame?.timestamp))) return Number(frame.timestamp);
      if (Number.isFinite(Number(frame?.timestampMs))) return Number(frame.timestampMs) / 1000;
      return null;
    })
    .filter(time => Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b);
}

function inferMode({ visualCuts, audioCuts, keywordCuts, transcript }) {
  const hasVisual = Array.isArray(visualCuts) && visualCuts.length > 0;
  const hasAudio = Array.isArray(audioCuts) && audioCuts.length > 0;
  const hasKeywords = Array.isArray(keywordCuts) && keywordCuts.length > 0;
  const hasTranscript = typeof transcript === 'string' && transcript.trim().length > 0;

  if (hasVisual && (hasAudio || hasKeywords || hasTranscript)) return 'full';
  if (hasVisual) return 'visual_only';
  if (hasTranscript || hasKeywords) return 'transcript_only';
  return 'fallback';
}

function inferConfidence(mode, candidateCount) {
  if (mode === 'full' && candidateCount >= 2) return 'high';
  if ((mode === 'full' || mode === 'transcript_only' || mode === 'visual_only') && candidateCount > 0) {
    return 'medium';
  }
  return 'low';
}

function buildEvidence(input = {}) {
  const visualCuts = Array.isArray(input.visualCuts) ? input.visualCuts : [];
  const audioCuts = Array.isArray(input.audioCuts) ? input.audioCuts : [];
  const keywordCuts = Array.isArray(input.keywordCuts) ? input.keywordCuts : [];
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';
  const frameTimes = normalizeFrameTimes(input.frames);
  const mode = inferMode({ visualCuts, audioCuts, keywordCuts, transcript });

  return {
    videoId: input.videoId || input.bvid || null,
    bvid: input.bvid || input.videoId || null,
    duration: Number.isFinite(Number(input.duration)) ? Number(input.duration) : 0,
    mode,
    frameTimes,
    transcript,
    visualCuts,
    audioCuts,
    keywordCuts,
    existingAnalysis: input.existingAnalysis || null,
    modelConfig: input.modelConfig ? {
      textModel: input.modelConfig.textModel,
      visionModel: input.modelConfig.visionModel,
      baseUrl: input.modelConfig.baseUrl
    } : null
  };
}

module.exports = {
  buildEvidence,
  inferConfidence
};
