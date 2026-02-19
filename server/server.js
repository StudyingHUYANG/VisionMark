const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
// 引入路由模块
const segmentsRouter = require('./routes/segments');

const app = express();
const JWT_SECRET = 'secret-key-v1';

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use('/api/v1/segments', segmentsRouter);

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

  -- 只有当表不存在时才创建，这样不会影响以后
  CREATE TABLE IF NOT EXISTS segment_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    vote_type TEXT NOT NULL, -- 存 'up' 或 'down'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, segment_id) -- 唯一约束：防止一人投多票
  );

  -- 顺便确保 user_points 表存在，不然加积分也会报错
  CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze'
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

// 其他API
// 【高级版】获取标注列表 API：加入 Wilson 置信度过滤与投票状态
app.get('/api/v1/segments', (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.json({ segments: [] });

  // 1. 尝试解析当前用户的 Token（如果不传 Token 也能查，只是 user_vote 为 null）
  let currentUserId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try {
      const token = authHeader.split(' ')[1];
      // 注意这里的 JWT_SECRET 要和上面的定义保持一致
      const decoded = jwt.verify(token, JWT_SECRET); 
      currentUserId = decoded.userId;
    } catch (e) {
      // 未登录或 Token 无效，忽略
    }
  }

  try {
    // 2. 查出该视频所有的标注，以及它们的赞踩总数
    const rows = db.prepare(`
      SELECT 
        s.*,
        (SELECT COUNT(*) FROM segment_votes WHERE segment_id = s.id AND vote_type = 'up') as upvotes,
        (SELECT COUNT(*) FROM segment_votes WHERE segment_id = s.id AND vote_type = 'down') as downvotes
      FROM ad_segments s 
      JOIN videos v ON s.video_id = v.id 
      WHERE v.bvid = ? 
        AND s.is_active = 1
    `).all(bvid);

    // 3. 定义 Wilson 置信区间下界算法 (95% 置信度 z = 1.96)
    const calculateWilsonScore = (up, down) => {
      const n = up + down;
      if (n === 0) return 0; // 没人投票时得分为 0
      
      const z = 1.96; 
      const p = up / n; // 赞同率
      
      const left = p + (1 / (2 * n)) * z * z;
      const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
      const under = 1 + (1 / n) * z * z;
      
      return (left - right) / under; // 返回下界得分 (0 ~ 1 之间)
    };

    const validSegments = [];

    // 4. 遍历计算、过滤、附加用户信息
    for (let seg of rows) {
      const up = seg.upvotes;
      const down = seg.downvotes;
      const total = up + down;
      const wilsonScore = calculateWilsonScore(up, down);

      // --- 过滤逻辑 ---
      // 需求：置信度 > 0.7。
      // 【防误杀机制】：如果一个新标注总票数为 0，置信度是 0。
      // 如果严格过滤 < 0.7，新标注将永远无法展示给用户去投票！
      // 因此逻辑为：有投票且分数不足 0.7 的，或者纯纯被踩的，过滤掉；新发或高分放行。
      // --- 过滤逻辑 ---
      if (total > 0) {
        if (total < 5) {
          // 【新手保护期】总票数少于 5 票时，只要反对票比赞同票多，才过滤
          if (down >= 1 && down >= up) {
            continue;
          }
        } else {
          // 【严格模式】总票数达到 5 票后，严格执行你的需求：Wilson 得分必须 > 0.7
          if (wilsonScore <= 0.7) {
            continue; 
          }
        }
      }

      // 查询当前用户的投票状态
      let myVote = null;
      if (currentUserId) {
        const voteRow = db.prepare('SELECT vote_type FROM segment_votes WHERE user_id = ? AND segment_id = ?').get(currentUserId, seg.id);
        if (voteRow) myVote = voteRow.vote_type;
      }

      // 5. 组装返回数据，包含投票统计和我的状态
      validSegments.push({
        ...seg,
        upvotes: up,
        downvotes: down,
        total_votes: total,
        wilson_score: parseFloat(wilsonScore.toFixed(4)), // 附加上得分，保留4位小数
        user_vote: myVote
      });
    }

    // 6. 按照 Wilson 分数从高到低排序返回
    validSegments.sort((a, b) => b.wilson_score - a.wilson_score);

    res.json({ segments: validSegments });

  } catch (err) {
    console.error('[Error] 查询失败:', err.message);
    res.json({ segments: [] });
  }
});

app.post('/api/v1/segments', (req, res) => {
  const { bvid, cid, start_time, end_time, ad_type } = req.body;
  
  let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
  if (!video) {
    const r = db.prepare("INSERT INTO videos (bvid, cid) VALUES (?, ?)").run(bvid, cid || null);
    video = { id: r.lastInsertRowid };
  }
  
  const result = db.prepare("INSERT INTO ad_segments (video_id, start_time, end_time, ad_type, is_active) VALUES (?, ?, ?, ?, 1)").run(video.id, start_time, end_time, ad_type);
  res.json({ id: result.lastInsertRowid, message: '提交成功' });
});

app.get('/api/v1/health', (req, res) => res.json({ ok: true }));

app.listen(3000, () => {
  console.log('[Server] http://localhost:3000');
  console.log('[Auth] admin/admin 登录');
});
