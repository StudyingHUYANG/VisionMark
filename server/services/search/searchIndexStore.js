const db = require('../../database/db');

const ACTIVE_STATUSES = new Set(['pending', 'extracting', 'embedding', 'committing']);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_indexes (
    bvid TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    active_run_id TEXT,
    pending_run_id TEXT,
    index_version INTEGER NOT NULL DEFAULT 2,
    visual_model TEXT,
    text_model TEXT,
    rerank_model TEXT,
    dimension INTEGER,
    window_count INTEGER NOT NULL DEFAULT 0,
    visual_count INTEGER NOT NULL DEFAULT 0,
    transcript_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.prepare(`
  UPDATE search_indexes
  SET status = 'failed',
      error = '服务重启导致索引任务中断，请重新分析视频',
      pending_run_id = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE status IN ('pending', 'extracting', 'embedding', 'committing')
`).run();

function publicStatus(row) {
  if (!row) {
    return {
      status: 'not_found',
      version: 2,
      ready: false,
      counts: { windows: 0, visual: 0, transcript: 0 },
      error: null,
      updatedAt: null
    };
  }
  return {
    status: row.status,
    version: row.index_version,
    ready: row.status === 'ready' && Boolean(row.active_run_id),
    counts: {
      windows: row.window_count || 0,
      visual: row.visual_count || 0,
      transcript: row.transcript_count || 0
    },
    models: {
      visual: row.visual_model || null,
      text: row.text_model || null,
      rerank: row.rerank_model || null,
      dimension: row.dimension || null
    },
    error: row.error || null,
    updatedAt: row.updated_at || null
  };
}

function getIndexRow(bvid) {
  return db.prepare('SELECT * FROM search_indexes WHERE bvid = ?').get(bvid) || null;
}

function getStatus(bvid) {
  return publicStatus(getIndexRow(bvid));
}

function setStatus(bvid, status, update = {}) {
  const previous = getIndexRow(bvid);
  const values = {
    activeRunId: update.activeRunId !== undefined ? update.activeRunId : previous?.active_run_id || null,
    pendingRunId: update.pendingRunId !== undefined ? update.pendingRunId : previous?.pending_run_id || null,
    visualModel: update.visualModel !== undefined ? update.visualModel : previous?.visual_model || null,
    textModel: update.textModel !== undefined ? update.textModel : previous?.text_model || null,
    rerankModel: update.rerankModel !== undefined ? update.rerankModel : previous?.rerank_model || null,
    dimension: update.dimension !== undefined ? update.dimension : previous?.dimension || null,
    windowCount: update.windowCount !== undefined ? update.windowCount : previous?.window_count || 0,
    visualCount: update.visualCount !== undefined ? update.visualCount : previous?.visual_count || 0,
    transcriptCount: update.transcriptCount !== undefined ? update.transcriptCount : previous?.transcript_count || 0,
    error: update.error !== undefined ? update.error : null
  };

  db.prepare(`
    INSERT INTO search_indexes (
      bvid, status, active_run_id, pending_run_id, index_version,
      visual_model, text_model, rerank_model, dimension,
      window_count, visual_count, transcript_count, error, updated_at
    ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(bvid) DO UPDATE SET
      status = excluded.status,
      active_run_id = excluded.active_run_id,
      pending_run_id = excluded.pending_run_id,
      index_version = excluded.index_version,
      visual_model = excluded.visual_model,
      text_model = excluded.text_model,
      rerank_model = excluded.rerank_model,
      dimension = excluded.dimension,
      window_count = excluded.window_count,
      visual_count = excluded.visual_count,
      transcript_count = excluded.transcript_count,
      error = excluded.error,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    bvid,
    status,
    values.activeRunId,
    values.pendingRunId,
    values.visualModel,
    values.textModel,
    values.rerankModel,
    values.dimension,
    values.windowCount,
    values.visualCount,
    values.transcriptCount,
    values.error
  );

  return getStatus(bvid);
}

const activateTransaction = db.transaction((bvid, runId, counts, models) => {
  const row = getIndexRow(bvid);
  if (!row || row.pending_run_id !== runId) {
    throw new Error('索引提交任务已过期，拒绝切换 activeRunId');
  }
  setStatus(bvid, 'ready', {
    activeRunId: runId,
    pendingRunId: null,
    windowCount: counts.windows,
    visualCount: counts.visual,
    transcriptCount: counts.transcript,
    visualModel: models.visual,
    textModel: models.text,
    rerankModel: models.rerank,
    dimension: models.dimension,
    error: null
  });
});

function activateRun(bvid, runId, counts, models) {
  activateTransaction(bvid, runId, counts, models);
  return getStatus(bvid);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

module.exports = {
  activateRun,
  getIndexRow,
  getStatus,
  isActiveStatus,
  setStatus
};
