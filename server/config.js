// VisionMark 服务器配置文件
//
// 端口怎么改：本文件不再硬编码端口，PORT 从环境变量读取。因此要改端口必须改 .env 里的
// PORT（当前生效范围 1-65535），只改本文件是没用的——这就是"改了没生效"的根因。
// 注意：.env 由 dotenv 加载，且必须发生在 require 本文件之前（server.js 顶部先执行
// `require('dotenv').config()` 再 require 本文件）。若某个入口没有先加载 dotenv，
// 这里读到的 process.env.PORT 就会是空，从而回退到默认 8080。
//
// 谁在消费本文件：
//   - server/server.js      —— 用 PORT 监听端口（server.listen(config.PORT, '0.0.0.0')）
//   - server/middlewares/auth.js —— 用 JWT_SECRET 校验登录 token
//   - server/websocket.js   —— 用 JWT_SECRET 校验 WebSocket 连接的 token

'use strict';

// 默认端口：环境变量缺失或非法时使用
const DEFAULT_PORT = 8080;

// 内置默认 JWT 密钥：仅为方便本地开发，生产环境必须通过环境变量覆盖
const DEFAULT_JWT_SECRET = 'secret-key-v1';

/**
 * 解析端口：只接受 1-65535 的纯十进制整数，其余一律回退默认端口。
 * 非法值不静默吞掉——静默回退会让人误以为 .env 生效了，排查成本很高。
 */
function resolvePort(rawValue) {
  // 未设置 / 空字符串：视为"没配"，安静地用默认端口（.env 里写 PORT= 等同于没写）
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return DEFAULT_PORT;
  }

  const trimmed = String(rawValue).trim();

  // 严格要求全是数字（拒绝 '9000abc'、'9.5'、'0x10' 这类"看似能解析"的值）
  if (!/^\d+$/.test(trimmed)) {
    console.warn(
      `[Config] PORT="${rawValue}" 不是合法整数，已回退到默认端口 ${DEFAULT_PORT}。` +
        `请在 .env 中把 PORT 改成 1-65535 之间的整数。`
    );
    return DEFAULT_PORT;
  }

  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > 65535) {
    console.warn(
      `[Config] PORT=${parsed} 超出合法范围 1-65535，已回退到默认端口 ${DEFAULT_PORT}。` +
        `请在 .env 中改成 1-65535 之间的整数。`
    );
    return DEFAULT_PORT;
  }

  return parsed;
}

/**
 * 解析 JWT 密钥：保持原有的"缺失就回退内置默认值"行为不变（不能让本地开发直接起不来），
 * 但环境变量缺失时会用默认密钥签发/校验 token——这是安全问题，必须显式告警。
 */
function resolveJwtSecret(rawValue) {
  if (rawValue) {
    return rawValue;
  }

  console.warn(
    '[Config] ⚠ 未设置环境变量 JWT_SECRET，正在使用不安全的项目内置默认密钥！' +
      '生产环境必须在 .env 中配置一个足够随机的 JWT_SECRET，否则任何人都能用默认密钥伪造登录 token。'
  );
  return DEFAULT_JWT_SECRET;
}

module.exports = {
  // 服务器端口：读 .env / 环境变量里的 PORT，非法值回退 8080（见 resolvePort）
  PORT: resolvePort(process.env.PORT),

  // API 版本
  API_VERSION: 'api/v1',

  // 数据库路径（相对于 server 目录）
  DB_PATH: './database/app.db',

  // JWT 密钥：优先环境变量，缺失时回退内置默认值并告警（见 resolveJwtSecret）
  JWT_SECRET: resolveJwtSecret(process.env.JWT_SECRET),

  // CORS 允许的源
  CORS_ORIGIN: '*'
};
