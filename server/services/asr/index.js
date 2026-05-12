const { transcribeAudio } = require('./transcribeAudio');
const { transcribeWithFallback } = require('./asrFallback');

module.exports = {
  transcribeAudio,
  transcribeWithFallback
};
