const { randomUUID } = require('crypto');
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function errorBody(code, message, requestId) {
  return { success: false, code, error: message, message, requestId };
}
function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error instanceof ApiError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
  const code = error instanceof ApiError ? error.code : status === 400 ? 'INVALID_JSON' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
  console.error(JSON.stringify({ event: 'request_failed', requestId: req.requestId, code, status }));
  const body = errorBody(code, error instanceof ApiError ? error.message : status === 400 ? '请求 JSON 格式错误' : status === 413 ? '请求体过大' : '服务内部错误，请凭 requestId 排查', req.requestId);
  if (error instanceof ApiError && error.taskId) body.taskId = error.taskId;
  res.status(status).json(body);
}
const asyncRoute = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
module.exports = { ApiError, errorBody, requestContext, errorHandler, asyncRoute };
