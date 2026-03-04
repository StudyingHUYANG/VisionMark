const express = require('express');
const router = express.Router();
const path = require('path');
const Database = require('better-sqlite3');

// 连接数据库（和server.js保持一致的路径）
const db = new Database(path.join(__dirname, '../database', 'app.db'));
db.pragma('journal_mode = WAL');

// 1. 总体统计API - GET /api/v1/stats/overview
router.get('/overview', (req, res) => {
  try {
    // 查询总用户数
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    // 查询总标注数（ad_segments表）
    const totalAnnotations = db.prepare('SELECT COUNT(*) as count FROM ad_segments').get();
    // 总投票数（暂为0，投票系统完成后补充）
    const totalVotes = 0;

    res.status(200).json({
      code: 200,
      msg: 'success',
      data: {
        total_users: totalUsers.count,
        total_annotations: totalAnnotations.count,
        total_votes: totalVotes
      }
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      msg: '服务器内部错误',
      error: err.message
    });
  }
});

// 2. 用户贡献API - GET /api/v1/user/contributions
router.get('/user/contributions', (req, res) => {
  const { user_id, page = 1, page_size = 10 } = req.query;
  
  // 校验必填参数
  if (!user_id) {
    return res.status(400).json({ code: 400, msg: 'user_id必传' });
  }

  // 计算分页偏移量
  const offset = (page - 1) * page_size;
  try {
    // 查询用户的标注记录（关联videos表获取bvid）
    const contributions = db.prepare(`
      SELECT 
        s.id, v.bvid, s.start_time, s.end_time, s.ad_type, s.contributor_id
      FROM ad_segments s
      JOIN videos v ON s.video_id = v.id
      WHERE s.contributor_id = ?
      ORDER BY s.id DESC  -- 按标注ID倒序（替代create_time，表中无该字段）
      LIMIT ? OFFSET ?
    `).all(user_id, page_size, offset);

    // 查询该用户总标注数（用于分页总条数）
    const total = db.prepare(`
      SELECT COUNT(*) as count FROM ad_segments WHERE contributor_id = ?
    `).get(user_id);

    res.status(200).json({
      code: 200,
      msg: 'success',
      data: {
        list: contributions,
        page: Number(page),
        page_size: Number(page_size),
        total: total.count
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '查询失败', error: err.message });
  }
});

// 3. 热门视频API - GET /api/v1/stats/popular-videos
router.get('/popular-videos', (req, res) => {
  try {
    // 查询标注最多的视频TOP20（关联ad_segments和videos表）
    const topVideos = db.prepare(`
      SELECT 
        v.bvid, COUNT(s.id) as annotation_count
      FROM videos v
      LEFT JOIN ad_segments s ON v.id = s.video_id
      GROUP BY v.bvid
      ORDER BY annotation_count DESC
      LIMIT 20
    `).all();

    res.status(200).json({ code: 200, msg: 'success', data: topVideos });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '查询失败', error: err.message });
  }
});

// 4. 活跃用户API - GET /api/v1/stats/top-users
router.get('/top-users', (req, res) => {
  try {
    // 查询积分最高的用户TOP10（关联users和user_points表）
    const topUsers = db.prepare(`
      SELECT 
        u.id, u.username, up.total_points
      FROM users u
      JOIN user_points up ON u.id = up.user_id
      ORDER BY up.total_points DESC
      LIMIT 10
    `).all();

    res.status(200).json({ code: 200, msg: 'success', data: topUsers });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '查询失败', error: err.message });
  }
});

module.exports = router;