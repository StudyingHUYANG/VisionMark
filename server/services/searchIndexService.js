const EmbeddingService = require('./embeddingService');
const vectorDb = require('./vectorDb');
const { normalizeSegment, buildIndexText, stableRecordId } = require('./segmentContract');
const { mapSearchResult } = require('./searchResultMapper');
const { SearchError, errorFactories } = require('./searchErrors');

class SearchIndexService {
  constructor(options = {}) {
    this.embeddingService = options.embeddingService || new EmbeddingService();
    this.vectorDb = options.vectorDb || vectorDb;
  }

  ensureEmbeddingConfigured() {
    if (!this.embeddingService.isReady()) throw errorFactories.embeddingNotConfigured();
  }

  async embedTexts(texts) {
    this.ensureEmbeddingConfigured();
    try {
      if (typeof this.embeddingService.embedTexts === 'function') return await this.embeddingService.embedTexts(texts);
      return await Promise.all(texts.map(text => this.embeddingService.embedText(text)));
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw errorFactories.embeddingFailed(error);
    }
  }

  async indexSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('segments 必须是非空数组');
    const normalized = segments.map(normalizeSegment);
    const texts = normalized.map(buildIndexText);
    const vectors = await this.embedTexts(texts);
    const records = normalized.map((segment, index) => ({
      id: stableRecordId(segment.videoId, segment.segmentId),
      vector: vectors[index],
      ...segment,
      indexedText: texts[index],
      updatedAt: new Date().toISOString()
    }));
    const result = await this.vectorDb.upsertSegments(records);
    return { ...result, videoIds: [...new Set(normalized.map(item => item.videoId))] };
  }

  async search(query, options = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new TypeError('搜索词 q 不能为空');
    const topK = Number(options.topK ?? 5);
    if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new RangeError('topK 必须是 1-20 的整数');
    const [queryVector] = await this.embedTexts([normalizedQuery]);
    const rows = await this.vectorDb.searchSegments(queryVector, { topK, videoId: options.videoId || null });
    return rows.map(mapSearchResult);
  }
}

module.exports = SearchIndexService;
