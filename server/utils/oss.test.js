'use strict';

/**
 * OSS 工具测试：命名规则 / 安全删除 / 分页列举 / 批量清理
 *
 * 运行方式: node server/utils/oss.test.js
 *
 * 全程使用假 client（{ put, delete, list } 桩），不连真实 OSS、不读真实密钥。
 * 所有待测函数都支持传入 client，就是为了这些用例能在离线环境稳定跑。
 */

const {
  buildAudioObjectName,
  deleteOssObject,
  listAudioObjects,
  removeAudioObjectsFor,
  pruneAudioObjects,
  AUDIO_OBJECT_PREFIX,
  DEFAULT_AUDIO_RETENTION_DAYS
} = require('./oss');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(condition, label, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(actual, expected, label) {
  check(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (error) {
    failures.push(`${name} 抛出异常: ${error.stack || error.message}`);
    console.error(`  ✗ 抛出异常: ${error.stack || error.message}`);
  }
}

/** 临时接管 console.warn，返回 { value, warnings }，用于断言"只 warn 不抛" */
async function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

/**
 * 构造一个只认内存数组的假 client：
 *  - list 支持 marker / max-keys 语义（按 prefix 过滤，marker 表示从该名字之后继续）；
 *  - delete 记录调用，可对指定对象名抛错；
 *  - isTruncatedPageSize 可强制分页（null 表示单页返回全部）。
 */
function makeFakeClient({ objects = [], failDeleteFor = [], isTruncatedPageSize = null } = {}) {
  const calls = { list: [], del: [] };

  const client = {
    async list(query = {}) {
      calls.list.push(query);
      const prefix = query.prefix || '';
      let matched = objects.filter(object => object.name.startsWith(prefix));
      if (query.marker && typeof query.marker === 'string') {
        const markerIndex = matched.findIndex(object => object.name === query.marker);
        matched = markerIndex >= 0 ? matched.slice(markerIndex + 1) : matched;
      }

      if (isTruncatedPageSize && matched.length > isTruncatedPageSize) {
        const page = matched.slice(0, isTruncatedPageSize);
        return {
          objects: page,
          isTruncated: true,
          nextMarker: page[page.length - 1].name
        };
      }

      return { objects: matched, isTruncated: false, nextMarker: null };
    },

    async delete(name) {
      calls.del.push(name);
      if (failDeleteFor.includes(name)) {
        throw new Error(`DELETE_STUB:${name}`);
      }
      return {};
    }
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== OSS 工具测试 ==========');

  // --- 命名规则 ---
  await test('buildAudioObjectName：拼出 audio/{bvid}/{file}', async () => {
    equal(buildAudioObjectName('BV1abc', 'audio.wav'), 'audio/BV1abc/audio.wav', '常规 bvid + 文件名');
    equal(buildAudioObjectName('BV1abc', 'BV1abc.asr.mp3'), 'audio/BV1abc/BV1abc.asr.mp3', '压缩副本同样规则');
    equal(
      buildAudioObjectName('BV1abc', 'nested/audio.wav'),
      'audio/BV1abc/audio.wav',
      '传入路径时只取文件名，不把目录带进对象名'
    );
  });

  await test('buildAudioObjectName：bvid 缺失时兜底为 unknown', async () => {
    for (const missing of [undefined, null, '', '   ']) {
      equal(
        buildAudioObjectName(missing, 'audio.wav'),
        'audio/unknown/audio.wav',
        `bvid=${JSON.stringify(missing)} 兜底`
      );
    }
    equal(
      buildAudioObjectName('BV1abc', undefined),
      'audio/BV1abc/unknown',
      '文件名缺失也有兜底，不会出现结尾斜杠'
    );
    check(
      buildAudioObjectName(null, 'a.wav').startsWith(AUDIO_OBJECT_PREFIX),
      '兜底名字仍落在 audio/ 前缀下'
    );
  });

  // --- 单个对象安全删除 ---
  await test('deleteOssObject：正常时用精确对象名调用 delete', async () => {
    const { client, calls } = makeFakeClient();
    const ok = await deleteOssObject('audio/BV1/a.wav', { client });

    equal(ok, true, '删除成功返回 true');
    equal(calls.del.length, 1, '恰好调用一次 delete');
    equal(calls.del[0], 'audio/BV1/a.wav', '传入的是精确对象名');
  });

  await test('deleteOssObject：client 抛错时不抛异常、返回 false、有 warn', async () => {
    const { client, calls } = makeFakeClient({ failDeleteFor: ['audio/BV1/a.wav'] });

    const { value, warnings } = await captureWarn(() => deleteOssObject('audio/BV1/a.wav', { client }));

    equal(value, false, '失败返回 false 而不是抛异常');
    equal(calls.del.length, 1, '确实尝试过删除');
    check(warnings.length > 0, '至少输出一条 warn');
    check(
      warnings.some(line => line.includes('audio/BV1/a.wav') && line.includes('DELETE_STUB')),
      'warn 里带上对象名和失败原因',
      JSON.stringify(warnings)
    );
  });

  await test('deleteOssObject：未配置 client 时只 warn', async () => {
    const { value, warnings } = await captureWarn(() => deleteOssObject('audio/BV1/a.wav', { client: null }));

    equal(value, false, '未配置返回 false');
    check(warnings.some(line => line.includes('未配置')), 'warn 说明 OSS 未配置', JSON.stringify(warnings));
  });

  await test('deleteOssObject：对象名为空时只 warn、不调用 delete', async () => {
    const { client, calls } = makeFakeClient();
    const { value, warnings } = await captureWarn(() => deleteOssObject('', { client }));

    equal(value, false, '空对象名返回 false');
    equal(calls.del.length, 0, '没有对空名字发起删除');
    check(warnings.length > 0, '有 warn');
  });

  // --- 分页列举 ---
  await test('listAudioObjects：marker 翻页，两页都收集', async () => {
    const pageOne = {
      objects: [{ name: 'audio/BV1/a.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 10 }],
      isTruncated: true,
      nextMarker: 'audio/BV1/a.wav'
    };
    const pageTwo = {
      objects: [{ name: 'audio/BV1/b.wav', lastModified: '2026-09-02T00:00:00.000Z', size: 20 }],
      isTruncated: false,
      nextMarker: null
    };
    const listCalls = [];
    const client = {
      async list(query) {
        listCalls.push(query);
        return listCalls.length === 1 ? pageOne : pageTwo;
      }
    };

    const result = await listAudioObjects('audio/', { client });

    equal(listCalls.length, 2, '共请求两页');
    equal(listCalls[0].marker, undefined, '第一页不带 marker');
    equal(listCalls[1].marker, 'audio/BV1/a.wav', '第二页带上服务端返回的 nextMarker');
    equal(listCalls[0]['max-keys'], 1000, '每页带上 max-keys');
    equal(result.length, 2, '两页对象都被收集');
    equal(result[0].name, 'audio/BV1/a.wav', '保持服务端顺序（第一页）');
    equal(result[1].name, 'audio/BV1/b.wav', '保持服务端顺序（第二页）');
    equal(result[1].size, 20, '保留 size 字段');
  });

  await test('listAudioObjects：没有 nextMarker 时用本页最后一个对象名继续翻页', async () => {
    const listCalls = [];
    const client = {
      async list(query) {
        listCalls.push(query);
        if (listCalls.length === 1) {
          return {
            objects: [{ name: 'audio/BV1/a.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 1 }],
            isTruncated: true,
            nextMarker: null
          };
        }
        return { objects: [], isTruncated: false, nextMarker: null };
      }
    };

    const result = await listAudioObjects('audio/', { client });

    equal(result.length, 1, '收集到第一页对象');
    equal(listCalls.length, 2, '继续翻了第二页');
    equal(listCalls[1].marker, 'audio/BV1/a.wav', '退化 marker 用的是本页最后一个对象名');
  });

  await test('listAudioObjects：标记截断但无可用 marker 时终止，不无限循环', async () => {
    const listCalls = [];
    const client = {
      async list(query) {
        listCalls.push(query);
        return { objects: [], isTruncated: true, nextMarker: null };
      }
    };

    const result = await listAudioObjects('audio/', { client });

    equal(result.length, 0, '没有对象');
    equal(listCalls.length, 1, '只请求一次就停手');
  });

  await test('listAudioObjects：未配置 client 时返回空数组且只 warn', async () => {
    const { value, warnings } = await captureWarn(() => listAudioObjects('audio/', { client: null }));

    equal(Array.isArray(value), true, '返回数组而不是抛异常');
    equal(value.length, 0, '空数组');
    check(warnings.some(line => line.includes('未配置')), 'warn 说明未配置', JSON.stringify(warnings));
  });

  // --- 按 bvid 清理 ---
  await test('removeAudioObjectsFor：只删该 bvid 的对象，别的 bvid 不动', async () => {
    const objects = [
      { name: 'audio/BV1/a.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 1 },
      { name: 'audio/BV1/b.asr.mp3', lastModified: '2026-09-01T00:00:00.000Z', size: 2 },
      { name: 'audio/BV2/c.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 3 },
      // BV10 以 BV1 开头，前缀拼接必须带斜杠才不会被误伤
      { name: 'audio/BV10/d.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 4 }
    ];
    const { client, calls } = makeFakeClient({ objects });

    const removed = await removeAudioObjectsFor('BV1', { client });

    equal(removed, 2, '删除了 2 个对象');
    equal(calls.del.length, 2, '恰好发起两次 delete');
    check(calls.del.includes('audio/BV1/a.wav'), '删掉 a.wav');
    check(calls.del.includes('audio/BV1/b.asr.mp3'), '删掉 b.asr.mp3');
    check(!calls.del.includes('audio/BV2/c.wav'), '没有碰 BV2 的对象');
    check(!calls.del.includes('audio/BV10/d.wav'), '没有碰 BV10（前缀边界正确）');
    equal(calls.list[0].prefix, 'audio/BV1/', '列举前缀带斜杠收尾');
  });

  await test('removeAudioObjectsFor：单个删除失败不影响其它对象，计数只算成功', async () => {
    const objects = [
      { name: 'audio/BV1/a.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 1 },
      { name: 'audio/BV1/b.wav', lastModified: '2026-09-01T00:00:00.000Z', size: 2 }
    ];
    const { client, calls } = makeFakeClient({ objects, failDeleteFor: ['audio/BV1/a.wav'] });

    const { value } = await captureWarn(() => removeAudioObjectsFor('BV1', { client }));

    equal(value, 1, '只统计成功删除的数量');
    equal(calls.del.length, 2, '失败一个后仍然继续处理下一个');
  });

  // --- 显式批量清理 ---
  await test('pruneAudioObjects：只删超过保留期的对象，未过期的不动', async () => {
    const now = Date.now();
    const objects = [
      { name: 'audio/old1.wav', lastModified: new Date(now - 30 * DAY_MS), size: 1 },
      { name: 'audio/old2.wav', lastModified: new Date(now - 8 * DAY_MS), size: 2 },
      { name: 'audio/fresh.wav', lastModified: new Date(now - 1 * DAY_MS), size: 3 }
    ];
    const { client, calls } = makeFakeClient({ objects });

    const stats = await pruneAudioObjects({ client });

    equal(stats.scanned, 3, '扫描到 3 个对象');
    equal(stats.removed, 2, '删除了 2 个过期对象');
    equal(stats.failed, 0, '没有失败');
    equal(calls.del.length, 2, '发起两次 delete');
    check(calls.del.includes('audio/old1.wav'), '30 天前的老对象被删');
    check(calls.del.includes('audio/old2.wav'), '8 天前（超过默认 7 天）的对象被删');
    check(!calls.del.includes('audio/fresh.wav'), '1 天前的对象保留');
    equal(calls.list[0].prefix, 'audio/', '默认前缀为 audio/');
    equal(DEFAULT_AUDIO_RETENTION_DAYS, 7, '默认保留期 7 天');
  });

  await test('pruneAudioObjects：单个删除失败计入 failed 且不影响其它对象', async () => {
    const now = Date.now();
    const objects = [
      { name: 'audio/old1.wav', lastModified: new Date(now - 30 * DAY_MS), size: 1 },
      { name: 'audio/old2.wav', lastModified: new Date(now - 30 * DAY_MS), size: 2 },
      { name: 'audio/old3.wav', lastModified: new Date(now - 30 * DAY_MS), size: 3 }
    ];
    const { client, calls } = makeFakeClient({ objects, failDeleteFor: ['audio/old2.wav'] });

    const { value: stats } = await captureWarn(() => pruneAudioObjects({ client }));

    equal(stats.scanned, 3, '扫描 3 个');
    equal(stats.removed, 2, '成功删除 2 个');
    equal(stats.failed, 1, '失败 1 个计入 failed');
    equal(calls.del.length, 3, '失败后仍继续处理剩余对象');
    check(calls.del.includes('audio/old3.wav'), '排在被删对象后面的对象也处理了');
  });

  await test('pruneAudioObjects：保留期与前缀可配置', async () => {
    const now = Date.now();
    const objects = [
      { name: 'audio/x.wav', lastModified: new Date(now - 2 * DAY_MS), size: 1 },
      { name: 'other/y.wav', lastModified: new Date(now - 30 * DAY_MS), size: 2 }
    ];
    const { client, calls } = makeFakeClient({ objects });

    const stats = await pruneAudioObjects({ olderThanDays: 1, prefix: 'other/', client });

    equal(stats.scanned, 1, '只扫 other/ 前缀');
    equal(stats.removed, 1, '按自定义保留期删除了过期对象');
    equal(calls.del[0], 'other/y.wav', '删的是指定前缀下的对象');
  });

  await test('pruneAudioObjects：lastModified 缺失时不删除并计入 failed', async () => {
    const objects = [
      { name: 'audio/unknown-time.wav', lastModified: null, size: 1 },
      { name: 'audio/old.wav', lastModified: new Date(Date.now() - 30 * DAY_MS), size: 2 }
    ];
    const { client, calls } = makeFakeClient({ objects });

    const { value: stats } = await captureWarn(() => pruneAudioObjects({ client }));

    equal(stats.scanned, 2, '扫描 2 个');
    equal(stats.removed, 1, '只删能判定过期的那个');
    equal(stats.failed, 1, '时间未知的计入 failed');
    check(!calls.del.includes('audio/unknown-time.wav'), '时间未知的对象绝不删');
  });

  await test('pruneAudioObjects：分页场景下统计跨页累计', async () => {
    const now = Date.now();
    const objects = [
      { name: 'audio/a.wav', lastModified: new Date(now - 30 * DAY_MS), size: 1 },
      { name: 'audio/b.wav', lastModified: new Date(now - 30 * DAY_MS), size: 2 },
      { name: 'audio/c.wav', lastModified: new Date(now - 30 * DAY_MS), size: 3 }
    ];
    const { client, calls } = makeFakeClient({ objects, isTruncatedPageSize: 2 });

    const stats = await pruneAudioObjects({ client });

    equal(calls.list.length, 2, '翻了两页');
    equal(stats.scanned, 3, '跨页统计扫描数');
    equal(stats.removed, 3, '跨页删除');
  });

  // --- 汇总 ---
  console.log('\n========== 测试结果 ==========');
  console.log(`通过断言: ${passed}`);
  console.log(`失败项: ${failures.length}`);
  if (failures.length > 0) {
    console.error('\n失败明细:');
    failures.forEach(item => console.error(`  - ${item}`));
    process.exitCode = 1;
    return;
  }
  console.log('全部通过 ✓');
}

main().catch(error => {
  console.error('测试运行失败:', error);
  process.exitCode = 1;
});
