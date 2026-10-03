const { AsyncLocalStorage } = require('async_hooks');
const db = require('../database/db');
const context = new AsyncLocalStorage();
function classifyError(error) {
  if (require('./downloadErrors').messages[error?.code]) return error.code;
  if (['AbortError', 'APIConnectionTimeoutError'].includes(error?.name) || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return 'UPSTREAM_TIMEOUT';
  const status = Number(error?.status || error?.response?.status);
  // yt-dlp is a child process: HTTP failures reach us as wrapped text.
  if (/HTTP(?: Error)?[ :]+412\b|Precondition Failed/i.test(String(error?.message || ''))) return 'VIDEO_ACCESS_RESTRICTED';
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED';
  if (status === 429) return 'UPSTREAM_RATE_LIMITED';
  if (status === 412) return 'VIDEO_ACCESS_RESTRICTED';
  if (error?.name === 'APIConnectionError' || ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return 'UPSTREAM_UNAVAILABLE';
  return 'ANALYSIS_FAILED';
}
async function modelCall(model, operation, invoke) {
  const scope = context.getStore();
  const start = Date.now();
  let status = 'success', code = null;
  try { return await invoke(); }
  catch (error) { status = 'failed'; code = classifyError(error); throw error; }
  finally {
    if (scope?.userId) {
      try {
        db.prepare('INSERT INTO model_calls(user_id,task_id,model,operation,status,duration_ms,error_code) VALUES(?,?,?,?,?,?,?)')
          .run(scope.userId, scope.taskId || null, String(model).slice(0, 200), operation, status, Date.now() - start, code);
      } catch { console.error('[Telemetry] MODEL_METRIC_WRITE_FAILED'); }
    }
  }
}
function instrumentClient(client) {
  const original = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (params, ...args) => modelCall(params.model, 'chat.completions', () => original(params, ...args));
  return client;
}
function requests(req, res, next) {
  const start = performance.now();
  res.on('finish', () => {
    if (!req.user?.userId) return;
    // Route templates only: no query strings, IDs, prompts or tokens.
    const route = req.baseUrl + (req.route?.path || '/unknown');
    const bucket = new Date().toISOString().slice(0, 13);
    const elapsed = performance.now() - start;
    try {
      db.prepare(`INSERT INTO request_metrics VALUES(?,?,?,?,?,1,?,?)
        ON CONFLICT(user_id,route,method,status,bucket) DO UPDATE SET
        count=count+1,total_ms=total_ms+excluded.total_ms,max_ms=MAX(max_ms,excluded.max_ms)`)
        .run(req.user.userId, route, req.method, res.statusCode, bucket, elapsed, elapsed);
    } catch { console.error('[Telemetry] REQUEST_METRIC_WRITE_FAILED'); }
  });
  next();
}
module.exports = { context, modelCall, instrumentClient, requests, classifyError };
