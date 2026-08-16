const EmbeddingService = require('../embeddingService');
const vectorDb = require('../vectorDb');
const indexStore = require('./searchIndexStore');

class SearchError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateBvid(bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) {
    throw new SearchError('INVALID_BVID', 'BVID 格式不正确', 400);
  }
  return bvid;
}

function validateQuery(query) {
  const normalized = String(query || '').trim();
  if (!normalized) throw new SearchError('INVALID_QUERY', '搜索词不能为空', 400);
  if (normalized.length > 200) throw new SearchError('INVALID_QUERY', '搜索词不能超过 200 个字符', 400);
  return normalized;
}

function aggregateVisualRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const item = grouped.get(row.windowId) || { ...row, frameScores: [] };
    item.frameScores.push(Number(row.score) || 0);
    if (!item.thumbnailPath && row.thumbnailPath) item.thumbnailPath = row.thumbnailPath;
    if (!item.transcript && row.transcript) item.transcript = row.transcript;
    grouped.set(row.windowId, item);
  }
  return [...grouped.values()].map(item => {
    const scores = item.frameScores.sort((a, b) => b - a);
    const topTwoAverage = scores.slice(0, 2).reduce((sum, value) => sum + value, 0) / Math.min(scores.length, 2);
    return { ...item, score: 0.7 * scores[0] + 0.3 * topTwoAverage };
  }).sort((a, b) => b.score - a.score);
}

function reciprocalRankFusion(channels, k = 60) {
  const fused = new Map();
  for (const channel of channels) {
    channel.results.forEach((result, index) => {
      const current = fused.get(result.windowId) || {
        id: result.windowId,
        windowId: result.windowId,
        bvid: result.bvid,
        startTime: Number(result.startTime),
        endTime: Number(result.endTime),
        transcript: result.transcript || '',
        thumbnailPath: result.thumbnailPath || '',
        matchedModalities: [],
        rrfScore: 0
      };
      current.rrfScore += channel.weight / (k + index + 1);
      if (!current.matchedModalities.includes(channel.name)) current.matchedModalities.push(channel.name);
      if (!current.transcript && result.transcript) current.transcript = result.transcript;
      if (!current.thumbnailPath && result.thumbnailPath) current.thumbnailPath = result.thumbnailPath;
      fused.set(result.windowId, current);
    });
  }
  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

function temporalIoU(left, right) {
  const intersection = Math.max(0, Math.min(left.endTime, right.endTime) - Math.max(left.startTime, right.startTime));
  const union = Math.max(left.endTime, right.endTime) - Math.min(left.startTime, right.startTime);
  return union > 0 ? intersection / union : 0;
}

function temporalNms(results, threshold = 0.5, limit = 20) {
  const kept = [];
  for (const candidate of results) {
    if (kept.some(existing => temporalIoU(existing, candidate) >= threshold)) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept;
}

class MultimodalSearchService {
  constructor(options = {}) {
    this.embedding = options.embeddingService || new EmbeddingService();
    this.vectorDb = options.vectorDb || vectorDb;
    this.store = options.indexStore || indexStore;
  }

  async search(input) {
    const bvid = validateBvid(input.bvid);
    const query = validateQuery(input.query);
    const topK = Math.max(1, Math.min(Number.parseInt(input.topK, 10) || 5, 20));
    const indexRow = this.store.getIndexRow(bvid);
    if (!indexRow?.active_run_id) {
      throw new SearchError('SEARCH_INDEX_NOT_READY', '该视频的跨模态检索索引尚未就绪', 409);
    }
    if (!this.embedding.isReady()) {
      throw new SearchError('SEARCH_PROVIDER_NOT_CONFIGURED', '服务端未配置 DASHSCOPE_API_KEY', 503);
    }

    const [visualVectorResult, textVectorResult] = await Promise.allSettled([
      this.embedding.embedVisualText(query),
      this.embedding.embedTextQuery(query)
    ]);
    const channels = [];
    const warnings = [];

    if (visualVectorResult.status === 'fulfilled') {
      try {
        const visualRows = await this.vectorDb.searchVisual(bvid, indexRow.active_run_id, visualVectorResult.value, 90);
        const visualWindows = aggregateVisualRows(visualRows).slice(0, 30);
        if (visualWindows.length) channels.push({ name: 'visual', weight: 1, results: visualWindows });
      } catch (error) {
        warnings.push(`视觉召回失败: ${error.message}`);
      }
    } else {
      warnings.push(`视觉查询向量失败: ${visualVectorResult.reason?.message || '未知错误'}`);
    }

    if (textVectorResult.status === 'fulfilled') {
      try {
        const textWindows = await this.vectorDb.searchText(bvid, indexRow.active_run_id, textVectorResult.value, 30);
        if (textWindows.length) channels.push({ name: 'transcript', weight: 1, results: textWindows });
      } catch (error) {
        warnings.push(`字幕召回失败: ${error.message}`);
      }
    } else {
      warnings.push(`字幕查询向量失败: ${textVectorResult.reason?.message || '未知错误'}`);
    }

    if (!channels.length) {
      throw new SearchError('SEARCH_RECALL_FAILED', warnings.join('; ') || '没有可用的检索通道', 503);
    }

    let candidates = temporalNms(reciprocalRankFusion(channels), 0.5, 20);
    let reranked = false;
    try {
      const rerankScores = await this.embedding.rerank(query, candidates, topK);
      if (rerankScores?.size) {
        candidates = candidates
          .map(candidate => ({ ...candidate, rerankScore: rerankScores.get(candidate.id) }))
          .sort((a, b) => {
            const left = Number.isFinite(a.rerankScore) ? a.rerankScore : -Infinity;
            const right = Number.isFinite(b.rerankScore) ? b.rerankScore : -Infinity;
            return right - left || b.rrfScore - a.rrfScore;
          });
        reranked = true;
      }
    } catch (error) {
      warnings.push(`多模态重排失败: ${error.message}`);
    }

    const maxRrf = Math.max(...candidates.map(candidate => candidate.rrfScore), 1e-9);
    const results = candidates.slice(0, topK).map(candidate => ({
      id: candidate.id,
      bvid,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      seekTime: candidate.startTime,
      score: reranked && Number.isFinite(candidate.rerankScore)
        ? Math.max(0, Math.min(1, candidate.rerankScore))
        : Math.max(0, Math.min(1, candidate.rrfScore / maxRrf)),
      matchedModalities: candidate.matchedModalities,
      evidence: { transcript: candidate.transcript || '' },
      thumbnailUrl: candidate.thumbnailPath
        ? `/api/v1/search/thumbnails/${bvid}/${candidate.id}`
        : null
    }));

    return {
      success: true,
      query,
      bvid,
      degraded: warnings.length > 0 || !reranked,
      warnings,
      index: this.store.getStatus(bvid),
      results
    };
  }
}

module.exports = {
  MultimodalSearchService,
  SearchError,
  aggregateVisualRows,
  reciprocalRankFusion,
  temporalIoU,
  temporalNms,
  validateBvid,
  validateQuery
};
