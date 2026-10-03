const { randomUUID } = require('crypto');
const db = require('../database/db');
const { ApiError } = require('../middlewares/errors');
function publicTask(row) {
  if (!row) return null;
  return { taskId: row.id, bvid: row.bvid, status: row.status, stage: row.stage,
    percent: row.percent, message: row.message, errorCode: row.error_code,
    startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
    durationMs: row.duration_ms, detail: null };
}
function latest(userId, bvid) {
  return db.prepare('SELECT * FROM analysis_tasks WHERE user_id=? AND bvid=? ORDER BY rowid DESC LIMIT 1').get(userId, bvid);
}
function byId(userId, id) { return db.prepare('SELECT * FROM analysis_tasks WHERE user_id=? AND id=?').get(userId, id); }
const claim = db.transaction((userId, bvid) => {
  const active = db.prepare("SELECT * FROM analysis_tasks WHERE bvid=? AND status='running'").get(bvid);
  if (active) {
    if (active.user_id !== userId) throw new ApiError(409, 'VIDEO_BUSY', '该视频正在处理，请稍后重试');
    return { task: active, reused: true };
  }
  const indexing = db.prepare(`SELECT id FROM analysis_tasks WHERE bvid=? AND json_extract(vector_json,'$.status') IN ('pending','extracting','embedding','committing','running') LIMIT 1`).get(bvid);
  if (indexing) throw new ApiError(409, 'INDEX_BUSY', '该视频的检索索引仍在构建，请稍后重试');
  const now = new Date().toISOString(), id = randomUUID();
  db.prepare(`INSERT INTO analysis_tasks(id,user_id,bvid,status,stage,percent,message,started_at,updated_at,stage_started_ms)
    VALUES(?,?,?,'running','prepare',1,'准备分析视频',?,?,?)`).run(id,userId,bvid,now,now,Date.now());
  return { task: byId(userId, id), reused: false };
});
const update = db.transaction((id, patch) => {
  const row = db.prepare('SELECT * FROM analysis_tasks WHERE id=?').get(id);
  if (!row || row.status !== 'running') return publicTask(row);
  const now = Date.now(), iso = new Date(now).toISOString();
  const status = patch.status || row.status, stage = patch.stage || row.stage;
  const terminal = status !== 'running';
  if (stage !== row.stage || terminal) db.prepare('INSERT INTO analysis_stages(task_id,stage,duration_ms) VALUES(?,?,?)').run(id,row.stage,Math.max(0,now-row.stage_started_ms));
  db.prepare(`UPDATE analysis_tasks SET status=?,stage=?,percent=?,message=?,error_code=?,updated_at=?,finished_at=?,duration_ms=?,stage_started_ms=?,result_json=COALESCE(?,result_json) WHERE id=?`)
    .run(status,stage,Math.max(row.percent,Math.min(100,Math.round(Number(patch.percent) || 0))),patch.message || row.message,
      patch.errorCode || null,iso,terminal ? iso : null,terminal ? now-Date.parse(row.started_at) : null,
      stage !== row.stage ? now : row.stage_started_ms,patch.result ? JSON.stringify(patch.result) : null,id);
  return publicTask(db.prepare('SELECT * FROM analysis_tasks WHERE id=?').get(id));
});
function recoverInterrupted() {
  db.transaction(() => {
    for (const row of db.prepare("SELECT id FROM analysis_tasks WHERE status='running'").all())
      update(row.id,{ status:'failed',stage:'interrupted',errorCode:'SERVER_RESTARTED',message:'服务重启导致任务中断，请重试' });
    db.prepare(`UPDATE analysis_tasks SET vector_json=? WHERE json_extract(vector_json,'$.status') IN ('pending','extracting','embedding','committing','running')`)
      .run(JSON.stringify({status:'failed',percent:0,message:'服务重启导致索引任务中断，请重试'}));
  })();
}
module.exports = { publicTask, latest, byId, claim, update, recoverInterrupted };
