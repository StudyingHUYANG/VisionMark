const { getVisualCuts } = require('./visualCuts');
const { getAudioCuts } = require('./audioCuts');
const { detectKeywordCuts } = require('./keywordCuts');
const { normalizeCandidateCut, isValidCandidateCut } = require('./segmentTypes');

function sortCandidateCuts(cuts) {
  if (!Array.isArray(cuts)) return [];

  return cuts
    .map(normalizeCandidateCut)
    .filter(isValidCandidateCut)
    .sort((a, b) => a.time - b.time || b.score - a.score);
}

function dedupeNearbyCuts(cuts, minGapSeconds = 5) {
  const sortedCuts = sortCandidateCuts(cuts);
  if (sortedCuts.length === 0) return [];

  const minGap = Math.max(0, Number(minGapSeconds) || 0);
  const deduped = [];

  sortedCuts.forEach((cut) => {
    const lastCut = deduped[deduped.length - 1];

    if (!lastCut || cut.time - lastCut.time > minGap) {
      deduped.push(cut);
      return;
    }

    if (cut.score > lastCut.score) {
      deduped[deduped.length - 1] = cut;
    }
  });

  return deduped;
}

function mergeCandidateCuts(cuts, options = {}) {
  const minGapSeconds = options.minGapSeconds ?? 5;
  return dedupeNearbyCuts(cuts, minGapSeconds);
}

async function generateCandidateCuts({
  frames = [],
  audioPath = null,
  transcript = [],
  duration = null,
  options = {}
} = {}) {
  void duration;

  const visualCuts = await getVisualCuts(frames, options.visual || {});
  const audioCuts = await getAudioCuts(audioPath, options.audio || {});
  const keywordCuts = detectKeywordCuts(transcript, options.keywordRules);
  const allCuts = [
    ...visualCuts,
    ...audioCuts,
    ...keywordCuts
  ];
  const candidateCuts = mergeCandidateCuts(allCuts, options.merge || {});

  return {
    candidateCuts,
    debug: {
      visualCount: visualCuts.length,
      audioCount: audioCuts.length,
      keywordCount: keywordCuts.length,
      totalBeforeMerge: allCuts.length,
      totalAfterMerge: candidateCuts.length
    }
  };
}

module.exports = {
  generateCandidateCuts,
  sortCandidateCuts,
  dedupeNearbyCuts,
  mergeCandidateCuts
};
