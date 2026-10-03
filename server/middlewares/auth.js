const jwt = require('jsonwebtoken');
const db = require('../database/db');
const config = require('../config');
const { ApiError } = require('./errors');
const { integer } = require('./validation');
function verifyToken(token) {
  const user = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  if (!Number.isSafeInteger(user.userId) || !db.prepare('SELECT id FROM users WHERE id = ?').get(user.userId)) throw new Error('Invalid user');
  return user;
}
function authenticateToken(req, res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) return next(new ApiError(401, 'AUTH_REQUIRED', '未登录，请先登录'));
  try { req.user = verifyToken(match[1]); }
  catch (error) { return next(new ApiError(401, error.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', '登录无效或已过期，请重新登录')); }
  next();
}
function checkContributor(req, res, next) {
  const id = integer(req.params.id, 'id', undefined, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT submitter_id FROM annotations WHERE id = ?').get(id);
  if (!row) return next(new ApiError(404, 'ANNOTATION_NOT_FOUND', '标注不存在'));
  if (row.submitter_id !== req.user.userId) return next(new ApiError(403, 'FORBIDDEN', '只能删除自己的标注'));
  next();
}
module.exports = { authenticateToken, checkContributor, verifyToken };
