async function getAudioCuts(audioPath, options = {}) {
  void audioPath;
  void options;

  // TODO:
  // - silence detection
  // - RMS volume change
  // - audio energy peak
  // - speech / BGM pattern change
  // Output shape:
  //   [{ time, score, reasons: ['silence', 'volume_change'], source: 'audio', method: 'placeholder' }]
  return [];
}

module.exports = {
  getAudioCuts
};
