/**
 * 阿里云 OSS 工具
 *
 * 除客户端本身外，这里集中提供 ASR 音频对象的命名与清理能力：
 *  - 命名规则只允许出自 buildAudioObjectName：对象名散在各处手写迟早会漂移，
 *    而清理要靠前缀匹配，命名一旦不一致就会漏删；
 *  - 所有触网函数都接受可选 client 注入（单测传假 client，绝不联网），
 *    默认回落到模块内的 ossClient；
 *  - 清理类函数只 console.warn 不抛异常：清理失败绝不能影响主流程的返回值；
 *  - 批量删除只允许通过显式的 removeAudioObjectsFor / pruneAudioObjects 入口调用。
 *    转写主流程只允许删除"本次自己刚刚上传的那一个对象"（精确对象名）。
 */

const path = require('path');
const OSS = require('ali-oss');

const hasOssConfig = Boolean(
  process.env.OSS_ACCESS_KEY_ID &&
  process.env.OSS_ACCESS_KEY_SECRET &&
  process.env.OSS_BUCKET
);

let ossClient = null;
if (hasOssConfig) {
  ossClient = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET
  });
}

/** ASR 音频对象统一前缀：audio/{bvid}/{文件名} */
const AUDIO_OBJECT_PREFIX = 'audio/';
/** 显式批量清理的默认保留期（天）：只删早于该期限的对象 */
const DEFAULT_AUDIO_RETENTION_DAYS = 7;
/** list 单页请求条数上限 */
const LIST_PAGE_SIZE = 1000;
/** bvid 缺失时的兜底段，保证对象名仍落在 audio/ 前缀下、不会拼出双斜杠 */
const UNKNOWN_BVID = 'unknown';

/** bvid 统一兜底：空/未定义都归到 unknown，避免出现 audio//x.wav 这种脏名字 */
function normalizeBvid(bvid) {
  const raw = bvid === undefined || bvid === null ? '' : String(bvid).trim();
  return raw || UNKNOWN_BVID;
}

/**
 * 构造 ASR 音频的 OSS 对象名：audio/{bvid}/{文件名}
 * 命名规则集中在此，upload 与 delete 都用它，防止两边拼法不一致。
 */
function buildAudioObjectName(bvid, fileName) {
  const rawName = fileName === undefined || fileName === null ? '' : String(fileName).trim();
  // 传进来的可能是路径，取 basename 保证对象名里只有文件名（不含目录分隔符）
  const safeFileName = rawName ? path.basename(rawName) : 'unknown';
  return `${AUDIO_OBJECT_PREFIX}${normalizeBvid(bvid)}/${safeFileName}`;
}

/**
 * 删除单个 OSS 对象（安全包装）。
 * OSS 未配置 / 对象名为空 / SDK 抛错，一律只 warn 并返回 false，绝不抛异常——
 * 清理是收尾动作，失败不能反过来打断主流程。
 * @param {string} objectName - 精确对象名，禁止传前缀
 * @param {{client?: object}} [options]
 * @returns {Promise<boolean>} 是否真的删除了
 */
async function deleteOssObject(objectName, { client = ossClient } = {}) {
  if (!objectName || typeof objectName !== 'string') {
    console.warn('[OSS] 跳过删除：对象名为空');
    return false;
  }

  if (!client || typeof client.delete !== 'function') {
    console.warn(`[OSS] 跳过删除 ${objectName}: OSS 未配置`);
    return false;
  }

  try {
    await client.delete(objectName);
    return true;
  } catch (error) {
    console.warn(`[OSS] 删除对象失败 ${objectName}: ${error?.message || error}`);
    return false;
  }
}

/**
 * 分页列出指定前缀下的对象。
 * ali-oss 的 list 一次最多返回一页（LIST_PAGE_SIZE），必须靠 marker 翻页，
 * 只取第一页会漏掉大部分历史对象。注意 OSS 在未指定 delimiter 时可能不返回
 * nextMarker，此时退化为"用本页最后一个对象名当 marker"继续翻页。
 * 列举失败只 warn 并返回已收集到的部分，不抛异常。
 * @param {string} prefix - 对象名前缀
 * @param {{client?: object}} [options]
 * @returns {Promise<Array<{name: string, lastModified: string|Date, size: number}>>}
 */
