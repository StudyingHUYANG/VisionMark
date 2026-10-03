const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DB_PATH = process.env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(__dirname, process.env.DB_PATH || 'database/app.db');
const PORT = Number(process.env.PORT || 8080);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('CONFIG_PORT_INVALID');
function jwtSecret() {
  if (process.env.JWT_SECRET) {
    if (process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
    if (process.env.NODE_ENV === 'production') throw new Error('CONFIG_JWT_SECRET_TOO_SHORT (minimum 32 characters)');
    console.warn('[Config] JWT_SECRET 不足 32 字符，开发环境改用持久化本地随机密钥；请重新登录。');
  }
  if (process.env.NODE_ENV === 'production') throw new Error('CONFIG_JWT_SECRET_REQUIRED');
  if (DB_PATH === ':memory:') return crypto.randomBytes(48).toString('hex');
  const file = path.join(path.dirname(DB_PATH), '.jwt-secret');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error('CONFIG_JWT_SECRET_FILE_INVALID');
  return secret;
}
module.exports = { PORT, HOST: process.env.HOST || '127.0.0.1', DB_PATH, API_VERSION: 'api/v1', JWT_SECRET: jwtSecret(), CORS_ORIGIN: process.env.CORS_ORIGIN || '*' };
