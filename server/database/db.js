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
// 初始化表（统一字段与业务逻辑）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    points INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze'
  );
  
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT UNIQUE NOT NULL,
    cid INTEGER,
    page INTEGER DEFAULT 1,
    processed_status INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL,
    end_time REAL,
    type TEXT,          -- 统一 ad_type 为 type
    content TEXT,       -- 标注内容
    action TEXT,        -- 跳过/标记等行为
    contributor_id INTEGER,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log('✅ 数据库架构 V2.0 已就绪');

module.exports = db;