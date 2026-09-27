function normalizeFrameTimes(frames, frameTimes = []) {
  const source = Array.isArray(frameTimes) && frameTimes.length > 0 ? frameTimes : frames;
  if (!Array.isArray(source)) return [];
  return source
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

function parseTimeToSeconds(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (typeof value !== 'string') return null;

  const parts = value.replace(/：/g, ':').split(':').map(part => Number(part.trim()));
  if (parts.some(part => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function normalizeTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map((item, index) => {
        if (typeof item === 'string') {
          const match = item.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
          const start = match ? parseTimeToSeconds(match[1]) : null;
          return {
            start: Number.isFinite(start) ? start : index,
            end: Number.isFinite(start) ? start : index,
            text: match ? match[2].trim() : item.trim()
          };
        }

        const start = parseTimeToSeconds(item?.start ?? item?.time ?? item?.timestamp ?? item?.begin_time);
        const end = parseTimeToSeconds(item?.end ?? item?.end_time);
        return {
          start: Number.isFinite(start) ? start : 0,
          end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0),
          text: String(item?.text ?? item?.content ?? '').trim()
        };
      })
      .filter(item => item.text)
      .sort((a, b) => a.start - b.start);
  }

  if (typeof transcript !== 'string' || !transcript.trim()) return [];

  return transcript
    .split(/\r?\n/)
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
      const start = match ? parseTimeToSeconds(match[1]) : null;
      return {
        start: Number.isFinite(start) ? start : index,
        end: Number.isFinite(start) ? start : index,
        text: match ? match[2].trim() : trimmed
      };
    })
    .filter(Boolean)
    .filter(item => item.text)
    .sort((a, b) => a.start - b.start);
}

function transcriptToText(transcriptSegments) {
  return transcriptSegments
    .map(item => {
      const minute = Math.floor(item.start / 60);
      const second = Math.floor(item.start % 60);
      return `[${minute}:${String(second).padStart(2, '0')}] ${item.text}`;
    })
    .join('\n');
}

function normalizeCuts(cuts) {
  if (!Array.isArray(cuts)) return [];
  return cuts
    .map(cut => {
      const time = parseTimeToSeconds(cut?.time ?? cut?.timestamp ?? cut?.start_time ?? cut?.start);
      if (!Number.isFinite(time)) return null;
      return { ...cut, time };
    })
    .filter(Boolean);
}

function inferMode({ visualCuts, audioCuts, keywordCuts, transcript }) {
  const hasVisual = Array.isArray(visualCuts) && visualCuts.length > 0;
  const hasAudio = Array.isArray(audioCuts) && audioCuts.length > 0;
  const hasKeywords = Array.isArray(keywordCuts) && keywordCuts.length > 0;
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;

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
  const warnings = [];
  const visualCuts = normalizeCuts(input.visualCuts);
  const audioCuts = normalizeCuts(input.audioCuts);
  const keywordCuts = normalizeCuts(input.keywordCuts);
  const transcript = normalizeTranscript(input.transcript);
  const transcriptText = transcriptToText(transcript);
  const frameTimes = normalizeFrameTimes(input.frames, input.frameTimes);
  const mode = inferMode({ visualCuts, audioCuts, keywordCuts, transcript });
  const confidence = inferConfidence(mode, visualCuts.length + audioCuts.length + keywordCuts.length);

  if (input.duration !== undefined && !Number.isFinite(Number(input.duration))) {
    warnings.push('Invalid duration; using 0');
  }

  return {
    videoId: input.videoId || input.bvid || null,
    bvid: input.bvid || input.videoId || null,
    duration: Number.isFinite(Number(input.duration)) ? Number(input.duration) : 0,
    mode,
    confidence,
    frameTimes,
    transcript,
    transcriptText,
    visualCuts,
    audioCuts,
    keywordCuts,
    availableSources: {
      visual: visualCuts.length > 0,
      audio: audioCuts.length > 0,
      transcript: transcript.length > 0,
      keyword: keywordCuts.length > 0
    },
    warnings,
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
