// VisionMark 服务器配置文件
// 修改此文件后重启服务器即可

module.exports = {
  // 服务器端口
  PORT: 3000,

  // API 版本
  API_VERSION: 'api/v1',

  // 数据库路径（相对于 server 目录）
  DB_PATH: './database/app.db',

  // JWT 密钥（生产环境请使用环境变量）
  JWT_SECRET: process.env.JWT_SECRET || 'secret-key-v1',

  // CORS 允许的源
  CORS_ORIGIN: '*'
};