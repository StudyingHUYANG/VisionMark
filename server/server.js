// 加载环境变量
require('dotenv').config();

const { authenticateToken } = require('./middlewares/auth.js');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config.js');
const modelConfigRouter = require('./routes/modelConfig.js');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const JWT_SECRET = config.JWT_SECRET;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use('/api/v1/model-config', modelConfigRouter);

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected');

  // 心跳检测
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    console.log('[WS] Received:', message.toString());
    // 这里可以添加消息处理逻辑，例如广播给其他客户端或处理特定业务
    // ws.send(JSON.stringify({ type: 'echo', data: message }));
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

// 定期发送 ping 以检测死连接
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

const db = require('./database/db');

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

  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,              -- AI / HUMAN
    submitter_id INTEGER,                   -- HUMAN时是用户id，AI时可为空
    submitter_name TEXT,                    -- HUMAN时是用户名，AI时写'AI'
    parent_id INTEGER,                      -- 暂时可为空，后续做版本链再用
    annotation_type TEXT DEFAULT 'ad',      -- ad / full_analysis
    title TEXT,
    summary TEXT,
    transcript TEXT,
    score REAL,
    content_json TEXT NOT NULL,             -- 统一存完整JSON
    model_name TEXT,                        -- AI模型名
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_api_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'qwen',
    api_key TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    extra_config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider)
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

app.get('/api/v1/segments', (req, res) => {
  const { bvid } = req.query;

  console.log('[NEW] segments now from annotations', bvid);

  if (!bvid) return res.json({ segments: [] });

  const video = db.prepare(`
    SELECT * FROM videos WHERE bvid = ?
  `).get(bvid);

  if (!video) return res.json({ segments: [] });

  const allAnnotations = db.prepare(`
    SELECT *
    FROM annotations
    WHERE video_id = ?
    ORDER BY id DESC
  `).all(video.id);

  let ai_title = '';
  let ai_summary = '';
  let knowledge_points = [];
  let hot_words = [];

  const aiAnnotation = allAnnotations.find(row => row.source_type === 'AI' && row.annotation_type === 'full_analysis');
  if (aiAnnotation) {
    const content = safeParseContent(aiAnnotation.content_json);
    if (content.meta) {
      ai_title = content.meta.title || aiAnnotation.title || '';
    }
    if (content.content_analysis) {
      ai_summary = content.content_analysis.summary || aiAnnotation.summary || '';
      knowledge_points = content.content_analysis.knowledge_points || [];
      hot_words = content.content_analysis.hot_words || [];
    }
  }

  // 只保留最新的一条完整AI分析，或者人工标注
  const validAnnotations = allAnnotations.filter(row => {
    if (row.source_type === 'AI' && row.annotation_type === 'full_analysis') {
      return aiAnnotation && row.id === aiAnnotation.id;
    }
    return true; // 保留所有 HUMAN/手工标注
  });

  // 🔥 从 validAnnotations 提取所有广告段，避免同个视频的多次AI分析产生大重负片段
  const segments = validAnnotations
    .flatMap(row => {
      const content = safeParseContent(row.content_json);
      return extractLegacyAdSegments(content).map((seg) => {
        const shouldPopup = inferPopupAction(seg);
        const segmentContent = resolveSegmentContent(seg, row);
        return {
          ...seg,
          action: shouldPopup ? 'popup' : 'skip',
          is_ai_segment: row.source_type === 'AI',
          content: segmentContent,
          description: segmentContent
        };
      });
    })
    .sort((a, b) => a.start_time - b.start_time);

    res.json({ segments, ai_title, ai_summary, knowledge_points, hot_words });
  });

