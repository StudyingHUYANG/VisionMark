const {
  calculateHistogramDiff,
  calculateSSIMDiff,
  calculatePerceptualHashDiff
} = require('../vision/frameDiff');

async function getVisualCuts(frames, options = {}) {
  void frames;
  void options;
  void calculateHistogramDiff;
  void calculateSSIMDiff;
  void calculatePerceptualHashDiff;

  // TODO:
  // - Call frameDiff helpers.
  // - Calculate adjacent frame differences.
  // - Detect local peaks.
  // - Output visual candidate cuts:
  //   [{ time, score, reasons: ['visual_change'], source: 'visual', method: 'placeholder' }]
  return [];
}

module.exports = {
  getVisualCuts
};
