// 加载环境变量
require('dotenv').config();

const { authenticateToken } = require('./middlewares/auth.js');
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const config = require('./config.js');

const app = express();
const JWT_SECRET = config.JWT_SECRET;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const db = new Database(path.join(__dirname, 'database', 'app.db'));
db.pragma('journal_mode = WAL');

// 初始化表（注意单引号）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze'
  );
  
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    cid INTEGER,
    page INTEGER DEFAULT 1
  );
  
  CREATE TABLE IF NOT EXISTS ad_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL,
    end_time REAL,
    ad_type TEXT,
    contributor_id INTEGER,
    is_active BOOLEAN DEFAULT 1
  );
`);

// 创建测试账号
const admin = db.prepare("SELECT * FROM users WHERE username = ?").get('admin');
if (!admin) {
  const hash = bcrypt.hashSync('admin', 10);
  const u = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run('admin', hash);
  // 关键：使用单引号 'platinum' 而不是双引号
  db.prepare("INSERT INTO user_points (user_id, total_points, tier) VALUES (?, 999, 'platinum')").run(u.lastInsertRowid);
  console.log('[Auth] 测试账号: admin/admin');
}

// Wilson Score计算
function wilsonScore(up, down) {
  const z = 1.96;
  const n = up + down;
  if (n === 0) return 0.5;
  const p = up / n;
  return (p + z*z/(2*n) - z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n);
}

// 中间件：模拟当前用户（实际应使用JWT）
app.use((req, res, next) => {
  req.userId = 1;
  req.userTier = 'platinum'; // 测试时给最高权限
  next();
});

// 获取广告段
app.get('/api/v1/segments', (req, res) => {
  try {
    const { bvid, cid } = req.query;
    // 只返回高质量标注：
    // 1. 置信度 > 0.7 
    // 2. 反对票比例不超过30% (downvotes / (upvotes + downvotes) <= 0.3)
    // 注意：当总投票数为0时，跳过反对票比例检查
    const stmt = db.prepare(`SELECT s.* FROM ad_segments s 
      JOIN videos v ON s.video_id = v.id 
      WHERE v.bvid = ? AND v.cid = ? 
      AND s.is_active = 1 
      AND s.confidence_score > 0.7
      AND (s.upvotes + s.downvotes = 0 OR CAST(s.downvotes AS REAL) / (s.upvotes + s.downvotes) <= 0.3)`);
    const rows = stmt.all(bvid, cid);
    
    // 为每个标注添加投票信息和用户投票状态
    const segmentsWithVotes = rows.map(segment => ({
      ...segment,
      votes: {
        upvotes: segment.upvotes,
        downvotes: segment.downvotes,
        total: segment.upvotes + segment.downvotes,
        confidence_score: segment.confidence_score,
        user_vote: null // 由于缺少 segment_votes 表，无法确定用户投票状态
      },
      // 保留原始字段以保持向后兼容
      upvotes: segment.upvotes,
      downvotes: segment.downvotes,
      total_votes: segment.upvotes + segment.downvotes
    }));
    
    res.json({ 
      segments: segmentsWithVotes,
      message: '注意：当前实现无法返回用户投票状态，建议在生产环境创建 segment_votes 表'
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 创建标注
app.post('/api/v1/segments', (req, res) => {
  try {
    const { bvid, cid, start_time, end_time, ad_type } = req.body;
    
    const insertVideo = db.prepare('INSERT OR IGNORE INTO videos (bvid, cid) VALUES (?, ?)');
    insertVideo.run(bvid, cid);
    
    const video = db.prepare('SELECT id FROM videos WHERE bvid = ? AND cid = ?').get(bvid, cid);
    
    const insertSeg = db.prepare(`INSERT INTO ad_segments 
      (video_id, start_time, end_time, ad_type, contributor_id, is_active, confidence_score, upvotes) 
      VALUES (?, ?, ?, ?, ?, 1, 0.8, 3)`);
    
    const result = insertSeg.run(video.id, start_time, end_time, ad_type, req.userId);
    
    // 更新用户积分
    db.prepare('UPDATE user_points SET total_points = total_points + 10 WHERE user_id = ?').run(req.userId);
    
    res.status(201).json({ 
      id: result.lastInsertRowid,
      message: '标注已创建',
      points_earned: 10
    });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// 投票
app.post('/api/v1/segments/:id/vote', (req, res) => {
  try {
    const { type } = req.body;
    const segmentId = parseInt(req.params.id);
    
    // 验证用户登录状态（已通过中间件保证）
    if (!req.userId) {
      return res.status(401).json({ error: '未授权访问' });
    }
    
    // 验证投票类型
    if (type !== 'up' && type !== 'down') {
      return res.status(400).json({ error: '无效的投票类型，必须是 "up" 或 "down"' });
    }
    
    // 检查标注是否存在
    const segment = db.prepare('SELECT id, upvotes, downvotes, confidence_score FROM ad_segments WHERE id = ? AND is_active = 1').get(segmentId);
    if (!segment) {
      return res.status(404).json({ error: '标注不存在或已被禁用' });
    }
    
    // 注意：由于数据库缺少 segment_votes 表，无法实现真正的防重复投票
    // 基于现有表结构，我们只能简单增加投票数
    // 在实际生产环境中，应该创建 segment_votes 表并添加唯一约束
    
    const field = type === 'up' ? 'upvotes' : 'downvotes';
    db.prepare(`UPDATE ad_segments SET ${field} = ${field} + 1 WHERE id = ?`).run(segmentId);
    
    // 重新计算置信度
    const updatedSeg = db.prepare('SELECT upvotes, downvotes FROM ad_segments WHERE id = ?').get(segmentId);
    const conf = wilsonScore(updatedSeg.upvotes, updatedSeg.downvotes);
    db.prepare('UPDATE ad_segments SET confidence_score = ? WHERE id = ?').run(conf, segmentId);
    
    // 添加投票奖励：每次投票+2积分
    // 注意：由于无法防止重复投票，这里每次投票都会奖励积分
    // 在完整实现中，应该检查用户是否已对该标注投票过
    db.prepare('UPDATE user_points SET total_points = total_points + 2 WHERE user_id = ?').run(req.userId);
    
    res.json({ 
      confidence: conf,
      points_earned: 2,
      message: '投票成功'
    });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// 获取投票统计
app.get('/api/v1/segments/:id/votes', (req, res) => {
  try {
    const segmentId = parseInt(req.params.id);
    
    // 获取标注的投票统计
    const stmt = db.prepare(`SELECT 
      upvotes, 
      downvotes, 
      (upvotes + downvotes) as total_votes,
      confidence_score
    FROM ad_segments 
    WHERE id = ? AND is_active = 1`);
    
    const segment = stmt.get(segmentId);
    
    if (!segment) {
      return res.status(404).json({ error: '标注不存在或已被禁用' });
    }
    
    // 注意：由于缺少 segment_votes 表，无法返回当前用户的投票状态
    // 在完整实现中，应该查询 segment_votes 表来获取用户投票状态
    res.json({
      upvotes: segment.upvotes,
      downvotes: segment.downvotes,
      total: segment.total_votes,
      confidence_score: segment.confidence_score,
      user_vote: null, // 无法确定用户投票状态
      message: '注意：当前实现无法防止重复投票和跟踪用户投票状态，建议在生产环境创建 segment_votes 表'
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 登录API
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  
  const token = jwt.sign({ userId: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
  const points = db.prepare("SELECT * FROM user_points WHERE user_id = ?").get(user.id);
  
  res.json({
    token,
    username,
    points: points ? points.total_points : 0,
    tier: points ? points.tier : 'bronze'
  });
});

// 注册API
app.post('/api/v1/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '必填' });

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: '已存在' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
  db.prepare("INSERT INTO user_points (user_id) VALUES (?)").run(result.lastInsertRowid);

  res.json({ message: '注册成功' });
});

// 获取当前用户信息API
app.get('/api/v1/auth/me', authenticateToken, (req, res) => {
  const points = db.prepare("SELECT * FROM user_points WHERE user_id = ?").get(req.user.userId);
  res.json({
    username: req.user.username,
    userId: req.user.userId,
    points: points ? points.total_points : 0,
    tier: points ? points.tier : 'bronze'
  });
});

// 其他API
app.get('/api/v1/segments', (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.json({ segments: [] });
  const rows = db.prepare("SELECT s.* FROM ad_segments s JOIN videos v ON s.video_id = v.id WHERE v.bvid = ?").all(bvid);
  res.json({ segments: rows });
});

app.post('/api/v1/segments', authenticateToken, (req, res) => {
  const { bvid, cid, start_time, end_time, ad_type } = req.body;
  const userId = req.user.userId;
  
  let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
  if (!video) {
    const r = db.prepare("INSERT INTO videos (bvid, cid) VALUES (?, ?)").run(bvid, cid || null);
    video = { id: r.lastInsertRowid };
  }
  
  const result = db.prepare("INSERT INTO ad_segments (video_id, start_time, end_time, ad_type, contributor_id, is_active) VALUES (?, ?, ?, ?, ?, 1)").run(video.id, start_time, end_time, ad_type, userId);
  
  // Award points
  db.prepare("UPDATE user_points SET total_points = total_points + 10 WHERE user_id = ?").run(userId);

  res.json({ id: result.lastInsertRowid, message: '提交成功' });
});

app.get('/api/v1/health', (req, res) => res.json({ ok: true }));

// 引入路由文件
const statsRouter = require('./routes/stats.js');
const segmentsRouter = require('./routes/segments.js');
const videoAnalysisRouter = require('./routes/videoAnalysis.js');

// 注册路由
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1/segments', segmentsRouter); // 补充批量/删除接口，和原有segments接口合并
app.use('/video-analysis', videoAnalysisRouter); // AI视频分析路由

// Get user's all segments
app.get('/api/v1/segments/user', authenticateToken, (req, res) => {
  const userId = req.user.userId;

  const rows = db.prepare(`
    SELECT
      s.id, s.start_time, s.end_time, s.ad_type,
      v.bvid, v.page,
      datetime(s.created_at, 'localtime') as created_at
    FROM ad_segments s
    JOIN videos v ON s.video_id = v.id
    WHERE s.contributor_id = ?
    ORDER BY s.created_at DESC
  `).all(userId);

  res.json({ segments: rows });
});

// 使用配置文件的端口
app.listen(config.PORT, '0.0.0.0', () => {
  console.log('[Server] http://localhost:' + config.PORT);
  console.log('[Auth] admin/admin 登录');
});


