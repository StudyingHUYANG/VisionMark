const express = require('express');
const { authenticateToken } = require('../middlewares/auth');
const vectorDb = require('../services/vectorDb');
const SearchIndexService = require('../services/searchIndexService');
const { SearchError } = require('../services/searchErrors');

const router = express.Router();

function sendError(res, error) {
  if (error instanceof SearchError) {
    return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: error.message } });
  }
  console.error('[SemanticSearch] 请求失败:', error);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '语义搜索失败' } });
}

/**
 * 文本 segment 语义搜索。bvid 作为 videoId 的兼容别名保留。
 * 无匹配不是错误，返回 results: []。
 */
router.get('/semantic', authenticateToken, async (req, res) => {
  try {
    const { q, bvid, videoId } = req.query;
    const topK = req.query.topK ?? req.query.topk ?? 5;
    const service = new SearchIndexService();
    const results = await service.search(q, { videoId: videoId || bvid || null, topK: Number(topK) });
    return res.json({ success: true, query: String(q).trim(), results });
  } catch (error) {
    return sendError(res, error);
  }
});

/**
 * 供分析管道或离线脚本写入标准 segment。真实分析输出接入时只需调用相同服务。
 */
router.post('/segments', authenticateToken, async (req, res) => {
  try {
    const service = new SearchIndexService();
    const result = await service.indexSegments(req.body?.segments);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

// 保留旧帧调试接口，不改变其他成员现有调用。
router.get('/frames', authenticateToken, async (req, res) => {
  try {
    const { bvid } = req.query;
    if (!bvid) throw new TypeError('缺少 bvid 参数');
    return res.json({ success: true, frames: await vectorDb.getAllFrames(bvid) });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
