const lancedb = require('@lancedb/lancedb');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '../database/lancedb_data');
const TABLE_NAME = 'visionmark_frames';

let dbPromise = null;

/**
 * 确保返回数据库连接
 */
async function getDb() {
  if (!dbPromise) {
    dbPromise = lancedb.connect(dbPath);
  }
  return dbPromise;
}

/**
 * 获取表对象，如果存在的话
 */
async function getTable() {
  const db = await getDb();
  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    return await db.openTable(TABLE_NAME);
  }
  return null;
}

/**
 * 将帧特征存入 LanceDB (本地文件存储)
 * @param {string} bvid 
 * @param {Array<{ timestamp: number, vector: number[] }>} points 
 */
async function upsertFramePoints(bvid, points) {
  if (!points || points.length === 0) return;
  
  const db = await getDb();
  const data = points.map((p) => ({
    id: crypto.randomUUID(),
    vector: p.vector,
    bvid: bvid,
    timestamp: p.timestamp
  }));

  let table = await getTable();
  if (table) {
    try {
      // 删除该视频在向量库中的旧数据（避免重复插入）
      await table.delete(`bvid = '${bvid}'`);
    } catch (err) {
      console.warn(`[VectorDB] 清除旧记录失败或无旧记录可清: ${err.message}`);
    }
    // 添加新数据
    await table.add(data);
  } else {
    // 创建新表并存入初始数据
    table = await db.createTable(TABLE_NAME, data);
  }
  
  console.log(`[VectorDB] 成功插入 ${points.length} 个视频帧向量到 ${bvid} (LanceDB)`);
}

/**
 * 根据文本向量搜索最匹配的帧
 * @param {string} bvid (可选，若不传则全库搜)
 * @param {number[]} queryVector 
 * @param {number} topK 
 */
async function searchSimilarFrames(bvid, queryVector, topK = 5) {
  const table = await getTable();
  if (!table) return [];

  // LanceDB 默认按 L2，可以通过 .metricType('cosine') 指定使用余弦相似度进行搜索
  let query = table.search(queryVector).metricType('cosine').limit(topK);
  
  if (bvid) {
    query = query.filter(`bvid = '${bvid}'`);
  }

  const results = await query.execute();

  return results.map(r => {
    // 转换为前端可读的相似度百分比
    const distance = r._distance !== undefined ? r._distance : 0;
    // 余弦距离的转化 (Cosine Distance) 的特点是 越小越相似，范围[0,2]
    // 分数计算: 1 - 距离 或者直接使用其余弦值 (由于LanceDB的Cosine distance = 1 - cosine_similarity)
    // 所以 similarity = 1 - _distance
    const score = Math.max(0, 1 - distance);
    return {
      score: score,
      bvid: r.bvid,
      timestamp: r.timestamp
    };
  });
}

/**
 * 获取指定视频的所有帧时间戳 (用于调试展示)
 */
async function getAllFrames(bvid) {
  const table = await getTable();
  if (!table) return [];

  // 获取表中的所有该 bvid 的记录
  // 不取 vector 字段以减少返回数据量
  const query = table.query().filter(`bvid = '${bvid}'`).select(['bvid', 'timestamp']);
  const results = await query.execute();
  return results.map(r => ({
    bvid: r.bvid,
    timestamp: r.timestamp
  })).sort((a,b) => a.timestamp - b.timestamp);
}

module.exports = {
  getDb,
  upsertFramePoints,
  searchSimilarFrames,
  getAllFrames,
  isReady: () => true // LanceDB 本地运行不依赖环境变量，始终Ready
};
