const { runSegmentPipeline } = require('../services/segmentPipeline');

async function main() {
  const result = await runSegmentPipeline({
    videoId: 'mock-bvid',
    bvid: 'mock-bvid',
    duration: 180,
    frames: [0, 12, 30, 48, 75, 102, 135, 170],
    visualCuts: [
      { time: 44, score: 0.82, reasons: ['visual_change'] },
      { time: 118, score: 0.68, reasons: ['scene_change'] }
    ],
    audioCuts: [
      { time: 47, score: 0.7, reasons: ['audio_pause'] }
    ],
    keywordCuts: [
      { time: 122, score: 0.9, reasons: ['keyword:总结一下'] }
    ],
    transcript: [
      '[0:03] 大家好，今天我们先介绍项目背景。',
      '[0:45] 接下来我们看核心功能。',
      '[1:22] 这里有一个明显的例子。',
      '[2:02] 总结一下，主要结论是这样的。'
    ].join('\n')
  });

  console.log(JSON.stringify({
    mode: result.mode,
    confidence: result.confidence,
    candidateCuts: result.candidateCuts,
    segments: result.segments,
    debug: result.debug
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
