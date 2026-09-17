const path = require('path');

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const searchConfig = Object.freeze({
  apiKey: process.env.DASHSCOPE_API_KEY || '',
  apiBaseUrl: (process.env.DASHSCOPE_API_BASE || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, ''),
  visualModel: process.env.SEARCH_VL_MODEL || 'qwen3-vl-embedding',
  textModel: process.env.SEARCH_TEXT_MODEL || 'text-embedding-v4',
  rerankModel: process.env.SEARCH_RERANK_MODEL || 'qwen3-vl-rerank',
  dimension: parsePositiveInt(process.env.SEARCH_VECTOR_DIM, 1024),
  enableRerank: parseBoolean(process.env.SEARCH_ENABLE_RERANK, true),
  requestConcurrency: Math.min(parsePositiveInt(process.env.SEARCH_REQUEST_CONCURRENCY, 2), 8),
  requestTimeoutMs: parsePositiveInt(process.env.SEARCH_REQUEST_TIMEOUT_MS, 60000),
  maxWindows: parsePositiveInt(process.env.SEARCH_MAX_WINDOWS, 600),
  baseWindowSeconds: parsePositiveInt(process.env.SEARCH_WINDOW_SECONDS, 8),
  baseStrideSeconds: parsePositiveInt(process.env.SEARCH_STRIDE_SECONDS, 4),
  assetsDir: path.join(__dirname, '../database/search_assets')
});

module.exports = searchConfig;
