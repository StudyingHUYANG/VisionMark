const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config.js');

// 数据库连接（和server.js一致）
const db = new Database(path.join(__dirname, '../database', 'app.db'));
db.pragma('journal_mode = WAL');

// JWT密钥（和server.js一致）
const JWT_SECRET = config.JWT_SECRET;

// 添加日志去重缓存
let lastAuthLogToken = '';
let lastAuthLogTime = 0;
const AUTH_LOG_DEBOUNCE_MS = 5000; // 5秒内相同token只记录一次

// 1. 登录验证中间件（原server.js里的authenticateToken）
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('[Auth] 拒绝请求: 缺少token');
    return res.status(401).json({ error: '未登录，请先在插件中登录' });
  }

  // 日志去重：相同token在5秒内只记录一次
  const now = Date.now();
  if (token !== lastAuthLogToken || now - lastAuthLogTime > AUTH_LOG_DEBOUNCE_MS) {
    console.log('[Auth] 收到token:', token.substring(0, 20) + '...');
    lastAuthLogToken = token;
    lastAuthLogTime = now;
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('[Auth] Token验证失败:', err.name, err.message);
      if (err.name === 'TokenExpiredError') {
        return res.status(403).json({ error: '登录已过期，请重新登录' });
      }
      return res.status(403).json({ error: 'Token无效，请重新登录' });
    }
    
    // 验证成功日志也做去重
    if (token !== lastAuthLogToken || now - lastAuthLogTime > AUTH_LOG_DEBOUNCE_MS) {
      console.log('[Auth] Token验证成功, 用户:', user.username);
      lastAuthLogToken = token;
      lastAuthLogTime = now;
    }
    
    req.user = user;
    next();
  });
}

// 2. 标注创建者权限验证中间件
const checkContributor = (req, res, next) => {
  const segmentId = req.params.id;
  const userId = req.user?.userId; // 从token解析的用户ID

  if (!userId) {
    return res.status(401).json({ code: 401, msg: '未登录，请先登录' });
  }

  try {
    // 查询标注的创建者
    const segment = db.prepare(`
      SELECT contributor_id FROM ad_segments WHERE id = ?
    `).get(segmentId);

    if (!segment) {
      return res.status(404).json({ code: 404, msg: '标注不存在' });
    }

    if (segment.contributor_id !== userId) {
      return res.status(403).json({ code: 403, msg: '无权限删除该标注' });
    }

    next(); // 权限通过，执行删除逻辑
  } catch (err) {
    res.status(500).json({ code: 500, msg: '权限验证失败', error: err.message });
  }
};

// 导出两个中间件
module.exports = { authenticateToken, checkContributor };