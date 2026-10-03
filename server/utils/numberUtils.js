'use strict';

/**
 * 数值归一化工具。
 *
 * 存在的唯一原因：Number(null) === 0 且 Number.isFinite(0) === true。
 * 所以 `Number.isFinite(Number(x))` 这种写法会把"调用方没传值（null）"
 * 误判成"传了 0"——在超时/时长类参数上，0 经 Math.max(1, …) 后变成 1ms，
 * 会让子命令瞬时超时，本该可达的兜底分支永远走不到（真实音频链路上已踩中过）。
 *
 * 统一改用 toPositiveNumber：只有能转成 > 0 的有限数才认，否则返回 null，
 * 把"未提供/非法"的判断权交还给调用方，由调用方决定各自的兜底语义。
 */

/**
 * 能转成正数就返回该数，否则返回 null。
 * null / undefined / '' / NaN / Infinity / <= 0 / 非数值 都视为"未提供"。
 * @param {*} value
 * @returns {number|null}
 */
function toPositiveNumber(value) {
  // 显式挡掉 null：Number(null) === 0 正是本模块要解决的坑
  if (value === null || value === undefined || value === '') return null;

  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

module.exports = { toPositiveNumber };
