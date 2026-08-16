const lancedb = require('@lancedb/lancedb');
const path = require('path');

const dbPath = path.join(__dirname, '../database/lancedb_data');
const VISUAL_TABLE = 'visionmark_visual_windows_v2';
const TEXT_TABLE = 'visionmark_text_windows_v2';

let dbPromise = null;

function assertBvid(bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) {
    throw new Error('非法 BVID');
  }
  return bvid;
}

function assertRunId(runId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ''))) {
    throw new Error('非法索引 runId');
  }
  return runId;
}

async function getDb() {
  if (!dbPromise) dbPromise = lancedb.connect(dbPath);
  return dbPromise;
}

async function getTable(name) {
  const db = await getDb();
  const names = await db.tableNames();
  return names.includes(name) ? db.openTable(name) : null;
}

async function appendRows(tableName, rows) {
  if (!rows.length) return;
  const db = await getDb();
  const table = await getTable(tableName);
  if (table) await table.add(rows);
  else await db.createTable(tableName, rows);
}

async function appendRun(visualRows, textRows) {
  await appendRows(VISUAL_TABLE, visualRows);
  await appendRows(TEXT_TABLE, textRows);
}

async function searchTable(tableName, bvid, runId, vector, limit) {
  assertBvid(bvid);
  assertRunId(runId);
  const table = await getTable(tableName);
  if (!table) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  return table
    .search(vector)
    .distanceType('cosine')
    .filter(`bvid = '${bvid}' AND runId = '${runId}'`)
    .limit(safeLimit)
    .toArray();
}

function withScore(row) {
  const distance = Number(row._distance ?? 1);
  const { vector, _distance, ...metadata } = row;
  return { ...metadata, score: Math.max(-1, Math.min(1, 1 - distance)) };
}

async function searchVisual(bvid, runId, vector, limit = 90) {
  return (await searchTable(VISUAL_TABLE, bvid, runId, vector, limit)).map(withScore);
}

async function searchText(bvid, runId, vector, limit = 30) {
  const table = await getTable(TEXT_TABLE);
  if (!table) return [];
  return (await searchTable(TEXT_TABLE, bvid, runId, vector, limit)).map(withScore);
}

async function deleteRunsExcept(tableName, bvid, activeRunId) {
  assertBvid(bvid);
  assertRunId(activeRunId);
  const table = await getTable(tableName);
  if (!table) return;
  await table.delete(`bvid = '${bvid}' AND runId != '${activeRunId}'`);
}

async function cleanupOldRuns(bvid, activeRunId) {
  await Promise.all([
    deleteRunsExcept(VISUAL_TABLE, bvid, activeRunId),
    deleteRunsExcept(TEXT_TABLE, bvid, activeRunId)
  ]);
}

async function getIndexedWindows(bvid, runId) {
  assertBvid(bvid);
  assertRunId(runId);
  const table = await getTable(VISUAL_TABLE);
  if (!table) return [];
  const rows = await table
    .query()
    .filter(`bvid = '${bvid}' AND runId = '${runId}'`)
    .select(['windowId', 'bvid', 'startTime', 'endTime', 'frameTime', 'thumbnailPath'])
    .toArray();
  const windows = new Map();
  for (const row of rows) {
    if (!windows.has(row.windowId)) windows.set(row.windowId, row);
  }
  return [...windows.values()].sort((a, b) => a.startTime - b.startTime);
}

async function getWindowMetadata(bvid, runId, windowId) {
  assertBvid(bvid);
  assertRunId(runId);
  if (!/^w_\d{4}_\d+$/.test(String(windowId || ''))) throw new Error('非法窗口 ID');
  for (const tableName of [VISUAL_TABLE, TEXT_TABLE]) {
    const table = await getTable(tableName);
    if (!table) continue;
    const rows = await table
      .query()
      .filter(`bvid = '${bvid}' AND runId = '${runId}' AND windowId = '${windowId}'`)
      .select(['windowId', 'bvid', 'startTime', 'endTime', 'thumbnailPath'])
      .limit(1)
      .toArray();
    if (rows.length) return rows[0];
  }
  return null;
}

// Legacy helpers intentionally read only the v2 active index through callers.
async function upsertFramePoints() {
  throw new Error('旧版帧索引已停用，请使用 appendRun');
}

async function searchSimilarFrames() {
  return [];
}

async function getAllFrames() {
  return [];
}

module.exports = {
  VISUAL_TABLE,
  TEXT_TABLE,
  appendRun,
  cleanupOldRuns,
  getAllFrames,
  getDb,
  getIndexedWindows,
  getWindowMetadata,
  isReady: () => true,
  searchSimilarFrames,
  searchText,
  searchVisual,
  upsertFramePoints
};
