const lancedb = require('@lancedb/lancedb');
const path = require('path');
const crypto = require('crypto');
const { errorFactories } = require('./searchErrors');

const DEFAULT_DB_PATH = process.env.LANCEDB_PATH || path.join(__dirname, '../database/lancedb_data');
const FRAME_TABLE_NAME = 'visionmark_frames';
const SEGMENT_TABLE_NAME = 'visionmark_segments';
const escapeSql = value => String(value).replace(/'/g, "''");

function createVectorDb(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  let dbPromise = null;
  async function getDb() { if (!dbPromise) dbPromise = lancedb.connect(dbPath); return dbPromise; }
  async function getNamedTable(name) {
    const db = await getDb();
    return (await db.tableNames()).includes(name) ? db.openTable(name) : null;
  }
  const getTable = () => getNamedTable(FRAME_TABLE_NAME);
  const getSegmentTable = () => getNamedTable(SEGMENT_TABLE_NAME);

  async function upsertFramePoints(bvid, points) {
    if (!points || points.length === 0) return { indexed: 0 };
    const db = await getDb();
    const data = points.map(point => ({ id: crypto.randomUUID(), vector: point.vector, bvid, timestamp: point.timestamp }));
    let table = await getTable();
    if (table) { await table.delete(`bvid = '${escapeSql(bvid)}'`); await table.add(data); }
    else table = await db.createTable(FRAME_TABLE_NAME, data);
    return { indexed: data.length };
  }

  async function searchSimilarFrames(bvid, queryVector, topK = 5) {
    const table = await getTable();
    if (!table) return [];
    let query = table.search(queryVector).distanceType('cosine').limit(topK);
    if (bvid) query = query.filter(`bvid = '${escapeSql(bvid)}'`);
    return (await query.toArray()).map(row => ({
      score: Math.max(0, 1 - Number(row._distance || 0)), bvid: row.bvid, timestamp: row.timestamp
    }));
  }

  async function getAllFrames(bvid) {
    const table = await getTable();
    if (!table) return [];
    const rows = await table.query().filter(`bvid = '${escapeSql(bvid)}'`).select(['bvid', 'timestamp']).toArray();
    return rows.map(row => ({ bvid: row.bvid, timestamp: row.timestamp })).sort((a, b) => a.timestamp - b.timestamp);
  }

  async function getStoredVectorDimension(table) {
    const rows = await table.query().select(['vector']).limit(1).toArray();
    return rows.length ? Array.from(rows[0].vector || []).length : null;
  }

  async function upsertSegments(records) {
    if (!Array.isArray(records) || records.length === 0) return { indexed: 0 };
    const uniqueRecords = [...new Map(records.map(record => [record.id, record])).values()];
    const dimensions = new Set(uniqueRecords.map(record => record.vector?.length));
    if (dimensions.size !== 1 || dimensions.has(0) || dimensions.has(undefined)) {
      throw new TypeError('所有 segment vector 必须存在且维度一致');
    }
    const db = await getDb();
    let table = await getSegmentTable();
    if (table) {
      const storedDimension = await getStoredVectorDimension(table);
      if (storedDimension !== null && storedDimension !== uniqueRecords[0].vector.length) {
        throw errorFactories.dimensionMismatch(storedDimension, uniqueRecords[0].vector.length);
      }
      await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(uniqueRecords);
    } else table = await db.createTable(SEGMENT_TABLE_NAME, uniqueRecords);
    return { indexed: uniqueRecords.length };
  }

  async function searchSegments(queryVector, options = {}) {
    const table = await getSegmentTable();
    if (!table) throw errorFactories.indexNotFound();
    const storedDimension = await getStoredVectorDimension(table);
    if (storedDimension !== null && storedDimension !== queryVector.length) {
      throw errorFactories.dimensionMismatch(storedDimension, queryVector.length);
    }
    const topK = Math.max(1, Math.min(20, Number(options.topK) || 5));
    let query = table.search(queryVector).distanceType('cosine').limit(topK);
    if (options.videoId) query = query.filter(`videoId = '${escapeSql(options.videoId)}'`);
    return query.toArray();
  }

  async function countSegments(videoId = null) {
    const table = await getSegmentTable();
    if (!table) return 0;
    return table.countRows(videoId ? `videoId = '${escapeSql(videoId)}'` : undefined);
  }

  return { dbPath, getDb, getTable, getSegmentTable, upsertFramePoints, searchSimilarFrames, getAllFrames,
    upsertSegments, searchSegments, countSegments, isReady: () => true };
}

const defaultDb = createVectorDb();
module.exports = { ...defaultDb, createVectorDb, FRAME_TABLE_NAME, SEGMENT_TABLE_NAME };
