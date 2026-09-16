class SearchError extends Error {
  constructor(code, message, status = 500, cause = null) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

const errorFactories = {
  embeddingNotConfigured: () => new SearchError('EMBEDDING_NOT_CONFIGURED', '服务端未配置文本 Embedding 接口', 503),
  indexNotFound: () => new SearchError('SEGMENT_INDEX_NOT_FOUND', 'segment 语义索引尚未建立', 404),
  dimensionMismatch: (expected, actual) => new SearchError(
    'VECTOR_DIMENSION_MISMATCH',
    `向量维度不一致: index=${expected}, query=${actual}`,
    409
  ),
  embeddingFailed: cause => new SearchError('EMBEDDING_FAILED', '文本向量化失败', 502, cause)
};

module.exports = { SearchError, errorFactories };
