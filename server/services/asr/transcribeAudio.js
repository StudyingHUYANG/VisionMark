async function transcribeAudio(audioPath, options = {}) {
  void audioPath;
  void options;

  // TODO: connect an ASR provider later:
  // - DashScope / paraformer
  // - FunASR
  // - whisper / faster-whisper
  // - local fallback
  // Return transcript[]: [{ start, end, text }]
  return [];
}

module.exports = {
  transcribeAudio
};
