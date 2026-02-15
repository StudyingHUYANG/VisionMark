const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const Database = require('better-sqlite3');

// 数据库连接（和server.js一致）
const db = new Database(path.join(__dirname, '../database', 'app.db'));
db.pragma('journal_mode = WAL');

// JWT密钥（和server.js一致）
const JWT_SECRET = 'secret-key-v1';

// 1. 登录验证中间件（原server.js里的authenticateToken）
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