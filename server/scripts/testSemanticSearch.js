const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVectorDb } = require('../services/vectorDb');
const SearchIndexService = require('../services/searchIndexService');
const { SEGMENTS, FixtureEmbeddingService } = require('../services/search/fixtures');

async function main() {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'visionmark-search-demo-'));
  const createService = () => new SearchIndexService({
    vectorDb: createVectorDb({ dbPath }),
    embeddingService: new FixtureEmbeddingService()
  });
  try {
    const service = createService();
    console.log('索引:', await service.indexSegments(SEGMENTS));
    for (const query of ['手机长什么样', '打游戏性能怎么样', '晚上拍照效果']) {
      console.log(`查询「${query}」:`, (await service.search(query, { topK: 1 }))[0]);
    }
    console.log('BVID 过滤:', await service.search('拍照', { videoId: 'BV_PHONE', topK: 3 }));
    await service.indexSegments([SEGMENTS[0]]);
    console.log('重复索引后的记录数:', await createVectorDb({ dbPath }).countSegments());
    console.log('重新连接后的查询:', await createService().search('游戏帧率', { topK: 1 }));
  } finally {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
