const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMaterialExtraction } = require('./materialExtractionService');
const { enrichMaterialInsights, clipTranscript, isCopied } = require('./materialInsightService');
const { fallbackSegmentMerge } = require('./segmentPipeline/semanticSegmentMerger');

const rows = [{ start: 0, end: 10, text: '我们现在先打开设置，然后点击这个蓝色按钮，再选择导出文件。' }];
const clip = () => ({ id: 'a', startTime: 0, endTime: 10, representativeFrames: [] });
const options = (items, calls = []) => ({
  modelConfig: { visionModel: 'test-vision' },
  modelClient: { chat: { completions: { create: async (request, config) => {
    calls.push({ request, config });
    return { choices: [{ message: { content: JSON.stringify({ clips: items }) } }] };
  } } } }
});

test('generated insight uses local evidence and is kept separately from transcripts', async () => {
  const calls = [];
  const result = await enrichMaterialInsights({ clips: [clip()] }, { transcriptSegments: rows }, options([
    { id: 'a', status: 'ready', title: '文件导出操作', description: '这一段梳理了从设置入口到文件导出的操作路径，便于理解功能之间的衔接。', highlight: '完整串联入口与导出步骤。' }
  ], calls));
  assert.equal(result.clips[0].insight.source, 'model_analysis');
  assert.match(calls[0].request.messages[1].content[0].text, /蓝色按钮/);
  assert.equal(calls[0].config.maxRetries, 0);
});

test('copied Chinese subtitles and mismatched identifiers cannot become introductions', async () => {
  assert.equal(isCopied(rows[0].text, rows), true);
  const result = await enrichMaterialInsights({ clips: [clip()] }, { transcriptSegments: rows }, options([
    { id: 'a', status: 'ready', title: '导出文件', description: rows[0].text },
    { id: 'other', status: 'ready', title: '其他片段', description: '这个结果不属于当前片段，不能使用。' }
  ]));
  assert.equal(result.clips[0].insight.status, 'unavailable');
  assert.equal(result.clips[0].insight.description, undefined);
});

test('provider failure and insufficient evidence never fall back to raw transcript', async () => {
  const config = options([]);
  config.modelClient.chat.completions.create = async () => { throw new Error('offline'); };
  const failed = await enrichMaterialInsights({ clips: [clip()] }, { transcriptSegments: rows }, config);
  assert.equal(failed.clips[0].insight.status, 'unavailable');
  const insufficient = await enrichMaterialInsights({ clips: [clip()] }, {}, options([{ id: 'a', status: 'insufficient' }]));
  assert.equal(insufficient.clips[0].insight.status, 'insufficient');
  const fallback = fallbackSegmentMerge([], 10, rows);
  assert.equal(fallback[0].summary, '');
  assert.ok(fallback[0].transcriptExcerpt);
});

test('long clip evidence includes late subtitles and excludes other clips', () => {
  const transcript = Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1, text: `内容${i}` }));
  const evidence = clipTranscript({ startTime: 40, endTime: 100 }, transcript);
  assert.equal(evidence.length, 16);
  assert.ok(evidence.at(-1).start > 90);
  assert.ok(evidence.every(row => row.end >= 40 && row.start < 100));
});

test('analysis is batched, and duplicate model IDs are rejected', async () => {
  const calls = [];
  const item = { id: 'a', status: 'ready', title: '标题', description: '这一段介绍了从设置到操作的整体关系。' };
  const result = await enrichMaterialInsights({ clips: Array.from({ length: 5 }, (_, i) => ({ ...clip(), id: i ? String(i) : 'a' })) }, {}, options([item, item], calls));
  assert.equal(calls.length, 2);
  assert.equal(result.clips[0].insight.status, 'unavailable');
});

test('model receives copied representative frame bytes with the matching clip and timestamp', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-insight-'));
  try {
    const framePath = path.join(directory, 'source.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    fs.writeFileSync(framePath, bytes);
    const input = {
      bvid: 'BV1234567890', duration: 10,
      segments: [{ start: 0, end: 10, type: 'content' }],
      frames: [{ time: 5, framePath }], transcriptSegments: rows
    };
    const extraction = buildMaterialExtraction(input, { assetsDir: directory });
    const calls = [];
    await enrichMaterialInsights(extraction, input, { ...options([], calls), assetsDir: directory });
    const parts = calls[0].request.messages[1].content;
    assert.ok(parts.some(part => part.text?.includes(`${extraction.clips[0].id} 在 5 秒`)));
    assert.equal(parts.find(part => part.type === 'image_url').image_url.url,
      `data:image/jpeg;base64,${bytes.toString('base64')}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
