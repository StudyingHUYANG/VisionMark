const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const JWT_SECRET = 'secret-key-v1';

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

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('[Auth] 拒绝请求: 缺少token');
    return res.status(401).json({ error: '未登录，请先在插件中登录' });
  }

  console.log('[Auth] 收到token:', token.substring(0, 20) + '...');

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('[Auth] Token验证失败:', err.name, err.message);
      if (err.name === 'TokenExpiredError') {
        return res.status(403).json({ error: '登录已过期，请重新登录' });
      }
      return res.status(403).json({ error: 'Token无效，请重新登录' });
    }
    console.log('[Auth] Token验证成功, 用户:', user.username);
    req.user = user;
    next();
  });
}

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

app.listen(3000, '0.0.0.0', () => {
  console.log('[Server] http://localhost:3000');
  console.log('[Auth] admin/admin 登录');
});