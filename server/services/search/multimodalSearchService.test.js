const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MultimodalSearchService,
  SearchError,
  aggregateVisualRows,
  reciprocalRankFusion,
  temporalIoU,
  temporalNms
} = require('./multimodalSearchService');

test('aggregateVisualRows applies max and top-two aggregation per window', () => {
  const rows = [
    { windowId: 'a', score: 0.9 },
    { windowId: 'a', score: 0.5 },
    { windowId: 'b', score: 0.7 }
  ];
  const result = aggregateVisualRows(rows);
  assert.equal(result[0].windowId, 'a');
  assert.equal(result[0].score, 0.84);
  assert.equal(result[1].score, 0.7);
});

test('RRF records matching modalities without mixing raw cosine scores', () => {
  const result = reciprocalRankFusion([
    { name: 'visual', weight: 1, results: [{ windowId: 'a' }, { windowId: 'b' }] },
    { name: 'transcript', weight: 1, results: [{ windowId: 'b' }, { windowId: 'c' }] }
  ]);
  assert.equal(result[0].windowId, 'b');
  assert.deepEqual(result[0].matchedModalities.sort(), ['transcript', 'visual']);
});

test('temporal NMS removes strongly overlapping lower-ranked windows', () => {
  const ranked = [
    { id: 'a', startTime: 0, endTime: 8 },
    { id: 'b', startTime: 2, endTime: 10 },
    { id: 'c', startTime: 12, endTime: 20 }
  ];
  assert.ok(temporalIoU(ranked[0], ranked[1]) >= 0.5);
  assert.deepEqual(temporalNms(ranked, 0.5, 10).map(item => item.id), ['a', 'c']);
});

test('search degrades to visual retrieval when transcript query embedding fails', async () => {
  const embedding = {
    isReady: () => true,
    embedVisualText: async () => [1, 0],
    embedTextQuery: async () => { throw new Error('text unavailable'); },
    rerank: async () => { throw new Error('rerank unavailable'); }
  };
  const service = new MultimodalSearchService({
    embeddingService: embedding,
    indexStore: {
      getIndexRow: () => ({ active_run_id: '00000000-0000-0000-0000-000000000000' }),
      getStatus: () => ({ status: 'ready', ready: true, version: 2 })
    },
    vectorDb: {
      searchVisual: async () => [{
        windowId: 'w_0001_0',
        bvid: 'BV1234567890',
        startTime: 0,
        endTime: 8,
        score: 0.8,
        transcript: ''
      }],
      searchText: async () => []
    }
  });
  const result = await service.search({ bvid: 'BV1234567890', query: '手机', topK: 5 });
  assert.equal(result.degraded, true);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].matchedModalities, ['visual']);
});

test('search rejects unindexed videos with a stable error code', async () => {
  const service = new MultimodalSearchService({
    embeddingService: { isReady: () => true },
    indexStore: { getIndexRow: () => null }
  });
  await assert.rejects(
    service.search({ bvid: 'BV1234567890', query: '测试' }),
    error => error instanceof SearchError && error.code === 'SEARCH_INDEX_NOT_READY' && error.statusCode === 409
  );
});
