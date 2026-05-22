const SOURCE_WEIGHTS = {
  keyword: 0.9,
  visual: 0.75,
  audio: 0.65,
  text: 0.7,
  time_padding: 0.35
};

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function transcriptRows(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map(row => ({
        time: Number(row.start ?? row.time ?? row.timestamp),
        text: String(row.text || '').trim()
      }))
      .filter(row => Number.isFinite(row.time) && row.text)
      .sort((a, b) => a.time - b.time);
  }

  if (typeof transcript !== 'string') return [];
  return transcript
    .split(/\r?\n/)
    .map(line => {
      const match = line.trim().match(/^\[(\d{1,2}):(\d{2})\]\s+(.+)$/);
      if (!match) return null;
      return {
        time: Number(match[1]) * 60 + Number(match[2]),
        text: match[3].trim()
      };
    })
    .filter(Boolean);
}

function normalizeCut(cut, source) {
  const time = Number(cut?.time ?? cut?.timestamp ?? cut?.start_time ?? cut?.start);
  if (!Number.isFinite(time)) return null;
  const score = clamp01(cut?.score ?? cut?.confidence ?? SOURCE_WEIGHTS[source]);
  const reasons = Array.isArray(cut?.reasons) ? cut.reasons : [];
  const reasonFallback = source === 'keyword' && cut?.keyword ? `keyword:${cut.keyword}` : `${source}_change`;

  return {
    time,
    score,
    reasons: unique([...reasons, reasonFallback]),
    sources: unique([source, ...(Array.isArray(cut?.sources) ? cut.sources : [])]),
    raw: cut
  };
}

function transcriptSemanticCuts(transcript) {
  const rows = transcriptRows(transcript);
  if (rows.length < 3) return [];

  const transitionHints = ['接下来', '然后', '但是', '所以', '总结', '最后', '回到', '换句话说', '另一方面'];
  const cuts = [];
  for (let i = 1; i < rows.length; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];
    const gap = current.time - previous.time;
    const hasHint = transitionHints.some(hint => current.text.includes(hint));
    const lengthShift = Math.abs(current.text.length - previous.text.length) >= 18;
    if (hasHint || (gap >= 18 && lengthShift)) {
      cuts.push({
        time: current.time,
        score: hasHint ? 0.72 : 0.5,
        reasons: [hasHint ? 'text_topic_shift' : 'text_topic_shift'],
        sources: ['text'],
        raw: current
      });
    }
  }
  return cuts;
}

function addNearbyEvidence(cut, transcript, frameTimes) {
  const rows = transcriptRows(transcript);
  const before = [...rows].reverse().find(row => row.time < cut.time);
  const after = rows.find(row => row.time >= cut.time);
  return {
    ...cut,
    nearbyEvidence: {
      beforeText: before?.text || '',
      afterText: after?.text || '',
      frameTimes: (frameTimes || []).filter(time => Math.abs(time - cut.time) <= 8).slice(0, 6)
    }
  };
}

function mergeNearbyCuts(cuts, windowSeconds = 5) {
  const sorted = cuts.slice().sort((a, b) => a.time - b.time);
  const merged = [];

  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (!last || Math.abs(cut.time - last.time) > windowSeconds) {
      merged.push({ ...cut });
      continue;
    }

    const totalScore = last.score + cut.score || 1;
    last.time = Number(((last.time * last.score + cut.time * cut.score) / totalScore).toFixed(2));
    last.score = clamp01(last.score + cut.score * 0.55);
    last.reasons = unique([...last.reasons, ...cut.reasons]);
    last.sources = unique([...last.sources, ...cut.sources]);
    last.raw = [...(Array.isArray(last.raw) ? last.raw : [last.raw]), cut.raw];
  }

  return merged;
}

function enforceBoundaries(cuts, duration) {
  return cuts.filter(cut => {
    if (cut.time <= 0 || cut.time >= duration) return false;
    const nearEdge = cut.time < 8 || cut.time > duration - 8;
    return !nearEdge || cut.score >= 0.85;
  });
}

function enforceMinSpacing(cuts, minSpacing = 10) {
  const kept = [];
  for (const cut of cuts.sort((a, b) => a.time - b.time)) {
    const last = kept[kept.length - 1];
    if (!last || cut.time - last.time >= minSpacing) {
      kept.push(cut);
    } else if (cut.score > last.score) {
      kept[kept.length - 1] = cut;
    }
  }
  return kept;
}

function insertTimePaddingCuts(cuts, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return cuts;
  const result = cuts.slice().sort((a, b) => a.time - b.time);
  let changed = true;

  while (changed) {
    changed = false;
    const boundaries = [0, ...result.map(c => c.time).sort((a, b) => a - b), duration];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start <= 90) continue;

      const time = Number(((start + end) / 2).toFixed(2));
      result.push({
        time,
        score: SOURCE_WEIGHTS.time_padding,
        reasons: ['time_padding'],
        sources: ['time_padding'],
        raw: null
      });
      changed = true;
      break;
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

function generateCandidateCuts(input = {}) {
  const duration = Number(input.duration) || 0;
  const frameTimes = Array.isArray(input.frameTimes) ? input.frameTimes : [];
  const rawCuts = [
    ...(Array.isArray(input.visualCuts) ? input.visualCuts.map(cut => normalizeCut(cut, 'visual')) : []),
    ...(Array.isArray(input.audioCuts) ? input.audioCuts.map(cut => normalizeCut(cut, 'audio')) : []),
    ...(Array.isArray(input.keywordCuts) ? input.keywordCuts.map(cut => normalizeCut(cut, 'keyword')) : []),
    ...transcriptSemanticCuts(input.transcript || input.transcriptText || '')
  ].filter(Boolean);

  let cuts = enforceBoundaries(rawCuts, duration);
  cuts = mergeNearbyCuts(cuts);
  cuts = insertTimePaddingCuts(cuts, duration);
  cuts = enforceBoundaries(cuts, duration);
  cuts = enforceMinSpacing(cuts);

  return cuts
    .map(cut => addNearbyEvidence({
      ...cut,
      time: Number(cut.time.toFixed(2)),
      score: Number(clamp01(cut.score).toFixed(3)),
      adopted: false
    }, input.transcript || input.transcriptText || '', frameTimes))
    .sort((a, b) => a.time - b.time);
}

module.exports = {
  generateCandidateCuts,
  SOURCE_WEIGHTS
};
