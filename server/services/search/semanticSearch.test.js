const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVectorDb } = require('../vectorDb');
const SearchIndexService = require('../searchIndexService');
const { SEGMENTS, FixtureEmbeddingService } = require('./fixtures');

function createHarness(t) {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'visionmark-search-'));
  t.after(() => fs.rmSync(dbPath, { recursive: true, force: true }));
  const vectorDb = createVectorDb({ dbPath });
  const service = new SearchIndexService({ vectorDb, embeddingService: new FixtureEmbeddingService() });
  return { dbPath, vectorDb, service };
}

test('单视频搜索和标准返回字段', async t => {
  const { service } = createHarness(t);
  await service.indexSegments(SEGMENTS);
  const results = await service.search('打游戏性能怎么样', { videoId: 'BV_PHONE', topK: 3 });
  assert.equal(results[0].segmentId, 'gaming');
  assert.deepEqual(Object.keys(results[0]), ['videoId', 'segmentId', 'start', 'end', 'score', 'title', 'snippet']);
  assert.ok(results.every(result => result.videoId === 'BV_PHONE'));
});

test('跨视频搜索返回正确 Top-1', async t => {
  const { service } = createHarness(t);
  await service.indexSegments(SEGMENTS);
  const results = await service.search('晚上拍照效果', { topK: 4 });
  assert.equal(results[0].segmentId, 'night-photo');
  assert.equal(results[0].videoId, 'BV_CAMERA');
});

test('重复索引按 videoId + segmentId 幂等更新', async t => {
  const { service, vectorDb } = createHarness(t);
  await service.indexSegments(SEGMENTS);
  await service.indexSegments([{ ...SEGMENTS[0], title: '更新后的外观标题' }]);
  assert.equal(await vectorDb.countSegments(), SEGMENTS.length);
  const results = await service.search('手机长什么样', { topK: 1 });
  assert.equal(results[0].title, '更新后的外观标题');
});

test('LanceDB 数据在重新连接后仍可搜索', async t => {
  const { dbPath, service } = createHarness(t);
  await service.indexSegments(SEGMENTS);
  const reopened = new SearchIndexService({
    vectorDb: createVectorDb({ dbPath }),
    embeddingService: new FixtureEmbeddingService()
  });
  const results = await reopened.search('游戏帧率', { topK: 1 });
  assert.equal(results[0].segmentId, 'gaming');
});

test('明确区分索引不存在、维度不一致、未配置和 embedding 失败', async t => {
  const { vectorDb, service } = createHarness(t);
  await assert.rejects(() => service.search('任意查询'), error => error.code === 'SEGMENT_INDEX_NOT_FOUND');
  await service.indexSegments(SEGMENTS);
  await assert.rejects(() => vectorDb.searchSegments([1, 2]), error => error.code === 'VECTOR_DIMENSION_MISMATCH');

  const notConfigured = new SearchIndexService({ vectorDb, embeddingService: { isReady: () => false } });
  await assert.rejects(() => notConfigured.search('查询'), error => error.code === 'EMBEDDING_NOT_CONFIGURED');

  const failed = new SearchIndexService({
    vectorDb,
    embeddingService: { isReady: () => true, embedTexts: async () => { throw new Error('network'); } }
  });
  await assert.rejects(() => failed.search('查询'), error => error.code === 'EMBEDDING_FAILED');
});

test('topK 只接受 1-20，过滤无匹配时返回空数组', async t => {
  const { service } = createHarness(t);
  await service.indexSegments(SEGMENTS);
  await assert.rejects(() => service.search('查询', { topK: 21 }), /1-20/);
  assert.deepEqual(await service.search('查询', { videoId: 'BV_NOT_FOUND', topK: 5 }), []);
});
