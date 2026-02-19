const express = require('express');
const router = express.Router();
const path = require('path');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken'); 
const JWT_SECRET = 'secret-key-v1';  

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

// 【新增】投票 API (POST /api/v1/segments/:id/vote)
router.post('/:id/vote', authenticateToken, (req, res) => {
  const segmentId = req.params.id;
  const userId = req.user.userId; // 从 token 拿到的用户ID
  const { type } = req.body; // 前端会传 { "type": "up" } 或 "down"

  // 1. 简单的参数校验
  if (!['up', 'down'].includes(type)) {
    return res.status(400).json({ code: 400, msg: '参数错误：type 必须是 up 或 down' });
  }

  // 2. 开启一个“事务”（Transaction）
  // 事务能保证：要么“投票+加分”都成功，要么都失败。不会出现“投了票却没加分”的情况。
  const doVote = db.transaction(() => {
    // 查一下这个人之前有没有投过票
    const existing = db.prepare('SELECT vote_type FROM segment_votes WHERE user_id = ? AND segment_id = ?').get(userId, segmentId);

    if (existing) {
      // --- 情况 A：他以前投过 ---
      if (existing.vote_type === type) {
        throw new Error('DUPLICATE'); // 如果重复投一样的（比如本来是赞，又点赞），报错
      }
      
      // 如果改票（比如从赞变成踩）：只更新记录，不加积分
      db.prepare('UPDATE segment_votes SET vote_type = ? WHERE user_id = ? AND segment_id = ?').run(type, userId, segmentId);
      
      return { msg: '投票已更新', points: 0 }; // 改票不给分

    } else {
      // --- 情况 B：这是他第一次投这个标注 ---
      // 1. 插入投票记录
      db.prepare('INSERT INTO segment_votes (segment_id, user_id, vote_type) VALUES (?, ?, ?)').run(segmentId, userId, type);

      // 2. 【核心功能】奖励积分！给 user_points 表加 2 分
      db.prepare('UPDATE user_points SET total_points = total_points + 2 WHERE user_id = ?').run(userId);
      
      return { msg: '投票成功', points: 2 }; // 首次投票给2分
    }
  });

  try {
    // 执行上面的事务
    const result = doVote();
    res.json({ code: 200, msg: result.msg, points_earned: result.points });
  } catch (err) {
    if (err.message === 'DUPLICATE') {
      return res.status(409).json({ code: 409, msg: '您已经投过这一票了' });
    }
    console.error(err);
    // 如果报错通常是因为数据库表不存在（外键错误）
    res.status(500).json({ code: 500, msg: '投票失败', error: err.message });
  }
});

// 【新增】获取投票统计 API (GET /api/v1/segments/:id/votes)
router.get('/:id/votes', (req, res) => {
  const segmentId = req.params.id;
  let myVote = null; // 默认没投过

  // 1. 如果用户登录了，查查他投了什么 (高亮显示用)
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET); 
      const row = db.prepare('SELECT vote_type FROM segment_votes WHERE user_id = ? AND segment_id = ?').get(decoded.userId, segmentId);
      if (row) myVote = row.vote_type; // 'up' 或 'down'
    } catch (e) {
      // Token无效也没关系，只是不显示“我的投票”而已
    }
  }

  // 2. 统计总数 (直接数 segment_votes 表)
  try {
    const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM segment_votes WHERE segment_id = ? AND vote_type = 'up') as upvotes,
        (SELECT COUNT(*) FROM segment_votes WHERE segment_id = ? AND vote_type = 'down') as downvotes
    `).get(segmentId, segmentId);

    res.json({
      code: 200,
      data: {
        upvotes: stats.upvotes,
        downvotes: stats.downvotes,
        total: stats.upvotes + stats.downvotes,
        user_vote: myVote 
      }
    });
  } catch (err) {
    // 表还没建好的话，返回全0
    res.json({
      code: 200, 
      data: { upvotes: 0, downvotes: 0, total: 0, user_vote: null } 
    });
  }
});

module.exports = router;