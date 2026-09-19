const express = require('express');
const path = require('path');
const { authenticateToken } = require('../middlewares/auth');
const vectorDb = require('../services/vectorDb');
const indexStore = require('../services/search/searchIndexStore');
const searchConfig = require('../config/search');
const {
  MultimodalSearchService,
  SearchError,
  validateBvid
} = require('../services/search/multimodalSearchService');

const router = express.Router();
const searchService = new MultimodalSearchService();

function sendSearchError(res, error) {
  const statusCode = error instanceof SearchError ? error.statusCode : 500;
  return res.status(statusCode).json({
    success: false,
    error: error.code || 'SEARCH_FAILED',
    message: error.message
  });
}

router.post('/multimodal', authenticateToken, async (req, res) => {
  try {
    res.json(await searchService.search(req.body || {}));
  } catch (error) {
    console.error('[MultimodalSearch] 搜索失败:', error.message);
    sendSearchError(res, error);
  }
});

router.get('/semantic', authenticateToken, async (req, res) => {
  try {
    const data = await searchService.search({
      bvid: req.query.bvid,
      query: req.query.q,
      topK: req.query.topk
    });
    res.json({
      ...data,
      results: data.results.map(result => ({
        ...result,
        timestamp: result.seekTime
      }))
    });
  } catch (error) {
    sendSearchError(res, error);
  }
});

router.get('/status', authenticateToken, (req, res) => {
  try {
    const bvid = validateBvid(req.query.bvid);
    res.json({ success: true, bvid, ...indexStore.getStatus(bvid) });
  } catch (error) {
    sendSearchError(res, error);
  }
});

router.get('/frames', authenticateToken, async (req, res) => {
  try {
    const bvid = validateBvid(req.query.bvid);
    const row = indexStore.getIndexRow(bvid);
    if (!row?.active_run_id) return res.json({ success: true, frames: [] });
    const windows = await vectorDb.getIndexedWindows(bvid, row.active_run_id);
    res.json({
      success: true,
      frames: windows.map(window => ({
        bvid,
        timestamp: Number(window.startTime),
        startTime: Number(window.startTime),
        endTime: Number(window.endTime)
      }))
    });
  } catch (error) {
    sendSearchError(res, error);
  }
});

router.get('/thumbnails/:bvid/:windowId', authenticateToken, async (req, res) => {
  try {
    const bvid = validateBvid(req.params.bvid);
    const row = indexStore.getIndexRow(bvid);
    if (!row?.active_run_id) return res.status(404).json({ error: 'SEARCH_INDEX_NOT_READY' });
    const metadata = await vectorDb.getWindowMetadata(bvid, row.active_run_id, req.params.windowId);
    if (!metadata?.thumbnailPath) return res.status(404).json({ error: 'THUMBNAIL_NOT_FOUND' });
    const resolved = path.resolve(metadata.thumbnailPath);
    const assetsRoot = `${path.resolve(searchConfig.assetsDir)}${path.sep}`;
    if (!resolved.startsWith(assetsRoot)) return res.status(403).json({ error: 'INVALID_THUMBNAIL_PATH' });
    res.sendFile(resolved);
  } catch (error) {
    sendSearchError(res, error);
  }
});

module.exports = router;
