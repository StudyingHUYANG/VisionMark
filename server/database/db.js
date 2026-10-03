const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('../config');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
function migrate(database = db) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const migrations = [
`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze'
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    cid INTEGER,
    page INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,              -- AI / HUMAN
    submitter_id INTEGER,                   -- HUMAN时是用户id，AI时可为空
    submitter_name TEXT,                    -- HUMAN时是用户名，AI时写'AI'
    parent_id INTEGER,                      -- 暂时可为空，后续做版本链再用
    annotation_type TEXT DEFAULT 'ad',      -- ad / full_analysis
    title TEXT,
    summary TEXT,
    transcript TEXT,
    score REAL,
    content_json TEXT NOT NULL,             -- 统一存完整JSON
    model_name TEXT,                        -- AI模型名
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_api_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'qwen',
    api_key TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    extra_config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider)
  );

`,
  `CREATE TABLE analysis_tasks (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, bvid TEXT NOT NULL,
    status TEXT NOT NULL, stage TEXT NOT NULL, percent INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL, error_code TEXT, started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, finished_at TEXT, stage_started_ms INTEGER NOT NULL,
    duration_ms INTEGER, result_json TEXT, vector_json TEXT
  );
  CREATE UNIQUE INDEX one_running_analysis_per_video ON analysis_tasks(bvid) WHERE status = 'running';
  CREATE INDEX tasks_by_user_video ON analysis_tasks(user_id, bvid, started_at DESC);
  CREATE TABLE analysis_stages (
    id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT NOT NULL, duration_ms INTEGER NOT NULL
  );
  CREATE TABLE model_calls (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task_id TEXT,
    model TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX model_calls_by_user ON model_calls(user_id, created_at);
  CREATE TABLE request_metrics (
    user_id INTEGER NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL,
    bucket TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
    PRIMARY KEY(user_id, route, method, status, bucket)
  );
  CREATE INDEX annotations_by_video ON annotations(video_id, id DESC);`
  ];
  const current = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
  if (current > migrations.length) throw new Error('DATABASE_SCHEMA_NEWER_THAN_SERVER');
  migrations.forEach((sql, index) => {
    if (index + 1 <= current) return;
    database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(index + 1);
    })();
  });
}
migrate();
module.exports = db;
module.exports.migrate = migrate;