async function listAudioObjects(prefix, { client = ossClient } = {}) {
  if (!client || typeof client.list !== 'function') {
    console.warn('[OSS] 跳过列举：OSS 未配置');
    return [];
  }

  const collected = [];
  let marker;

  try {
    while (true) {
      const response = await client.list({
        prefix,
        marker,
        'max-keys': LIST_PAGE_SIZE
      });

      const objects = Array.isArray(response?.objects) ? response.objects : [];
      for (const object of objects) {
        if (!object?.name) continue;
        collected.push({
          name: object.name,
          lastModified: object.lastModified,
          size: object.size
        });
      }

      const truncated = Boolean(response?.isTruncated || response?.truncated);
      if (!truncated) break;

      // 优先用服务端给的 nextMarker；没有就用本页最后一个对象名继续翻页
      marker = response?.nextMarker || objects[objects.length - 1]?.name;
      if (!marker) {
        console.warn(`[OSS] 列举标记为截断但没有可用 marker，停止翻页 prefix=${prefix}`);
        break;
      }
    }
  } catch (error) {
    console.warn(`[OSS] 列举对象失败 prefix=${prefix}: ${error?.message || error}`);
  }

  return collected;
}

/**
 * 删除某个 bvid 在 OSS 上的全部音频对象（audio/{bvid}/ 前缀）。
 * 只删列表中返回的精确对象名，返回成功删除的数量。
 * @param {string} bvid
 * @param {{client?: object}} [options]
 * @returns {Promise<number>} 成功删除的对象数
 */
async function removeAudioObjectsFor(bvid, { client = ossClient } = {}) {
  const prefix = `${AUDIO_OBJECT_PREFIX}${normalizeBvid(bvid)}/`;
  const objects = await listAudioObjects(prefix, { client });

  let removed = 0;
  for (const object of objects) {
    // 逐个按精确对象名删，不做"按前缀整段删"的批量操作，避免误伤边界
    const ok = await deleteOssObject(object.name, { client });
    if (ok) removed += 1;
  }

  return removed;
}

/**
 * 显式批量清理入口：删除超过保留期的音频对象。
 * 只删 lastModified 早于 now - olderThanDays 的对象；未过期的原样保留。
 * 本函数不会被任何主流程自动调用，需要手动执行（见 docs/DATA_LIFECYCLE.md）。
 * @param {{olderThanDays?: number, prefix?: string, client?: object}} [options]
 * @returns {Promise<{scanned: number, removed: number, failed: number}>}
 */
async function pruneAudioObjects({
  olderThanDays = DEFAULT_AUDIO_RETENTION_DAYS,
  prefix = AUDIO_OBJECT_PREFIX,
  client = ossClient
} = {}) {
  const stats = { scanned: 0, removed: 0, failed: 0 };

  const objects = await listAudioObjects(prefix, { client });
  stats.scanned = objects.length;

  const parsedDays = Number(olderThanDays);
  const retentionDays = Number.isFinite(parsedDays) && parsedDays >= 0
    ? parsedDays
    : DEFAULT_AUDIO_RETENTION_DAYS;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const object of objects) {
    const lastModifiedMs = object.lastModified ? new Date(object.lastModified).getTime() : NaN;
    if (!Number.isFinite(lastModifiedMs)) {
      // 拿不到修改时间就不敢删，计入 failed 让人能看见这些对象需要人工处理
      stats.failed += 1;
      continue;
    }

    if (lastModifiedMs >= cutoffMs) continue; // 未超过保留期，保留

    const ok = await deleteOssObject(object.name, { client });
    if (ok) stats.removed += 1;
    else stats.failed += 1;
  }

  console.log(
    `[OSS] 音频清理完成（保留期 ${retentionDays} 天，前缀 ${prefix}）: `
    + `扫描 ${stats.scanned}，删除 ${stats.removed}，失败 ${stats.failed}`
  );

  return stats;
}

module.exports = {
  hasOssConfig,
  ossClient,
  buildAudioObjectName,
  deleteOssObject,
  listAudioObjects,
  removeAudioObjectsFor,
  pruneAudioObjects,
  AUDIO_OBJECT_PREFIX,
  DEFAULT_AUDIO_RETENTION_DAYS
};
