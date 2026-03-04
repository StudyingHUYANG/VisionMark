// 加载环境变量
require('dotenv').config();

const { authenticateToken } = require('./middlewares/auth.js');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const Database = require('better-sqlite3');
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
    password_hash TEXT NOT NULL,
    points INTEGER DEFAULT 0  -- 补充 points 字段
  );
  
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT UNIQUE NOT NULL, -- 加上 UNIQUE
    cid INTEGER,
    page INTEGER DEFAULT 1,
    processed_status INTEGER DEFAULT 0 -- 补充 AI 状态字段
  );
  
  CREATE TABLE IF NOT EXISTS segments ( -- 建议统一用 segments 这个名字
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL,
    end_time REAL,
    type TEXT,       -- 对应 ad_type
    content TEXT,    -- 补充内容描述字段
    action TEXT,     -- 补充跳转/标记行为字段
    contributor_id INTEGER,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP -- 补充统计用的时间戳
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


// --- API 路由 ---

// 1. [公共] 获取视频的增强功能数据 (插件端最核心接口)
app.get('/api/v1/video/features', (req, res) => {
    const { bvid } = req.query;
    if (!bvid) return res.status(400).json({ error: '缺少BVID' });

    const video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
    if (!video) {
        return res.json({ bvid, status: 'not_processed', segments: [] });
    }

    const segments = db.prepare(`
        SELECT start_time, end_time, type, content, action 
        FROM segments WHERE video_id = ?
    `).all(video.id);

    res.json({ bvid, status: 'success', segments });
});

// 2. [授权] 用户提交标注 (增加积分)
app.post('/api/v1/segments/submit', authenticateToken, (req, res) => {
    const { bvid, start_time, end_time, type, content, action } = req.body;
    
    // 自动维护视频表
    let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
    if (!video) {
        const r = db.prepare("INSERT INTO videos (bvid) VALUES (?)").run(bvid);
        video = { id: r.lastInsertRowid };
    }

    // 插入片段
    db.prepare(`
        INSERT INTO segments (video_id, start_time, end_time, type, content, action)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(video.id, start_time, end_time, type, content, action);

    // 增加积分
    db.prepare("UPDATE users SET points = points + 10 WHERE id = ?").run(req.user.userId);

    res.json({ message: '标注成功', points_added: 10 });
});

// 3. [内部] AI 分析结果回传 (给大模型调用组使用)
app.post('/api/v1/internal/ai-upload', (req, res) => {
    const { bvid, results } = req.body; 
    // results: [{start, end, type, action, content}]
    
    let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
    if (!video) {
        const r = db.prepare("INSERT INTO videos (bvid, processed_status) VALUES (?, 2)").run(bvid);
        video = { id: r.lastInsertRowid };
    }

    const insert = db.prepare(`
        INSERT INTO segments (video_id, start_time, end_time, type, action, content)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((data) => {
        for (const item of data) {
            insert.run(video.id, item.start, item.end, item.type, item.action, item.content);
        }
    });

    transaction(results);
    res.json({ status: 'AI数据同步完成' });
});

// 4. [Auth] 登录
app.post('/api/v1/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: '认证失败' });
    }

    const token = jwt.sign({ userId: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username, points: user.points, tier: user.tier });
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


