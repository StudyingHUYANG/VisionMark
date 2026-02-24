const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database/db'); // 引用上方的配置

const app = express();
const JWT_SECRET = 'visionmark_shimakaze_2026'; // 请保持与生产环境一致

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// --- 中间件：验证权限 ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: '未授权' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token失效' });
        req.user = user;
        next();
    });
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

// --- 启动服务 ---
const PORT = 8080; // 配合 Nginx 转发到 8443
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 VisionMark Server 运行中
    ---------------------------------
    本地接口: http://localhost:${PORT}
    生产转发: https://apitest.visionmark.com.cn:8443
    数据库路径: ${db.name}
    ---------------------------------
    `);
});