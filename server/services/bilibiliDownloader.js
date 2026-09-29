'use strict';

/**
 * B 站视频下载器
 *
 * 本模块同时承载「下载错误模型」：错误码、原因、尝试记录与分类规则都在这里定义，
 * videoAnalyzer 复用同一套模型，保证对外错误码一致。
 *
 * 目录边界说明：错误模型暂时与下载器同文件，若后续多人并行需要独立文件，
 * 建议抽出为 server/services/downloadErrors.js，本文件导出不变即可平滑迁移。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// ---------------------------------------------------------------------------
// 错误模型
// ---------------------------------------------------------------------------

/** 对外错误码 */
const ERROR_CODES = {
  /** HTTP 412 / Precondition Failed / 明确的 B 站风控响应 */
  RISK_CONTROL_412: 'RISK_CONTROL_412',
  /** 视频删除、私密、审核中、地区限制、权限不足 */
  VIDEO_INACCESSIBLE: 'VIDEO_INACCESSIBLE',
  /** URL 无法解析、BV 号非法 */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 网络、Cookie 失效、播放地址无效、响应流中断、ffmpeg、写入或完整性校验失败 */
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED'
};

/** 错误原因（比 code 更细，用于测试与路由层判断） */
const ERROR_REASONS = {
  // risk control
  HTTP_412: 'HTTP_412',
  WBI_RISK_CONTROL: 'WBI_RISK_CONTROL',
  RISK_CONTROL_PAGE: 'RISK_CONTROL_PAGE',
  // inaccessible
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  VIDEO_DELETED: 'VIDEO_DELETED',
  VIDEO_INVISIBLE: 'VIDEO_INVISIBLE',
  VIDEO_UNDER_REVIEW: 'VIDEO_UNDER_REVIEW',
  VIDEO_PRIVATE: 'VIDEO_PRIVATE',
  VIDEO_REGION_LIMITED: 'VIDEO_REGION_LIMITED',
  VIDEO_PERMISSION_DENIED: 'VIDEO_PERMISSION_DENIED',
  // input
  INVALID_BVID: 'INVALID_BVID',
  INVALID_URL: 'INVALID_URL',
  // download
  NO_PLAYABLE_STREAM: 'NO_PLAYABLE_STREAM',
  NO_CID: 'NO_CID',
  COOKIE_INVALID_OR_EXPIRED: 'COOKIE_INVALID_OR_EXPIRED',
  HTTP_ERROR: 'HTTP_ERROR',
  STREAM_INTERRUPTED: 'STREAM_INTERRUPTED',
  UNEXPECTED_CONTENT_TYPE: 'UNEXPECTED_CONTENT_TYPE',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  FILE_EMPTY: 'FILE_EMPTY',
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  NO_OUTPUT: 'NO_OUTPUT',
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN'
};

/** 错误阶段 */
const ERROR_STAGES = {
  VIDEO_INFO: 'video_info',
  PLAYURL: 'playurl',
  DOWNLOAD: 'download',
  MERGE: 'merge',
  VALIDATE: 'validate',
  YT_DLP: 'yt_dlp'
};

/** 这些原因的尝试记录没有诊断价值，不参与最终分类（避免覆盖此前的 412 判定） */
const NON_INFORMATIVE_REASONS = new Set([
  ERROR_REASONS.FILE_NOT_FOUND,
  ERROR_REASONS.NO_OUTPUT
]);

const DEFAULT_MESSAGES = {
  [ERROR_CODES.RISK_CONTROL_412]: 'B 站触发风控（412），Cookie 与匿名下载均失败，请稍后重试或更换网络/IP',
  [ERROR_CODES.VIDEO_INACCESSIBLE]: '视频已删除、私密、审核中或当前账号无权限访问',
  [ERROR_CODES.INVALID_INPUT]: '视频地址或 BV 号不合法',
  [ERROR_CODES.DOWNLOAD_FAILED]: '视频下载失败'
};

/**
 * 统一下载错误。
 * message 面向用户（中文），code/reason/stage/attempts 面向程序判断。
 * 保证不包含 Cookie 明文。
 */
class DownloadError extends Error {
  constructor({
    code = ERROR_CODES.DOWNLOAD_FAILED,
    reason = ERROR_REASONS.UNKNOWN,
    stage = ERROR_STAGES.DOWNLOAD,
    message = null,
    retryable = false,
    attempts = [],
    cause = null
  } = {}) {
    super(message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES[ERROR_CODES.DOWNLOAD_FAILED]);
    this.name = 'DownloadError';
    this.code = code;
    this.reason = reason;
    this.stage = stage;
    this.retryable = Boolean(retryable);
    this.attempts = Array.isArray(attempts) ? attempts : [];
    this.cause = cause || null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      reason: this.reason,
      stage: this.stage,
      retryable: this.retryable,
      message: this.message,
      attempts: this.attempts
    };
  }
}

function isDownloadError(error) {
  return Boolean(error) && error.name === 'DownloadError' && typeof error.code === 'string';
}

/** 是否属于「再重试也没意义」的致命错误 */
function isFatalDownloadError(error) {
  return isDownloadError(error)
    && (error.code === ERROR_CODES.INVALID_INPUT || error.code === ERROR_CODES.VIDEO_INACCESSIBLE);
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

const SENSITIVE_COOKIE_NAMES = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'SESSDATA__ckMd5',
  'buvid3',
  'buvid4'
];

/** 移除文本中的 Cookie 明文，用于日志与错误对象 */
function scrubSecrets(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);

  text = text.replace(/(set-cookie\s*:\s*)([^\r\n]+)/gi, '$1<redacted>');
  text = text.replace(/(\bcookie\s*:\s*)([^\r\n]+)/gi, '$1<redacted>');
  text = text.replace(
    new RegExp(`\\b(${SENSITIVE_COOKIE_NAMES.join('|')})\\s*=\\s*[^;\\s"']+`, 'gi'),
    '$1=<redacted>'
  );
  // Netscape cookie 文件行：domain\tflag\tpath\tsecure\texpiry\tname\tvalue
  text = text.replace(
    /^[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]*\t[^\t\r\n]*$/gm,
    '<redacted-cookie-line>'
  );
  return text;
}

