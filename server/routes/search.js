const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth');
const vectorDb = require('../services/vectorDb');
const EmbeddingService = require('../services/embeddingService');

/**
 * 根据文本语义搜索视频帧
 * GET /api/v1/search/semantic
 * Query Params:
 *  - bvid: 选填。指定搜索特定的视频，不传则在所有已处理视频中搜索。
 *  - q: 必填。用户的搜索词。
 *  - topk: 选填。返回的结果数，默认 5。
 */
router.get('/semantic', authenticateToken, async (req, res) => {
  try {
    const { bvid, q, topk } = req.query;

    if (!vectorDb.isReady()) {
      return res.status(503).json({ error: '系统未配置 Qdrant 向量引擎' });
    }

    if (!q) {
      return res.status(400).json({ error: '必须提供搜索词 q' });
    }

    const embeddingService = new EmbeddingService();
    if (!embeddingService.isReady()) {
      return res.status(503).json({ error: '服务端未配置 Embedding 接口' });
    }

    const k = topk ? parseInt(topk, 10) : 5;

    console.log(`[SemanticSearch] 收到请求: q="${q}", bvid="${bvid || '全部'}", topk=${k}`);

    // 1. 将关键词转化为向量
    const queryVector = await embeddingService.embedText(q);

    // 2. 从 Qdrant 查询最相似的帧并提取元数据
    const results = await vectorDb.searchSimilarFrames(bvid || null, queryVector, k);

    res.json({
      success: true,
      query: q,
      results
    });
  } catch (error) {
    console.error('[SemanticSearch] 语义搜索失败:', error);
    res.status(500).json({ error: '语义搜索失败', message: error.message });
  }
});

router.get('/frames', authenticateToken, async (req, res) => {
  try {
    const { bvid } = req.query;
    if (!bvid) return res.status(400).json({ error: '缺少bvid参数' });
    if (!vectorDb.isReady()) {
      return res.status(503).json({ error: '系统未配置 Qdrant 向量引擎' });
    }
    const frames = await vectorDb.getAllFrames(bvid);
    res.json({ success: true, frames });
  } catch (error) {
    console.error('[SemanticSearch] 获取视频帧失败:', error);
    res.status(500).json({ error: '获取视频帧失败', message: error.message });
  }
});

module.exports = router;
