const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildMaterialExtraction,
  resolveMaterialFramePath,
  selectRepresentativeFrames
} = require('./materialExtractionService');

test('representative frames stay inside the segment and cover its timeline', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionmark-material-frames-'));
  try {
    const frames = [1, 4, 7, 10, 13].map(time => {
      const framePath = path.join(tempDir, `${time}.jpg`);
      fs.writeFileSync(framePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { time, framePath };
    });
    const selected = selectRepresentativeFrames({ startTime: 3, endTime: 11 }, frames, 3);
    assert.deepEqual(selected.map(frame => frame.time), [4, 7, 10]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('material extraction skips ads, copies frames and creates bounded edit ranges', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionmark-material-analysis-'));
  const sourceDir = path.join(tempDir, 'source');
  const assetsDir = path.join(tempDir, 'assets');
  fs.mkdirSync(sourceDir, { recursive: true });
  try {
    const frames = [2, 5, 8, 12, 16, 20].map(time => {
      const framePath = path.join(sourceDir, `${time}.jpg`);
      fs.writeFileSync(framePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { time, framePath };
    });
    const result = buildMaterialExtraction({
      bvid: 'BV1234567890',
      duration: 24,
      frames,
      segments: [
        { start: 0, end: 10, title: '内容镜头', type: 'content', confidence: 'high', summary: '人物走进教室' },
        { start: 10, end: 14, title: '广告', type: 'ad', confidence: 'high' },
        { start: 14, end: 24, title: '结尾镜头', type: 'summary', confidence: 'medium' }
      ],
      transcriptSegments: [{ start: 1, end: 6, text: '校园的一天开始了' }]
    }, { assetsDir, clipSeconds: 6 });

    assert.equal(result.clips.length, 2);
    assert.equal(result.clips[0].title, '内容镜头');
    assert.equal(result.clips[0].transcriptExcerpt, '校园的一天开始了');
    assert.ok(result.clips[0].suggestedEndTime - result.clips[0].suggestedStartTime <= 6);
    assert.ok(result.clips[0].representativeFrames.length > 0);
    const firstFrame = result.clips[0].representativeFrames[0];
    const copiedPath = resolveMaterialFramePath({
      bvid: 'BV1234567890',
      runId: result.runId,
      fileName: path.basename(firstFrame.url)
    }, { assetsDir });
    assert.ok(fs.existsSync(copiedPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
