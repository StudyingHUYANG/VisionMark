const {
  generateCandidateCuts,
  sortCandidateCuts,
  dedupeNearbyCuts,
  mergeCandidateCuts
} = require('./candidateCutGenerator');
const { getVisualCuts } = require('./visualCuts');
const { getAudioCuts } = require('./audioCuts');
const {
  detectKeywordCuts,
  DEFAULT_KEYWORD_RULES
} = require('./keywordCuts');
const { buildSegmentMergePrompt } = require('./segmentPrompt');
const {
  normalizeCandidateCut,
  isValidCandidateCut
} = require('./segmentTypes');

module.exports = {
  generateCandidateCuts,
  sortCandidateCuts,
  dedupeNearbyCuts,
  mergeCandidateCuts,
  getVisualCuts,
  getAudioCuts,
  detectKeywordCuts,
  DEFAULT_KEYWORD_RULES,
  buildSegmentMergePrompt,
  normalizeCandidateCut,
  isValidCandidateCut
};
