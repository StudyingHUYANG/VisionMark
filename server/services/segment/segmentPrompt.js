function buildSegmentMergePrompt({
  candidateCuts = [],
  transcript = [],
  frames = [],
  duration = null,
  oldSegments = []
} = {}) {
  return [
    '你是视频分段重构助手，需要根据 evidence -> candidateCuts -> AI merge -> finalSegments 的流程合并候选切点。',
    '',
    '硬性约束：',
    '- 只能基于 candidateCuts 附近做分段，不要随意编造新的时间点。',
    '- 如果证据不足，必须将 confidence 标记为 low。',
    '- 输出必须是严格 JSON，不要包含 Markdown、解释文字或多余字段。',
    '- segment 类型仅允许 content/ad/intro/outro/summary/unknown。',
    '- 每个 segment 必须包含 start、end、title、type，可选 summary、confidence。',
    '- start/end 必须是秒数，且 start < end。',
    '',
    '可用数据：',
    JSON.stringify({
      duration,
      candidateCuts,
      transcript,
      frames,
      oldSegments
    }, null, 2),
    '',
    '请输出：',
    JSON.stringify({
      segments: [
        {
          start: 0,
          end: 0,
          title: '',
          type: 'unknown',
          summary: '',
          confidence: 'low'
        }
      ]
    }, null, 2)
  ].join('\n');
}

module.exports = {
  buildSegmentMergePrompt
};