app.post('/api/v1/segments', authenticateToken, (req, res) => {
  const { bvid, cid, start_time, end_time, ad_type } = req.body;
  const userId = req.user.userId;
  
  let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
  if (!video) {
    const r = db.prepare("INSERT INTO videos (bvid, cid) VALUES (?, ?)").run(bvid, cid || null);
    video = { id: r.lastInsertRowid };
  }
  
  const username = req.user.username || 'Unknown';

  const result = db.prepare(`
    INSERT INTO annotations (
      video_id,
      source_type,
      submitter_id,
      submitter_name,
      parent_id,
      annotation_type,
      title,
      summary,
      transcript,
      score,
      content_json,
      model_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    video.id,
    'HUMAN',
    userId,
    username,
    null,
    'ad',
    null,
    null,
    null,
    null,
    JSON.stringify({
      meta: {
        bvid,
        title: null
      },
      content_analysis: {
        summary: null,
        transcript: null,
        knowledge_points: [],
        hot_words: [],
        tags: [],
        ad_segments: [
          {
            start_time,
            end_time,
            ad_type
          }
        ]
      }
    }),
    null
  );

  // Award points
  db.prepare("UPDATE user_points SET total_points = total_points + 10 WHERE user_id = ?").run(userId);

  res.json({ id: result.lastInsertRowid, message: '提交成功' });
});

app.get('/api/v1/health', (req, res) => res.json({ ok: true }));


function safeParseContent(contentJson) {
  try {
    return contentJson ? JSON.parse(contentJson) : null;
  } catch (error) {
    return null;
  }
}

function extractLegacyAdSegments(content) {
  if (!content) return [];

  // 新结构：content_analysis.ad_segments
  if (
    content.content_analysis &&
    Array.isArray(content.content_analysis.ad_segments)
  ) {
    return content.content_analysis.ad_segments;
  }

  // 兼容旧结构：ad_marks
  if (Array.isArray(content.ad_marks)) {
    return content.ad_marks;
  }

  // 更旧结构：ad_segments 直接挂在根上
  if (Array.isArray(content.ad_segments)) {
    return content.ad_segments;
  }

  // 更旧结构：segments
  if (Array.isArray(content.segments)) {
    return content.segments;
  }

  return [];
}

function inferPopupAction(segment) {
  if (!segment || typeof segment !== 'object') return false;

  if (typeof segment.action === 'string') {
    const action = segment.action.trim().toLowerCase();
    if (action === 'popup') return true;
    if (action === 'skip') return false;
  }

  const highlightValue = typeof segment.highlight === 'string'
    ? segment.highlight.trim().toLowerCase()
    : segment.highlight;

  if (
    highlightValue === true ||
    highlightValue === 1 ||
    highlightValue === '1' ||
    highlightValue === 'true' ||
    highlightValue === 'yes' ||
    highlightValue === 'y' ||
    highlightValue === 'popup' ||
    highlightValue === 'high-energy' ||
    highlightValue === 'high_energy'
  ) {
    return true;
  }

  return false;
}

function pickText(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }

    if (value && typeof value === 'object') {
      const nestedText = pickText(
        value.text,
        value.content,
        value.description,
        value.desc,
        value.explanation,
        value.reason,
        value.note,
        value.summary,
        value.title
      );
      if (nestedText) return nestedText;
    }
  }

  return null;
}

function resolveSegmentContent(segment, annotationRow) {
  return pickText(
    segment?.content,
    segment?.description,
    segment?.desc,
    segment?.explanation,
    segment?.reason,
    segment?.note,
    segment?.text
  );
}

// 引入路由文件
const statsRouter = require('./routes/stats.js');
const segmentsRouter = require('./routes/segments.js');
const createVideoAnalysisRouter = require('./routes/videoAnalysis.js');
const videoAnalysisRouter = createVideoAnalysisRouter(wss);
const searchRouter = require('./routes/search.js');

// 注册路由
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1/search', searchRouter);
// app.use('/api/v1/segments', segmentsRouter); // 已在上面定义了 segments 相关 API，这里注释掉路由注册
app.use('/video-analysis', videoAnalysisRouter); // AI视频分析路由

// Get user's all segments
app.get('/api/v1/segments/user', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const annotations = db.prepare(`
    SELECT * FROM annotations WHERE submitter_id = ? ORDER BY id DESC
  `).all(userId);

  const segments = annotations.flatMap(row => {
    const content = safeParseContent(row.content_json);
    return extractLegacyAdSegments(content).map(seg => ({
      start_time: seg.start_time || 0,
      end_time: seg.end_time || 0,
      description: seg.description || null,
      highlight: !!seg.highlight,
      ad_type: seg.ad_type || 'soft_ad'
    }));
  }).sort((a,b) => a.start_time - b.start_time);

  res.json({ segments });
});


// 兼容旧前端的视频视图接口
app.get('/api/v1/video-view', authenticateToken, (req, res) => {
  try {
    const { bvid } = req.query;
    console.log('[COMPAT] GET /api/v1/video-view', bvid);

    if (!bvid) {
      return res.status(400).json({ error: '缺少bvid参数' });
    }

    const video = db.prepare(`
      SELECT * FROM videos WHERE bvid = ?
    `).get(bvid);

    if (!video) {
      return res.json({
        success: true,
        data: {
          bvid,
          title: null,
          tags: [],
          summary: null,
          transcript: null,
          ad_segments: [],
          knowledge_points: [],
          hot_words: [],
          analyzed_at: null
        }
      });
    }

    const allAnnotations = db.prepare(`
      SELECT *
      FROM annotations
      WHERE video_id = ?
      ORDER BY id DESC
    `).all(video.id);

    const latestAI = allAnnotations.find(row => row.source_type === 'AI') || null;

    const aiContent = latestAI ? safeParseContent(latestAI.content_json) : null;
    const aiAnalysis = aiContent?.content_analysis || {};

    const validAnnotations = allAnnotations.filter(row => {
      if (row.source_type === 'AI' && row.annotation_type === 'full_analysis') {
        return latestAI && row.id === latestAI.id;
      }
      return true;
    });

    // 收集所有广告段，按时间顺序返回
    const allAdSegments = validAnnotations
      .flatMap(row => {
        const content = safeParseContent(row.content_json);
        const segments = extractLegacyAdSegments(content);

        return segments.map(seg => ({
          start_time: typeof seg.start_time === 'number' ? seg.start_time : 0,
          end_time: typeof seg.end_time === 'number' ? seg.end_time : 0,
          description: resolveSegmentContent(seg, row),
          highlight: !!seg.highlight,
          ad_type: seg.ad_type || 'soft_ad',
          is_ai_segment: row.source_type === 'AI'
        }));
      })
      .sort((a, b) => a.start_time - b.start_time);

    const viewData = {
      bvid,
      title: aiContent?.meta?.title || latestAI?.title || null,
      tags: aiAnalysis.tags || [],
      summary: aiAnalysis.summary || latestAI?.summary || null,
      transcript: aiAnalysis.transcript || latestAI?.transcript || null,
      ad_segments: allAdSegments,
      knowledge_points: aiAnalysis.knowledge_points || [],
      hot_words: aiAnalysis.hot_words || [],
      analyzed_at: aiAnalysis.analyzed_at || null
    };

    res.json({
      success: true,
      data: viewData
    });
  } catch (error) {
    console.error('[API] video-view 查询失败:', error);
    res.status(500).json({
      error: 'video-view 查询失败',
      message: error.message
    });
  }
});

// 使用配置文件的端口
server.listen(config.PORT, '0.0.0.0', () => {
  console.log('[Server] http://localhost:' + config.PORT);
  console.log('[WS] WebSocket server is running');
  console.log('[Auth] admin/admin 登录');
});