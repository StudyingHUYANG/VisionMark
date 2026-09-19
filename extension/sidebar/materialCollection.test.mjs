import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipRecord, saveClip, readClip, listClips, removeClip, matchesClip,
  serializeCollection, COLLECTION_PREFIX } from './materialCollection.mjs';

const context = { bvid: 'BV1234567890', page: 1, videoTitle: '自然纪录', apiBase: 'http://localhost:8080' };
const clip = {
  id: 'random-run:1', startTime: 10, endTime: 20, title: '内容片段1',
  summary: '这段转录不应作为介绍', transcriptExcerpt: '原始字幕',
  insight: { status: 'ready', source: 'model_analysis', title: '水面白鹅', description: '白鹅在水面游动，光影与波纹形成对比。', highlight: '宁静的水面与明亮的主体。' },
  representativeFrames: [{ time: 15, url: '/video-analysis/material-frames/BV1234567890/run/clip_001_frame_01.jpg' }]
};

function mockChrome(initial = {}) {
  const data = structuredClone(initial);
  const api = { runtime: {}, storage: { local: {
    get(key, callback) { queueMicrotask(() => callback(structuredClone(key === null ? data : { [key]: data[key] }))); },
    set(values, callback) { Object.assign(data, structuredClone(values)); queueMicrotask(callback); },
    remove(key, callback) { delete data[key]; queueMicrotask(callback); }
  } } };
  return api;
}

test('stable source and time identity deduplicates re-analysis without losing user edits', async () => {
  const api = mockChrome();
  const record = createClipRecord(clip, context);
  const first = await saveClip(record, { title: '我的白鹅镜头', tags: '水面，宁静,水面', note: '片头使用', folder: '自然' }, api);
  const next = createClipRecord({ ...clip, id: 'another-run:8', title: '新标题' }, context);
  assert.equal(next.id, record.id);
  await saveClip(next, {}, api);
  const all = await listClips(api);
  assert.equal(all.length, 1);
  assert.equal(all[0].title, '我的白鹅镜头');
  assert.deepEqual(all[0].tags, ['水面', '宁静']);
  assert.equal(all[0].createdAt, first.createdAt);
  assert.equal(all[0].note, '片头使用');
});

test('different clips use independent keys, survive concurrent writes and can be removed', async () => {
  const api = mockChrome();
  const a = createClipRecord(clip, context);
  const b = createClipRecord({ ...clip, startTime: 30, endTime: 40 }, context);
  await Promise.all([saveClip(a, {}, api), saveClip(b, {}, api)]);
  assert.equal((await listClips(api)).length, 2);
  await removeClip(a.id, api);
  assert.equal(await readClip(a.id, api), null);
  assert.equal((await listClips(api))[0].id, b.id);
});

test('search includes descriptions, highlights and user annotations', () => {
  const record = { ...createClipRecord(clip, context), tags: ['动物'], note: '片头', folder: '自然' };
  assert.ok(matchesClip(record, '波纹 宁静 动物 片头'));
  assert.ok(matchesClip(record, '自然纪录'));
  assert.equal(matchesClip(record, '城市'), false);
});

test('export excludes authentication, transcript fallbacks and transient image URLs', async () => {
  const record = createClipRecord({ ...clip, insight: null, representativeFrames: [
    ...clip.representativeFrames,
    { time: 16, url: 'https://other.example/image.jpg' },
    { time: 17, url: '/video-analysis/material-frames/BV1234567890/image.jpg?token=secret' },
    { time: 18, url: 'blob:transient' },
    { time: 90, url: clip.representativeFrames[0].url }
  ] }, context);
  assert.equal(record.representativeFrames.length, 1);
  assert.equal(record.analysis.description, '');
  const output = serializeCollection([{ ...record, token: 'secret', cookie: 'private', frames: ['blob:transient'] }]);
  assert.doesNotMatch(output, /secret|private|blob:|原始字幕|这段转录/);
  assert.equal(JSON.parse(output).schema, 'visionmark.clip-collection');
  const api = mockChrome({ adskipper_token: 'secret', [COLLECTION_PREFIX + record.id]: record });
  assert.equal((await listClips(api)).length, 1);
});

test('invalid sources and ranges fail before saving', () => {
  assert.throws(() => createClipRecord(clip, { ...context, bvid: '../bad' }));
  assert.throws(() => createClipRecord({ ...clip, endTime: 5 }, context));
  assert.throws(() => createClipRecord({ ...clip, startTime: NaN }, context));
});

test('storage quota errors reject saves rather than reporting success', async () => {
  const api = mockChrome();
  api.storage.local.set = (_, callback) => {
    api.runtime.lastError = { message: 'QUOTA_BYTES exceeded' };
    callback();
    delete api.runtime.lastError;
  };
  await assert.rejects(saveClip(createClipRecord(clip, context), {}, api), /QUOTA_BYTES/);
});
