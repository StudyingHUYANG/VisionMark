const { ApiError } = require('./errors');
const isBvid = value => typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value);
function bvid(value) {
  if (!isBvid(value)) throw new ApiError(400, 'INVALID_BVID', 'bvid 必须是合法的 BV 号');
  return value;
}
function text(value, name, max = 200, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new ApiError(400, 'INVALID_PARAMETER', `${name} 格式或长度不合法`);
  return value.trim();
}
function integer(value, name, fallback, max = 100) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw new ApiError(400, 'INVALID_PARAMETER', `${name} 必须为 1 至 ${max} 的整数`);
  return Number(value);
}
module.exports = { bvid, isBvid, text, integer };
