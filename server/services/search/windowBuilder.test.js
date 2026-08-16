const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachTranscript,
  buildWindows,
  hammingDistance,
  normalizeTranscript,
  selectRepresentativeFrames
} = require('./windowBuilder');

test('buildWindows creates overlapping windows and covers the video end', () => {
  const windows = buildWindows(20, [], { windowSeconds: 8, strideSeconds: 4, maxWindows: 600 });
  assert.deepEqual(windows.map(item => [item.startTime, item.endTime]), [
    [0, 8],
    [4, 12],
    [8, 16],
    [12, 20]
  ]);
});

test('buildWindows limits long videos and retains valid ranges', () => {
  const windows = buildWindows(7200, [100, 3000, 7100], {
    windowSeconds: 8,
    strideSeconds: 4,
    maxBaseWindows: 450,
    maxWindows: 600
  });
  assert.ok(windows.length <= 600);
  assert.ok(windows.every(item => item.startTime >= 0 && item.endTime <= 7200));
});

test('normalizeTranscript parses legacy timestamp text and attaches it to windows', () => {
  const transcript = normalizeTranscript('[0:02] 第一段\n[0:07] 第二段');
  assert.deepEqual(transcript, [
    { start: 2, end: 7, text: '第一段' },
    { start: 7, end: 11, text: '第二段' }
  ]);
  const [window] = attachTranscript([{ id: 'w', startTime: 0, endTime: 8 }], transcript);
  assert.equal(window.transcript, '第一段 第二段');
});

test('representative frame selection drops perceptually near-identical frames', () => {
  const frames = [
    { time: 2, framePath: 'a.jpg' },
    { time: 5, framePath: 'b.jpg' },
    { time: 7, framePath: 'c.jpg' }
  ];
  const hashes = {
    'a.jpg': '0000000000000000',
    'b.jpg': '0000000000000001',
    'c.jpg': 'ffffffffffffffff'
  };
  const selected = selectRepresentativeFrames({ startTime: 0, endTime: 10 }, frames, hashes);
  assert.deepEqual(selected.map(item => item.framePath), ['a.jpg', 'c.jpg']);
  assert.equal(hammingDistance(hashes['a.jpg'], hashes['b.jpg']), 1);
});