/** 脱敏 + 截断，日志用 */
function truncateForLog(value, limit = 600) {
  const text = scrubSecrets(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…<truncated ${text.length - limit} chars>`;
}

// ---------------------------------------------------------------------------
// 尝试记录
// ---------------------------------------------------------------------------

class AttemptLog {
  constructor() {
    this.entries = [];
  }

  add(entry = {}) {
    const stored = {
      strategy: entry.strategy || 'unknown',
      withCookie: Boolean(entry.withCookie),
      ok: Boolean(entry.ok),
      code: entry.code || null,
      reason: entry.reason || null,
      stage: entry.stage || null,
      httpStatus: entry.httpStatus ?? null,
      apiCode: entry.apiCode ?? null,
      message: truncateForLog(entry.message || '', 300)
    };
    this.entries.push(stored);
    return stored;
  }

  toJSON() {
    return this.entries.map(entry => ({ ...entry }));
  }
}

function attemptEntryFromError(strategy, error, { withCookie } = {}) {
  const classified = isDownloadError(error) ? error : classifyUnknownError(error);
  return {
    strategy,
    withCookie,
    ok: false,
    code: classified.code,
    reason: classified.reason,
    stage: classified.stage,
    httpStatus: classified.httpStatus ?? null,
    apiCode: classified.apiCode ?? null,
    message: classified.message
  };
}

/** 把尝试记录附加到错误上；已有记录时原样返回，避免覆盖更详细的信息 */
function withAttempts(error, attempts) {
  if (!isDownloadError(error)) return error;
  if (Array.isArray(error.attempts) && error.attempts.length > 0) return error;
  const copy = new DownloadError({
    code: error.code,
    reason: error.reason,
    stage: error.stage,
    message: error.message,
    retryable: error.retryable,
    attempts,
    cause: error.cause || error
  });
  if (error.apiCode !== undefined) copy.apiCode = error.apiCode;
  if (error.httpStatus !== undefined) copy.httpStatus = error.httpStatus;
  return copy;
}

/**
 * 根据全部尝试记录决定最终错误。
 * 规则：
 *  - 致命错误（INVALID_INPUT / VIDEO_INACCESSIBLE）优先。
 *  - 所有「有诊断价值」的尝试都是 412 → RISK_CONTROL_412，不被后续「文件不存在」覆盖。
 *  - 其余情况采用最后一个可分类错误，兜底 DOWNLOAD_FAILED。
 */
function finalizeDownloadError({ attempts = [], lastError = null, stage = null } = {}) {
  if (isFatalDownloadError(lastError)) return withAttempts(lastError, attempts);

  const fatal = attempts.find(entry => entry.code === ERROR_CODES.INVALID_INPUT || entry.code === ERROR_CODES.VIDEO_INACCESSIBLE);
  if (fatal) {
    return new DownloadError({
      code: fatal.code,
      reason: fatal.reason || ERROR_REASONS.UNKNOWN,
      stage: fatal.stage || stage || ERROR_STAGES.DOWNLOAD,
      retryable: false,
      attempts
    });
  }

  const informative = attempts.filter(entry => entry.code && !NON_INFORMATIVE_REASONS.has(entry.reason));
  if (informative.length > 0 && informative.every(entry => entry.code === ERROR_CODES.RISK_CONTROL_412)) {
    return new DownloadError({
      code: ERROR_CODES.RISK_CONTROL_412,
      reason: ERROR_REASONS.HTTP_412,
      stage: informative[informative.length - 1].stage || stage || ERROR_STAGES.DOWNLOAD,
      retryable: true,
      attempts
    });
  }

  if (isDownloadError(lastError)) {
    return withAttempts(new DownloadError({
      code: lastError.code,
      reason: lastError.reason,
      stage: lastError.stage || stage || ERROR_STAGES.DOWNLOAD,
      message: lastError.message,
      retryable: lastError.retryable,
      attempts: (lastError.attempts && lastError.attempts.length) ? lastError.attempts : attempts,
      cause: lastError.cause || lastError
    }), attempts);
  }

  const fallback = classifyUnknownError(lastError);
  return new DownloadError({
    code: fallback.code,
    reason: fallback.reason,
    stage: stage || fallback.stage || ERROR_STAGES.DOWNLOAD,
    retryable: true,
    attempts,
    cause: lastError || null
  });
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

/** HTTP 状态码 → 错误码/原因 */
function classifyHttpStatus(status) {
  const numeric = Number(status);
  if (numeric === 412) {
    return { code: ERROR_CODES.RISK_CONTROL_412, reason: ERROR_REASONS.HTTP_412, retryable: true };
  }
  if (numeric === 403) {
    return { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.HTTP_ERROR, retryable: true };
  }
  if (numeric === 404) {
    return { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.HTTP_ERROR, retryable: false };
  }
  return { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.HTTP_ERROR, retryable: numeric >= 500 };
}

const INACCESSIBLE_KEYWORD_RULES = [
  { pattern: /删除|不存在|啥都木有|已被删除|稿件不存在/, reason: ERROR_REASONS.VIDEO_DELETED },
  { pattern: /不可见|仅自己可见|仅UP主自己可见|仅up主自己可见/, reason: ERROR_REASONS.VIDEO_INVISIBLE },
  { pattern: /审核中|正在审核/, reason: ERROR_REASONS.VIDEO_UNDER_REVIEW },
  { pattern: /私密|仅粉丝|好友可见/, reason: ERROR_REASONS.VIDEO_PRIVATE },
  { pattern: /地区|区域限制|当前地区|海外/, reason: ERROR_REASONS.VIDEO_REGION_LIMITED },
  { pattern: /权限|无权|未登录|会员专享|大会员|充电专属/, reason: ERROR_REASONS.VIDEO_PERMISSION_DENIED }
];

const INACCESSIBLE_API_CODES = {
  '-404': ERROR_REASONS.VIDEO_NOT_FOUND,
  '-403': ERROR_REASONS.VIDEO_PERMISSION_DENIED,
  '-10403': ERROR_REASONS.VIDEO_REGION_LIMITED,
  62001: ERROR_REASONS.VIDEO_DELETED,
  62002: ERROR_REASONS.VIDEO_INVISIBLE,
  62003: ERROR_REASONS.VIDEO_UNDER_REVIEW,
  62004: ERROR_REASONS.VIDEO_UNDER_REVIEW,
  62012: ERROR_REASONS.VIDEO_PRIVATE
};

function matchInaccessibleKeyword(message) {
  const text = String(message || '');
  for (const rule of INACCESSIBLE_KEYWORD_RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

function apiCodeKey(code) {
  if (code === null || code === undefined) return null;
  return String(code);
}

/**
 * B 站接口业务码 → 错误码/原因。
 * 分类优先级：风控 > 登录态 > 不可访问 > 输入非法 > 兜底。
 *
 * @param {number|string} code 业务码
 * @param {string} message 接口 message
 * @param {object} [options] { cookieSupplied } 本次请求是否携带了 Cookie
 */
function classifyBilibiliApiResponse(code, message, options = {}) {
  const key = apiCodeKey(code);

  if (key === '0') return { code: null, reason: null };

  // 风控：-412 / -352 与 HTTP 412 等价
  if (key === '-412' || key === '-352') {
    return { code: ERROR_CODES.RISK_CONTROL_412, reason: ERROR_REASONS.WBI_RISK_CONTROL, retryable: true };
  }

  // 登录态失效：带 Cookie 时说明 Cookie 不可用，摘掉 Cookie 重试即可
  if (key === '-101') {
    return options.cookieSupplied
      ? { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED, retryable: true }
      : { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.UNKNOWN, retryable: true };
  }

  // 输入非法：-400 请求错误，常见于 BV 号长度/字符不合法
  if (key === '-400') {
    return { code: ERROR_CODES.INVALID_INPUT, reason: ERROR_REASONS.INVALID_BVID, retryable: false };
  }

  const inaccessibleReason = INACCESSIBLE_API_CODES[key] || matchInaccessibleKeyword(message);
  if (inaccessibleReason) {
    return { code: ERROR_CODES.VIDEO_INACCESSIBLE, reason: inaccessibleReason, retryable: false };
  }

  // -509 请求过于频繁：属于风控性质，但明确区别于 412
  if (key === '-509') {
    return { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.NETWORK_ERROR, retryable: true };
  }

  return { code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.UNKNOWN, retryable: false };
}

/** axios / 系统错误 → 错误码 */
function classifyUnknownError(error) {
  if (!error) {
    return new DownloadError({ code: ERROR_CODES.DOWNLOAD_FAILED, reason: ERROR_REASONS.UNKNOWN });
  }

  const status = error.response?.status;
  if (status) {
    const classified = classifyHttpStatus(status);
    return new DownloadError({
      code: classified.code,
      reason: classified.reason,
      stage: ERROR_STAGES.DOWNLOAD,
      retryable: classified.retryable,
      cause: error
    });
  }

  const code = String(error.code || '');
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) {
    return new DownloadError({
      code: ERROR_CODES.DOWNLOAD_FAILED,
      reason: ERROR_REASONS.NETWORK_ERROR,
      stage: ERROR_STAGES.DOWNLOAD,
      retryable: true,
      cause: error
    });
  }

  return new DownloadError({
    code: ERROR_CODES.DOWNLOAD_FAILED,
    reason: ERROR_REASONS.UNKNOWN,
    stage: ERROR_STAGES.DOWNLOAD,
    retryable: true,
    cause: error
  });
}

/**
 * yt-dlp 输出文本 → 错误码。供 videoAnalyzer 复用，保证两个下载器分类一致。
 */
function classifyYtDlpFailure(text, { stage = ERROR_STAGES.YT_DLP } = {}) {
  const raw = String(text || '');
  const lowered = raw.toLowerCase();

  // 1. 风控优先
  if (/http error 412|precondition failed|\b412\b/.test(lowered)) {
    return new DownloadError({
      code: ERROR_CODES.RISK_CONTROL_412,
      reason: ERROR_REASONS.HTTP_412,
      stage,
      retryable: true
    });
  }
  if (/risk control|风控|banned|blocked by|-412/.test(lowered)) {
    return new DownloadError({
      code: ERROR_CODES.RISK_CONTROL_412,
      reason: ERROR_REASONS.WBI_RISK_CONTROL,
      stage,
      retryable: true
    });
  }

  // 2. Cookie 相关
  if (/cookie|sessdata|login required|需要登录|sign in/.test(lowered) && /incomplete|invalid|expired|failed|无效|过期|未登录/.test(lowered)) {
    return new DownloadError({
      code: ERROR_CODES.DOWNLOAD_FAILED,
      reason: ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED,
      stage,
      retryable: true
    });
  }

  // 3. 视频不可访问
  const inaccessibleReason = matchInaccessibleKeyword(raw);
  if (inaccessibleReason) {
    return new DownloadError({
      code: ERROR_CODES.VIDEO_INACCESSIBLE,
      reason: inaccessibleReason,
      stage,
      retryable: false
    });
  }
  if (/video unavailable|this video is not available|no video formats|unable to extract|not available in your country/.test(lowered)) {
    return new DownloadError({
      code: ERROR_CODES.VIDEO_INACCESSIBLE,
      reason: ERROR_REASONS.VIDEO_NOT_FOUND,
      stage,
      retryable: false
    });
  }

  return new DownloadError({
    code: ERROR_CODES.DOWNLOAD_FAILED,
    reason: ERROR_REASONS.UNKNOWN,
    stage,
    retryable: true
  });
}

/** 面向用户的最终提示，区分 412 / 不可访问 / 普通失败 */
function buildUserFacingMessage(error) {
  if (!isDownloadError(error)) {
    return DEFAULT_MESSAGES[ERROR_CODES.DOWNLOAD_FAILED];
  }

  if (error.code === ERROR_CODES.RISK_CONTROL_412) {
    return DEFAULT_MESSAGES[ERROR_CODES.RISK_CONTROL_412];
  }
  if (error.code === ERROR_CODES.VIDEO_INACCESSIBLE) {
    return DEFAULT_MESSAGES[ERROR_CODES.VIDEO_INACCESSIBLE];
  }
  if (error.code === ERROR_CODES.INVALID_INPUT) {
    return DEFAULT_MESSAGES[ERROR_CODES.INVALID_INPUT];
  }

  const attempted = (error.attempts || [])
    .map(attempt => `${attempt.strategy}${attempt.withCookie ? '(cookie)' : '(anonymous)'}`)
    .join(' → ');
  const stageText = error.stage ? `失败阶段：${error.stage}` : '';
  const attemptText = attempted ? `；已尝试：${attempted}` : '';
  return `视频下载失败（${error.reason}）。${stageText}${attemptText}`;
}

// ---------------------------------------------------------------------------
// Cookie 处理
// ---------------------------------------------------------------------------

/**
 * 解析 Cookie 输入。支持两种格式：
 *  1. Netscape cookie 文件内容（B 站导出的 cookies.txt）
 *  2. 原始 Cookie 请求头（"SESSDATA=x; bili_jct=y"）
 * 返回值绝不包含日志输出，仅用于构造请求头。
 */
function parseCookieInput(input) {
  const result = {
    valid: false,
    reason: null,
    pairs: [],
    hasSessdata: false,
    expired: false
  };

  if (!input || typeof input !== 'string' || !input.trim()) {
    result.reason = ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED;
    return result;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  let sawCookieLine = false;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    // Netscape 格式
    if (line.includes('\t')) {
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const expiry = Number(parts[4]);
      const name = parts[5]?.trim();
      const value = parts.slice(6).join('\t').trim();
      if (!name || !value) continue;
      sawCookieLine = true;
      if (Number.isFinite(expiry) && expiry > 0 && expiry < nowSeconds) result.expired = true;
      result.pairs.push(`${name}=${value}`);
      if (name === 'SESSDATA') result.hasSessdata = true;
      continue;
    }

    // 原始 Cookie 头格式
    for (const segment of line.split(';')) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!name || !value) continue;
      sawCookieLine = true;
      result.pairs.push(`${name}=${value}`);
      if (name === 'SESSDATA') result.hasSessdata = true;
    }
  }

  if (!sawCookieLine || result.pairs.length === 0) {
    result.reason = ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED;
    return result;
  }

  if (result.expired) {
    result.reason = ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED;
    return result;
  }

  // 没有 SESSDATA 基本等于未登录：按无效处理，直接走匿名路径
  if (!result.hasSessdata) {
    result.reason = ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED;
    return result;
  }

  result.valid = true;
  return result;
}

function readCookieFile(cookiesPath) {
  try {
    return fs.readFileSync(cookiesPath, 'utf8');
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe 解析
// ---------------------------------------------------------------------------

/** ffmpeg.exe → ffprobe.exe；兼容不带扩展名的路径 */
function resolveFfprobePath() {
  const sibling = ffmpegPath.replace(/(ffmpeg)(\.exe)?$/i, (_match, _name, ext) => `ffprobe${ext || ''}`);
  if (sibling !== ffmpegPath && fs.existsSync(sibling)) return sibling;

  const repoSibling = path.join(__dirname, '../../scripts/ffmpeg/ffprobe.exe');
  if (fs.existsSync(repoSibling)) return repoSibling;

  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return 'ffprobe';

  return null;
}

// ---------------------------------------------------------------------------
// 下载器
// ---------------------------------------------------------------------------

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_VIDEO_BYTES = 1024;
const PART_SUFFIX = '.part';
const MAX_BACKUP_URL_TRIES = 2;

class BilibiliDownloader {
  /**
   * @param {object} [options]
   * @param {string} [options.downloadDir]
   * @param {object} [options.http]       注入的 axios 兼容实例（测试用）
   * @param {Function} [options.spawnImpl] 注入的 spawn（测试用）
   * @param {string} [options.ffmpegPath]
   * @param {string|null} [options.ffprobePath]
   * @param {number} [options.maxAttemptsPerStrategy] 每个策略的最大尝试次数
   */
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.join(__dirname, '../../downloads');
    this.http = options.http || axios;
    this.spawnImpl = options.spawnImpl || spawn;
    this.ffmpegPath = options.ffmpegPath || ffmpegPath;
    this.ffprobePath = options.ffprobePath !== undefined ? options.ffprobePath : resolveFfprobePath();
    this.maxAttemptsPerStrategy = Number.isFinite(options.maxAttemptsPerStrategy)
      ? Math.max(1, options.maxAttemptsPerStrategy)
      : 2;
    this.ensureDownloadDir();
  }

  ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  // --- 基础工具 ---------------------------------------------------------

  requestHeaders(bvid, cookieHeader) {
    const headers = {
      'User-Agent': DEFAULT_UA,
      Referer: `https://www.bilibili.com/video/${bvid}`
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  extractBvid(url) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new DownloadError({
        code: ERROR_CODES.INVALID_INPUT,
        reason: ERROR_REASONS.INVALID_URL,
        stage: ERROR_STAGES.VIDEO_INFO,
        retryable: false
      });
    }
    const bvMatch = url.match(/BV[0-9A-Za-z]{10}/);
    if (!bvMatch) {
      throw new DownloadError({
        code: ERROR_CODES.INVALID_INPUT,
        reason: ERROR_REASONS.INVALID_BVID,
        stage: ERROR_STAGES.VIDEO_INFO,
        retryable: false
      });
    }
    return bvMatch[0];
  }

  /** 把 axios/B 站响应错误统一成 DownloadError */
  wrapApiError(error, stage, options = {}) {
    if (isDownloadError(error)) return error;

    const status = error?.response?.status;
    if (status) {
      const classified = classifyHttpStatus(status);
      return new DownloadError({
        code: classified.code,
        reason: classified.reason,
        stage,
        retryable: classified.retryable,
        cause: error
      });
    }

    const apiCode = error?.response?.data?.code;
    if (apiCode !== undefined) {
      const classified = classifyBilibiliApiResponse(
        apiCode,
        error?.response?.data?.message,
        { cookieSupplied: Boolean(options.cookieHeader) }
      );
      if (classified.code) {
        const wrapped = new DownloadError({
          code: classified.code,
          reason: classified.reason,
          stage,
          retryable: Boolean(classified.retryable),
          cause: error
        });
        wrapped.apiCode = apiCode;
        return wrapped;
      }
    }

    const classified = classifyUnknownError(error);
    return new DownloadError({
      code: classified.code,
      reason: classified.reason,
      stage,
      retryable: classified.retryable,
      cause: error
    });
  }

  // --- B 站接口 ---------------------------------------------------------

  async getVideoInfo(bvid, options = {}) {
    const cookieHeader = options.cookieHeader || null;
    let response;
    try {
      response = await this.http.get('https://api.bilibili.com/x/web-interface/view', {
        params: { bvid },
        headers: this.requestHeaders(bvid, cookieHeader),
        timeout: 15000,
        validateStatus: () => true
      });
    } catch (error) {
      throw this.wrapApiError(error, ERROR_STAGES.VIDEO_INFO, { cookieHeader });
    }

    const body = response?.data || {};
    const status = response?.status;

    if (status && status !== 200) {
      const classified = classifyHttpStatus(status);
      throw new DownloadError({
        code: classified.code,
        reason: classified.reason,
        stage: ERROR_STAGES.VIDEO_INFO,
        retryable: classified.retryable
      });
    }

    if (body.code !== 0) {
      const classified = classifyBilibiliApiResponse(body.code, body.message, { cookieSupplied: Boolean(cookieHeader) });
      const error = new DownloadError({
        code: classified.code || ERROR_CODES.DOWNLOAD_FAILED,
        reason: classified.reason || ERROR_REASONS.UNKNOWN,
        stage: ERROR_STAGES.VIDEO_INFO,
        retryable: Boolean(classified.retryable),
        message: classified.code === ERROR_CODES.DOWNLOAD_FAILED
          ? `获取视频信息失败: ${scrubSecrets(body.message)}`
          : undefined
      });
      error.apiCode = body.code;
      throw error;
    }

    if (!body.data) {
      throw new DownloadError({
        code: ERROR_CODES.VIDEO_INACCESSIBLE,
        reason: ERROR_REASONS.VIDEO_INVISIBLE,
        stage: ERROR_STAGES.VIDEO_INFO,
        retryable: false
      });
    }

    return body.data;
  }

  async getPlayUrl(bvid, cid, options = {}) {
    const cookieHeader = options.cookieHeader || null;
    let response;
    try {
      response = await this.http.get('https://api.bilibili.com/x/player/playurl', {
        params: {
          bvid,
          cid,
          qn: options.qn || 120,
          fnval: 16, // dash；匿名访问时 B 站仍会返回 durl，两种结构都要处理
          fnver: 0,
          fourk: 1,
          otf: 0,
          platform: 'html5'
        },
        headers: this.requestHeaders(bvid, cookieHeader),
        timeout: 15000,
        validateStatus: () => true
      });
    } catch (error) {
      throw this.wrapApiError(error, ERROR_STAGES.PLAYURL, { cookieHeader });
    }

    const body = response?.data || {};
    const status = response?.status;

    if (status && status !== 200) {
      const classified = classifyHttpStatus(status);
      throw new DownloadError({
        code: classified.code,
        reason: classified.reason,
        stage: ERROR_STAGES.PLAYURL,
        retryable: classified.retryable
      });
    }

    if (body.code !== 0) {
      const classified = classifyBilibiliApiResponse(body.code, body.message, { cookieSupplied: Boolean(cookieHeader) });
      const error = new DownloadError({
        code: classified.code || ERROR_CODES.DOWNLOAD_FAILED,
        reason: classified.reason || ERROR_REASONS.UNKNOWN,
        stage: ERROR_STAGES.PLAYURL,
        retryable: Boolean(classified.retryable),
        message: classified.code === ERROR_CODES.DOWNLOAD_FAILED
          ? `获取播放地址失败: ${scrubSecrets(body.message)}`
          : undefined
      });
      error.apiCode = body.code;
      throw error;
    }

    return body;
  }

  /** 从 playurl 响应中提取可下载的流；既无 dash 也无 durl 时抛 NO_PLAYABLE_STREAM */
  resolvePlayableStreams(playUrlData) {
    const data = playUrlData?.data || {};

    if (data.dash && Array.isArray(data.dash.video) && data.dash.video.length > 0) {
      const videoStream = data.dash.video.find(stream => stream.id === data.quality) || data.dash.video[0];
      const audioStream = Array.isArray(data.dash.audio) && data.dash.audio.length > 0 ? data.dash.audio[0] : null;
      return { kind: 'dash', videoStream, audioStream };
    }

    if (Array.isArray(data.durl) && data.durl.length > 0) {
      const parts = data.durl
        .slice()
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
        .filter(part => part && typeof part.url === 'string' && part.url);
      if (parts.length === 0) {
        throw new DownloadError({
          code: ERROR_CODES.DOWNLOAD_FAILED,
          reason: ERROR_REASONS.NO_PLAYABLE_STREAM,
          stage: ERROR_STAGES.PLAYURL,
          retryable: false
        });
      }
      return { kind: 'durl', parts };
    }

    throw new DownloadError({
      code: ERROR_CODES.DOWNLOAD_FAILED,
      reason: ERROR_REASONS.NO_PLAYABLE_STREAM,
      stage: ERROR_STAGES.PLAYURL,
      retryable: false
    });
  }

  // --- 下载 -------------------------------------------------------------

  /** 带状态码/内容类型/流错误检查的单文件下载，写入 .part 后原子重命名 */
  async downloadStreamToFile({
    url,
    outputPath,
    onProgress = null,
    referer = 'https://www.bilibili.com/',
    expectedSize = null,
    label = 'download'
  }) {
    let response;
    try {
      response = await this.http({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 300000,
        headers: { 'User-Agent': DEFAULT_UA, Referer: referer },
        validateStatus: () => true,
        maxRedirects: 5
      });
    } catch (error) {
      throw this.wrapApiError(error, ERROR_STAGES.DOWNLOAD);
    }

    const status = Number(response?.status);
    if (status !== 200) {
      // 先释放流，避免连接悬挂
      try { response?.data?.destroy?.(); } catch (_) { /* noop */ }
      const classified = classifyHttpStatus(status);
      throw new DownloadError({
        code: classified.code,
        reason: classified.reason,
        stage: ERROR_STAGES.DOWNLOAD,
        retryable: classified.retryable,
        message: `${label} 返回 HTTP ${status}`
      });
    }

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const contentLength = Number(response.headers?.['content-length']);
    const stream = response.data;

    if (!stream || typeof stream.pipe !== 'function') {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.STREAM_INTERRUPTED,
        stage: ERROR_STAGES.DOWNLOAD,
        retryable: true,
        message: `${label} 未返回可读流`
      });
    }

    // 风险控制页面通常以 HTML 返回
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      const preview = await readStreamPreview(stream, 2048);
      try { stream.destroy?.(); } catch (_) { /* noop */ }
      const riskLike = /412|precondition failed|风控|risk/i.test(preview);
      throw new DownloadError({
        code: riskLike ? ERROR_CODES.RISK_CONTROL_412 : ERROR_CODES.DOWNLOAD_FAILED,
        reason: riskLike ? ERROR_REASONS.RISK_CONTROL_PAGE : ERROR_REASONS.UNEXPECTED_CONTENT_TYPE,
        stage: ERROR_STAGES.DOWNLOAD,
        retryable: riskLike,
        message: `${label} 返回了非视频内容（content-type=${contentType || 'unknown'}）`
      });
    }

    const partPath = `${outputPath}${PART_SUFFIX}`;
    const writer = fs.createWriteStream(partPath);
    let received = 0;
    let settled = false;
    let lastReportedWholePercent = -1;

    const cleanupPart = () => {
      try { writer.destroy(); } catch (_) { /* noop */ }
      try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (_) { /* noop */ }
    };

    try {
      await new Promise((resolve, reject) => {
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { stream.destroy?.(); } catch (_) { /* noop */ }
          cleanupPart();
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        stream.on('data', (chunk) => {
          received += chunk.length;
          if (!onProgress || !Number.isFinite(contentLength) || contentLength <= 0) return;

          const ratio = Math.min(1, received / contentLength);
          const wholePercent = Math.floor(ratio * 100);
          // 每个百分位只上报一次，避免逐 chunk 刷屏
          if (wholePercent === lastReportedWholePercent) return;
          lastReportedWholePercent = wholePercent;

          onProgress({
            stage: 'download',
            percent: 10 + Math.floor(ratio * 8),
            message: `正在下载 ${wholePercent}%`,
            label
          });
        });
        stream.on('error', (error) => fail(new DownloadError({
          code: ERROR_CODES.DOWNLOAD_FAILED,
          reason: ERROR_REASONS.STREAM_INTERRUPTED,
          stage: ERROR_STAGES.DOWNLOAD,
          retryable: true,
          message: `${label} 响应流中断: ${scrubSecrets(error?.message || '')}`,
          cause: error
        })));
        writer.on('error', (error) => fail(new DownloadError({
          code: ERROR_CODES.DOWNLOAD_FAILED,
          reason: ERROR_REASONS.STREAM_INTERRUPTED,
          stage: ERROR_STAGES.DOWNLOAD,
          retryable: true,
          message: `${label} 写入失败: ${scrubSecrets(error?.message || '')}`,
          cause: error
        })));
        writer.on('finish', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        // 没有 finish 就 close 说明写入被提前中断，视为失败
        writer.on('close', () => {
          if (settled) return;
          fail(new DownloadError({
            code: ERROR_CODES.DOWNLOAD_FAILED,
            reason: ERROR_REASONS.STREAM_INTERRUPTED,
            stage: ERROR_STAGES.DOWNLOAD,
            retryable: true,
            message: `${label} 写入流被提前关闭`
          }));
        });

        stream.pipe(writer);
      });
    } catch (error) {
      cleanupPart();
      throw isDownloadError(error) ? error : this.wrapApiError(error, ERROR_STAGES.DOWNLOAD);
    }

    // 完整性检查：字节数为 0、或与 content-length 不符，都视为失败
    let stat;
    try {
      stat = fs.statSync(partPath);
    } catch (error) {
      cleanupPart();
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_NOT_FOUND,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label} 下载后文件不存在`
      });
    }

    const effectiveExpected = Number.isFinite(expectedSize) && expectedSize > 0
      ? expectedSize
      : (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null);

    if (stat.size < MIN_VIDEO_BYTES) {
      cleanupPart();
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_EMPTY,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label} 下载文件过小（${stat.size} 字节）`
      });
    }

    if (effectiveExpected && stat.size !== effectiveExpected) {
      cleanupPart();
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.SIZE_MISMATCH,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label} 下载不完整（${stat.size}/${effectiveExpected} 字节）`
      });
    }

    fs.renameSync(partPath, outputPath);
    return { path: outputPath, size: stat.size, expectedSize: effectiveExpected };
  }

  /** 按 dash 结构下载视频流与音频流并用 ffmpeg 合并 */
  async downloadDash(bvid, streams, outputPath, onProgress, cookieHeader = null) {
    const videoUrls = pickStreamUrls(streams.videoStream);
    const audioUrls = streams.audioStream ? pickStreamUrls(streams.audioStream) : [];

    if (videoUrls.length === 0) {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.NO_PLAYABLE_STREAM,
        stage: ERROR_STAGES.PLAYURL,
        retryable: false,
        message: 'dash 响应缺少视频流地址'
      });
    }

    const videoPart = path.join(this.downloadDir, `${bvid}.video.m4s`);
    const audioPart = path.join(this.downloadDir, `${bvid}.audio.m4s`);

    await this.downloadWithFallbackUrls(videoUrls, videoPart, onProgress, 'dash-video');

    if (audioUrls.length > 0) {
      try {
        await this.downloadWithFallbackUrls(audioUrls, audioPart, onProgress, 'dash-audio');
      } catch (error) {
        cleanupFiles([videoPart]);
        throw error;
      }

      try {
        if (onProgress) onProgress({ stage: 'download', percent: 18, message: '正在合并音视频' });
        await this.mergeWithFfmpeg([
          ['-i', videoPart],
          ['-i', audioPart],
          ['-c', 'copy'],
          ['-map', '0:v:0'],
          ['-map', '1:a:0']
        ], outputPath);
      } catch (error) {
        cleanupFiles([videoPart, audioPart]);
        throw error;
      } finally {
        cleanupFiles([videoPart, audioPart]);
      }
      return;
    }

    // 没有音频流：直接落盘视频流，避免用 ffmpeg 转封装失败导致整体失败
    fs.renameSync(videoPart, outputPath);
  }

  /** 按 durl 结构下载全部分片，多于一个分片时用 ffmpeg concat 合并 */
  async downloadDurl(bvid, parts, outputPath, onProgress) {
    if (parts.length === 1) {
      await this.downloadWithFallbackUrls(
        pickPartUrls(parts[0]),
        outputPath,
        onProgress,
        'durl-1',
        Number(parts[0].size) > 0 ? Number(parts[0].size) : null
      );
      return;
    }

    const downloadedParts = [];
    const listPath = path.join(this.downloadDir, `${bvid}.concat.txt`);
    try {
      for (let index = 0; index < parts.length; index += 1) {
        const partPath = path.join(this.downloadDir, `${bvid}.durl-${index + 1}.mp4`);
        // eslint-disable-next-line no-await-in-loop
        await this.downloadWithFallbackUrls(
          pickPartUrls(parts[index]),
          partPath,
          onProgress,
          `durl-${index + 1}/${parts.length}`,
          Number(parts[index].size) > 0 ? Number(parts[index].size) : null
        );
        downloadedParts.push(partPath);
      }

      const listContent = downloadedParts
        .map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n');
      fs.writeFileSync(listPath, `${listContent}\n`, 'utf8');

      if (onProgress) onProgress({ stage: 'download', percent: 18, message: '正在合并分片' });
      await this.mergeWithFfmpeg([
        ['-f', 'concat'],
        ['-safe', '0'],
        ['-i', listPath],
        ['-c', 'copy']
      ], outputPath);
    } finally {
      cleanupFiles([...downloadedParts, listPath]);
    }
  }

  /** 依次尝试主地址与备份地址 */
  async downloadWithFallbackUrls(urls, outputPath, onProgress, label, expectedSize = null) {
    const candidates = urls.slice(0, 1 + MAX_BACKUP_URL_TRIES);
    let lastError = null;

    for (const url of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.downloadStreamToFile({
          url,
          outputPath,
          onProgress,
          expectedSize,
          label
        });
      } catch (error) {
        lastError = error;
        if (isFatalDownloadError(error)) throw error;
        if (!isDownloadError(error) || !error.retryable) throw error;
      }
    }

    throw lastError;
  }

  /** ffmpeg 合并/转封装，输出到 .part 再原子重命名 */
  async mergeWithFfmpeg(inputArgs, outputPath) {
    const partPath = `${outputPath}${PART_SUFFIX}`;
    const args = ['-y', ...inputArgs.flat(), '-movflags', '+faststart', partPath];

    const result = await new Promise((resolve) => {
      let stderr = '';
      let child;
      try {
        child = this.spawnImpl(this.ffmpegPath, args, { windowsHide: true });
      } catch (error) {
        resolve({ ok: false, stderr: error?.message || '' });
        return;
      }

      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      child.on('error', (error) => resolve({ ok: false, stderr: `${stderr}\n${error.message}` }));
      child.on('close', (code) => resolve({ ok: code === 0, stderr }));
    });

    if (!result.ok) {
      cleanupFiles([partPath]);
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FFMPEG_FAILED,
        stage: ERROR_STAGES.MERGE,
        retryable: true,
        message: `ffmpeg 合并失败: ${truncateForLog(result.stderr, 400)}`
      });
    }

    let stat;
    try {
      stat = fs.statSync(partPath);
    } catch (_) {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_NOT_FOUND,
        stage: ERROR_STAGES.MERGE,
        retryable: true,
        message: 'ffmpeg 合并后未生成文件'
      });
    }

    if (stat.size < MIN_VIDEO_BYTES) {
      cleanupFiles([partPath]);
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_EMPTY,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `合并结果过小（${stat.size} 字节）`
      });
    }

    fs.renameSync(partPath, outputPath);
    return outputPath;
  }

  // --- 校验 -------------------------------------------------------------

  /** 用 ffprobe 检查是否存在视频流；ffprobe 不可用时降级为仅体积校验 */
  async probeHasVideoStream(filePath) {
    if (!this.ffprobePath) return { checked: false, hasVideo: null };

    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath
    ];

    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = this.spawnImpl(this.ffprobePath, args, { windowsHide: true });
      } catch (error) {
        resolve({ checked: false, hasVideo: null, error: error?.message });
        return;
      }
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => resolve({ checked: false, hasVideo: null, error: error.message }));
      child.on('close', (code) => resolve({ checked: true, hasVideo: code === 0 && /video/i.test(stdout), stderr }));
    });

    if (!result.checked) return result;
    return result;
  }

  /** 校验最终文件：非空 + 存在视频流；不通过则删除文件并抛错 */
  async validateVideoFile(filePath, { expectedSize = null, label = '视频文件' } = {}) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_NOT_FOUND,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label}不存在`
      });
    }

    if (stat.size < MIN_VIDEO_BYTES) {
      cleanupFiles([filePath]);
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.FILE_EMPTY,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label}为空或过小（${stat.size} 字节）`
      });
    }

    if (Number.isFinite(expectedSize) && expectedSize > 0 && stat.size !== expectedSize) {
      cleanupFiles([filePath]);
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.SIZE_MISMATCH,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label}大小不符（${stat.size}/${expectedSize} 字节）`
      });
    }

    const probe = await this.probeHasVideoStream(filePath);
    if (probe.checked && probe.hasVideo === false) {
      cleanupFiles([filePath]);
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.NO_VIDEO_STREAM,
        stage: ERROR_STAGES.VALIDATE,
        retryable: true,
        message: `${label}不含视频流`
      });
    }

    return { size: stat.size, probed: probe.checked };
  }

  /** 缓存文件是否可用：存在 + 体积合理 + 视频流校验通过 */
  async isUsableCache(filePath) {
    if (!fs.existsSync(filePath)) return false;
    try {
      await this.validateVideoFile(filePath, { label: '缓存视频' });
      return true;
    } catch (error) {
      console.warn(`[BilibiliDownloader] 丢弃无效缓存: ${path.basename(filePath)} (${isDownloadError(error) ? error.reason : 'unknown'})`);
      return false;
    }
  }

  /**
   * 清理上次异常中断留下的中间产物。
   * 这些文件本身都是合法 mp4/m4s，不会被文件名精确匹配命中，
   * 但不清理会一直堆积，也会干扰人工排查。
   */
  cleanupStaleArtifacts(bvid) {
    if (!bvid || !fs.existsSync(this.downloadDir)) return [];

    const escaped = bvid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^${escaped}\\.mp4\\.part$`),
      new RegExp(`^${escaped}\\.durl-\\d+\\.mp4$`),
      new RegExp(`^${escaped}\\.concat\\.txt$`),
      new RegExp(`^${escaped}\\.(video|audio)\\.m4s$`),
      new RegExp(`^${escaped}\\.f\\d+\\.(mp4|m4a|webm)$`)
    ];

    const removed = [];
    for (const file of fs.readdirSync(this.downloadDir)) {
      if (patterns.some(pattern => pattern.test(file))) {
        try {
          fs.unlinkSync(path.join(this.downloadDir, file));
          removed.push(file);
        } catch (_) { /* noop */ }
      }
    }

    if (removed.length > 0) {
      console.log(`[BilibiliDownloader] 清理 ${removed.length} 个上次中断残留的中间文件`);
    }
    return removed;
  }

  // --- 主流程 -----------------------------------------------------------

  /** 处理 Cookie 输入，返回请求头与尝试记录所需信息 */
  resolveCookieContext(options = {}) {
    if (options.cookieHeader) {
      return { cookieHeader: options.cookieHeader, valid: true, reason: null };
    }

    let raw = null;
    if (typeof options.cookies === 'string' && options.cookies.trim()) {
      raw = options.cookies;
    } else if (options.cookiesPath && fs.existsSync(options.cookiesPath)) {
      raw = readCookieFile(options.cookiesPath);
    }

    if (!raw) {
      return { cookieHeader: null, valid: false, reason: null };
    }

    const parsed = parseCookieInput(raw);
    if (!parsed.valid) {
      console.warn(`[BilibiliDownloader] Cookie 不可用（${parsed.reason || 'unknown'}），将使用匿名路径`);
      return { cookieHeader: null, valid: false, reason: parsed.reason || ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED };
    }

    return {
      cookieHeader: parsed.pairs.join('; '),
      valid: true,
      reason: parsed.reason,
      hasSessdata: parsed.hasSessdata
    };
  }

  /**
   * 下载单个视频。
   * @param {string} url B 站视频地址或含 BV 号的字符串
   * @param {Function|null} onProgress 进度回调
   * @param {object} [options] { cookies, cookiesPath, quality, onAttempt }
   * @returns {Promise<string>} 最终 mp4 路径（保持旧调用兼容）
   */
  async downloadVideo(url, onProgress = null, options = {}) {
    const bvid = this.extractBvid(url);
    const outputPath = path.join(this.downloadDir, `${bvid}.mp4`);
    const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : null;
    const attempts = new AttemptLog();

    const recordAttempt = (entry) => {
      const stored = attempts.add(entry);
      if (onAttempt) {
        try { onAttempt({ ...stored }); } catch (_) { /* noop */ }
      }
      return stored;
    };

    // 缓存命中：必须是校验通过的文件
    if (await this.isUsableCache(outputPath)) {
      console.log(`[BilibiliDownloader] 命中有效缓存: ${outputPath}`);
      if (onProgress) onProgress({ stage: 'download', percent: 20, message: '视频已缓存，跳过下载' });
      recordAttempt({ strategy: 'cache', withCookie: false, ok: true, message: '命中有效缓存' });
      return outputPath;
    }
    if (fs.existsSync(outputPath)) {
      cleanupFiles([outputPath]);
    }

    this.cleanupStaleArtifacts(bvid);

    const cookieContext = this.resolveCookieContext(options);
    if (cookieContext.reason && !cookieContext.valid) {
      recordAttempt({
        strategy: 'bilibili_api',
        withCookie: true,
        ok: false,
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED,
        stage: ERROR_STAGES.VIDEO_INFO,
        message: 'Cookie 缺失或格式错误，跳过 Cookie 路径'
      });
    }

    // 策略顺序：A 带 Cookie → B 匿名
    const policies = [];
    if (cookieContext.cookieHeader) {
      policies.push({ withCookie: true, cookieHeader: cookieContext.cookieHeader, strategy: 'bilibili_api' });
    }
    policies.push({ withCookie: false, cookieHeader: null, strategy: 'bilibili_api_anonymous' });

    let lastError = null;
    let cookieRejected = false;

    for (const policy of policies) {
      // Cookie 路径已经因为认证问题失败，就不必再重复尝试同一份 Cookie
      if (policy.withCookie && cookieRejected) continue;

      try {
        if (onProgress) {
          onProgress({
            stage: 'download',
            percent: 10,
            message: policy.withCookie ? '正在使用 Cookie 下载' : '正在匿名下载',
            strategy: policy.strategy,
            withCookie: policy.withCookie
          });
        }

        const result = await this.downloadViaBilibiliApi(bvid, policy, outputPath, onProgress, options);
        await this.validateVideoFile(outputPath, { label: '下载视频' });

        recordAttempt({
          strategy: policy.strategy,
          withCookie: policy.withCookie,
          ok: true,
          message: `下载成功（${(result?.size / 1024 / 1024).toFixed(2)} MB）`
        });

        if (onProgress) onProgress({ stage: 'download', percent: 20, message: '视频下载完成' });
        console.log(`[BilibiliDownloader] 下载完成: ${outputPath} (${policy.strategy})`);
        return outputPath;
      } catch (error) {
        lastError = error;
        cleanupFiles([outputPath]);

        const entry = recordAttempt(attemptEntryFromError(policy.strategy, error, { withCookie: policy.withCookie }));
        console.warn(`[BilibiliDownloader] ${policy.strategy}${policy.withCookie ? '(cookie)' : '(anonymous)'} 失败: ${entry.code}/${entry.reason} - ${entry.message}`);

        if (isFatalDownloadError(error)) {
          // 视频不可访问或输入非法：匿名重试没有意义
          throw withAttempts(error, attempts.toJSON());
        }
        if (entry.reason === ERROR_REASONS.COOKIE_INVALID_OR_EXPIRED) {
          cookieRejected = true;
        }
      }
    }

    throw finalizeDownloadError({ attempts: attempts.toJSON(), lastError });
  }

  /** 单次 B 站接口下载，失败时抛出 DownloadError */
  async downloadViaBilibiliApi(bvid, policy, outputPath, onProgress, options = {}) {
    const videoInfo = await this.getVideoInfo(bvid, { cookieHeader: policy.cookieHeader });
    const cid = videoInfo?.pages?.[0]?.cid ?? videoInfo?.cid;
    if (!cid) {
      throw new DownloadError({
        code: ERROR_CODES.DOWNLOAD_FAILED,
        reason: ERROR_REASONS.NO_CID,
        stage: ERROR_STAGES.PLAYURL,
        retryable: false,
        message: '无法获取视频 CID'
      });
    }

    const playUrlData = await this.getPlayUrl(bvid, cid, {
      cookieHeader: policy.cookieHeader,
      qn: options.quality || 120
    });

    const streams = this.resolvePlayableStreams(playUrlData);

    if (streams.kind === 'dash') {
      await this.downloadDash(bvid, streams, outputPath, onProgress, policy.cookieHeader);
    } else {
      await this.downloadDurl(bvid, streams.parts, outputPath, onProgress);
    }

    return { size: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0 };
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function cleanupFiles(paths) {
  for (const file of paths) {
    if (!file) continue;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) { /* noop */ }
  }
}

/** dash 流的 baseUrl / backupUrl：兼容驼峰与下划线两种字段名 */
function pickStreamUrls(stream) {
  if (!stream) return [];
  const urls = [];
  const primary = stream.baseUrl || stream.base_url;
  if (primary) urls.push(primary);
  const backups = stream.backupUrl || stream.backup_url;
  if (Array.isArray(backups)) urls.push(...backups.filter(Boolean));
  return urls.filter(url => typeof url === 'string' && url);
}

function pickPartUrls(part) {
  if (!part) return [];
  const urls = [];
  if (part.url) urls.push(part.url);
  if (Array.isArray(part.backup_url)) urls.push(...part.backup_url.filter(Boolean));
  return urls.filter(url => typeof url === 'string' && url);
}

/** 读取流的前 N 字节用于内容嗅探，之后销毁流 */
function readStreamPreview(stream, limit) {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(buffer);
    };

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8', 0, Math.min(chunk.length, limit));
      if (buffer.length >= limit) {
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
    setTimeout(finish, 1500);
  });
}

module.exports = BilibiliDownloader;

// 错误模型与工具函数挂在类上导出，保持 `new (require('./bilibiliDownloader'))()` 的旧用法可用
module.exports.DownloadError = DownloadError;
module.exports.ERROR_CODES = ERROR_CODES;
module.exports.ERROR_REASONS = ERROR_REASONS;
module.exports.ERROR_STAGES = ERROR_STAGES;
module.exports.isDownloadError = isDownloadError;
module.exports.isFatalDownloadError = isFatalDownloadError;
module.exports.classifyHttpStatus = classifyHttpStatus;
module.exports.classifyBilibiliApiResponse = classifyBilibiliApiResponse;
module.exports.classifyYtDlpFailure = classifyYtDlpFailure;
module.exports.classifyUnknownError = classifyUnknownError;
module.exports.finalizeDownloadError = finalizeDownloadError;
module.exports.withAttempts = withAttempts;
module.exports.attemptEntryFromError = attemptEntryFromError;
module.exports.buildUserFacingMessage = buildUserFacingMessage;
module.exports.scrubSecrets = scrubSecrets;
module.exports.parseCookieInput = parseCookieInput;
module.exports.resolveFfprobePath = resolveFfprobePath;
module.exports.AttemptLog = AttemptLog;
