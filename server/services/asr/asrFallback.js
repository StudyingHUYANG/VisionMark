const { transcribeAudio } = require('./transcribeAudio');

async function transcribeWithFallback(audioPath, options = {}) {
  try {
    const transcript = await transcribeAudio(audioPath, options);
    const hasTranscript = Array.isArray(transcript) && transcript.length > 0;

    return {
      transcript: hasTranscript ? transcript : [],
      mode: hasTranscript ? 'asr_available' : 'no_asr',
      confidence: hasTranscript ? 'medium' : 'low',
      provider: hasTranscript ? options.provider || null : null,
      error: null
    };
  } catch (error) {
    return {
      transcript: [],
      mode: 'no_asr',
      confidence: 'low',
      provider: null,
      error: error && error.message ? error.message : String(error)
    };
  }
}

module.exports = {
  transcribeWithFallback
};
