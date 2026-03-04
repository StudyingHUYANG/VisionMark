const express = require('express');
const router = express.Router();
const path = require('path');
const Database = require('better-sqlite3');

// 连接数据库（和server.js保持一致）
const db = new Database(path.join(__dirname, '../database', 'app.db'));
db.pragma('journal_mode = WAL');

// 从独立的auth.js引入中间件（关键修复！）
const { authenticateToken, checkContributor } = require('../middlewares/auth.js');

// 1. 删除标注API - DELETE /api/v1/segments/:id
// 先通过authenticateToken验证登录，再通过checkContributor验证权限
router.delete('/:id', authenticateToken, checkContributor, (req, res) => {
  const segmentId = req.params.id;

  try {
    // 级联删除：先删除标注（表中无投票记录，暂只删标注）
    const result = db.prepare(`
      DELETE FROM ad_segments WHERE id = ?
    `).run(segmentId);

    if (result.changes === 0) {
      return res.status(404).json({ code: 404, msg: '标注删除失败，标注不存在' });
    }

    res.status(200).json({ code: 200, msg: '标注删除成功' });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '删除失败', error: err.message });
  }
});

// 2. 批量查询API - POST /api/v1/segments/batch
router.post('/batch', (req, res) => {
  const { bvids } = req.body;

  // 校验参数
  if (!Array.isArray(bvids) || bvids.length === 0) {
    return res.status(400).json({ code: 400, msg: 'bvids必须为非空数组' });
  }

  try {
    // 批量查询多个bvid的广告段（优化性能：一次查询）
    const placeholders = bvids.map(() => '?').join(',');
    const segments = db.prepare(`
      SELECT 
        s.id, s.start_time, s.end_time, s.ad_type, s.contributor_id, v.bvid
      FROM ad_segments s
      JOIN videos v ON s.video_id = v.id
      WHERE v.bvid IN (${placeholders})
    `).all(...bvids);

    // 按bvid分组，方便前端处理
    const result = {};
    bvids.forEach(bvid => {
      result[bvid] = segments.filter(s => s.bvid === bvid);
    });

    res.status(200).json({
      code: 200,
      msg: 'success',
      data: result
    });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '批量查询失败', error: err.message });
  }
});

module.exports = router;