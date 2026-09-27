function safeSliceText(text, maxLength = 6000) {
  if (!text || typeof text !== 'string') return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function buildSemanticMergePrompt(input = {}) {
  const transcriptContext = Array.isArray(input.transcript)
    ? input.transcript
      .slice(0, 160)
      .map(row => `[${row.start}] ${row.text}`)
      .join('\n')
    : input.transcript || input.transcriptText || '';
  const payload = {
    duration: input.duration || 0,
    mode: input.mode || 'fallback',
    confidence: input.confidence || 'low',
    candidateCuts: (input.candidateCuts || []).map(cut => ({
      time: cut.time,
      score: cut.score,
      reasons: cut.reasons || [],
      sources: cut.sources || [],
      nearbyEvidence: cut.nearbyEvidence || {}
    })),
    frameTimes: (input.frameTimes || []).slice(0, 120),
    transcriptContext: safeSliceText(transcriptContext)
  };

  return `你是视频语义分段助手。请基于候选切点把视频合并为最终 segments。

硬性约束：
1. 不能凭空编造时间点。
2. segment 边界必须优先来自 candidateCuts.time，以及 0 和 duration。
3. 如需微调边界，不能偏离最近候选切点超过 5 秒。
4. 如果证据不足，降低 confidence，不要编造理由。
5. 只输出严格 JSON，不要输出 markdown、解释或代码块。
6. segment type 只能是 intro/content/ad/summary/transition/unknown。
7. 每个 segment 必须包含 start/end/title/type/summary/confidence/evidence。

输入：
${JSON.stringify(payload, null, 2)}

输出格式：
{
  "segments": [
    {
      "start": 0,
      "end": 42.5,
      "title": "开场与背景介绍",
      "type": "intro",
      "summary": "",
      "confidence": "high",
      "evidence": {
        "candidateCutTimes": [42.5],
        "reasons": ["visual_change"]
      }
    }
  ]
}`;
}

function extractJsonFromModelOutput(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const source = fenced ? fenced[1] : text;
    const first = source.indexOf('{');
    const last = source.lastIndexOf('}');
    if (first < 0 || last <= first) {
      return null;
    }
    return JSON.parse(source.slice(first, last + 1));
  } catch (error) {
    return null;
  }
}

module.exports = {
  buildSemanticMergePrompt,
  extractJsonFromModelOutput
};
