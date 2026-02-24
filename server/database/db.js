const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 严格遵守规范：数据库文件存放在 server/database/app.db
const dbDir = path.join(__dirname);
const dbPath = path.join(dbDir, 'app.db');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL'); // 启用 WAL 模式提高并发性能

// --- 自动化建表逻辑 ---
db.exec(`
  -- 1. 视频主表
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT UNIQUE NOT NULL,
    title TEXT,
    processed_status INTEGER DEFAULT 0 -- 0:待处理, 1:分析中, 2:完成
  );

  -- 2. 增强片段表 (核心：存储跳过点、知识弹窗、梗百科)
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    type TEXT CHECK(type IN ('ad', 'knowledge', 'meme', 'boring')), 
    content TEXT,        -- 弹窗显示的文字
    action TEXT,         -- 'skip', 'popup', 'accelerate'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  -- 3. 用户与积分
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze'
  );
`);

console.log('✅ 数据库架构 V2.0 已就绪');

module.exports = db;