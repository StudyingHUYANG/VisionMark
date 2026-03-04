require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 初始化SQLite数据库（单文件，零配置）
const dbPath = path.join(__dirname, 'database', 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 初始化表结构
function initDB() {
  // 视频表
  db.exec(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    page INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bvid, cid, page)
  )`);
  
  // 广告段表
  db.exec(`CREATE TABLE IF NOT EXISTS ad_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    ad_type TEXT CHECK(ad_type IN ('hard_ad','soft_ad','product_placement','intro_ad','mid_ad')),
    confidence_score REAL DEFAULT 0.8,
    upvotes INTEGER DEFAULT 3,
    downvotes INTEGER DEFAULT 0,
    contributor_id INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id)
  )`);
  
  // 用户表
  db.exec(`CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'gold',
    daily_upload_count INTEGER DEFAULT 0,
    last_upload_date DATE DEFAULT CURRENT_DATE
  )`);
  
  // 插入测试用户
  const stmt = db.prepare('INSERT OR IGNORE INTO user_points (user_id, total_points, tier) VALUES (1, 999, "platinum")');
  stmt.run();
  
  console.log('[DB] SQLite数据库初始化完成:', dbPath);
}

initDB();

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
    const stmt = db.prepare(`SELECT s.* FROM ad_segments s 
      JOIN videos v ON s.video_id = v.id 
      WHERE v.bvid = ? AND v.cid = ? AND s.is_active = 1`);
    const rows = stmt.all(bvid, cid);
    res.json({ segments: rows });
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
    const field = type === 'up' ? 'upvotes' : 'downvotes';
    db.prepare(`UPDATE ad_segments SET ${field} = ${field} + 1 WHERE id = ?`).run(req.params.id);
    
    // 重新计算置信度
    const seg = db.prepare('SELECT upvotes, downvotes FROM ad_segments WHERE id = ?').get(req.params.id);
    const conf = wilsonScore(seg.upvotes, seg.downvotes);
    db.prepare('UPDATE ad_segments SET confidence_score = ? WHERE id = ?').run(conf, req.params.id);
    
    res.json({ confidence: conf });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// 获取用户统计
app.get('/api/v1/user/stats', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM user_points WHERE user_id = ?').get(req.userId);
    res.json(user || { tier: 'bronze', points: 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 上报跳过事件
app.post('/api/v1/segments/:id/skip', (req, res) => {
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] 服务运行在 http://localhost:${PORT}`);
  console.log('[Server] 按 Ctrl+C 停止服务');
});
