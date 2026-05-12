const { normalizeTranscriptItem, normalizeCandidateCut } = require('./segmentTypes');

const DEFAULT_KEYWORD_RULES = Object.freeze([
  { keyword: '本期视频由', type: 'ad', weight: 0.9 },
  { keyword: '感谢赞助', type: 'ad', weight: 0.85 },
  { keyword: '赞助商', type: 'ad', weight: 0.8 },
  { keyword: '接下来', type: 'content', weight: 0.55 },
  { keyword: '首先', type: 'intro', weight: 0.5 },
  { keyword: '第二部分', type: 'content', weight: 0.65 },
  { keyword: '总结一下', type: 'summary', weight: 0.75 },
  { keyword: '最后', type: 'outro', weight: 0.7 },
  { keyword: '回到正题', type: 'content', weight: 0.75 }
]);

function detectKeywordCuts(transcript, rules = DEFAULT_KEYWORD_RULES) {
  if (!Array.isArray(transcript) || !Array.isArray(rules)) return [];

  const keywordCuts = [];

  transcript.forEach((item) => {
    const normalizedItem = normalizeTranscriptItem(item);
    if (!normalizedItem.text) return;

    rules.forEach((rule) => {
      if (!rule || !rule.keyword) return;
      const keyword = String(rule.keyword);
      if (!normalizedItem.text.includes(keyword)) return;

      keywordCuts.push(normalizeCandidateCut({
        time: normalizedItem.start,
        score: Number(rule.weight) || 0,
        reasons: [`keyword:${keyword}`],
        source: 'keyword',
        method: 'keyword_rule',
        context: {
          keyword,
          type: rule.type || 'unknown'
        }
      }));
    });
  });

  return keywordCuts;
}

module.exports = {
  DEFAULT_KEYWORD_RULES,
  detectKeywordCuts
};
