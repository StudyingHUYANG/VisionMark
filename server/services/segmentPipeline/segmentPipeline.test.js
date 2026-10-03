'use strict';

/**
 * segmentPipeline（index.js）端到端单测
 *
 * 运行方式: node server/services/segmentPipeline/segmentPipeline.test.js
 *
 * 钉住的行为：
 *  ① 脏输入不抛错：null / 字符串 / 缺 duration / 检测器数组里混入非法时间，
 *     返回体形状完整（mode / confidence / duration / candidateCuts / segments / debug）
 *  ② 阶段抛错被降级：candidateCutFusion / segmentValidator 抛错时
 *     返回体形状完整，debug.warnings 出现对应前缀
 *  ③ debug 写盘失败不影响返回（artifactPaths 为空数组）
 *  ④ 同一份输入连跑两次，segments 的 segmentId 序列完全一致
 *  ⑤ 测试产生的 server/debug/segment-pipeline/ 产物在结束时清理
 *
 * 用 require.cache 注入抛错桩：必须在 require('../segmentPipeline') 之前写入，
 * 因为 index.js 在模块加载时就把依赖解构到了闭包里。
 */

const fs = require('fs');
const path = require('path');

// 先加载真实模块拿到调试目录常量，随后才允许被桩替换
const { DEBUG_DIR } = require('./debugArtifactWriter');

const INDEX_PATH = require.resolve('../segmentPipeline');
const FUSION_PATH = require.resolve('./candidateCutFusion');
const VALIDATOR_PATH = require.resolve('./segmentValidator');
const WRITER_PATH = require.resolve('./debugArtifactWriter');

// ---------------------------------------------------------------------------
// 断言与测试框架（沿用 segmentContract.test.js 的脚手架）
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

// ---------------------------------------------------------------------------
// require.cache 桩加载
// ---------------------------------------------------------------------------

function makeFakeModule(filename, exportsObject) {
  return {
    id: filename,
    filename,
    loaded: true,
    exports: exportsObject,
    children: [],
    paths: []
  };
}

/**
 * 加载一份 index.js：可把指定依赖替换成桩，且每次装载不受上一次缓存影响。
 * 返回 runSegmentPipeline；桩在装载完成后立刻还原，已装载模块闭包内仍持有桩引用。
 */
function loadPipeline(stubs = {}) {
  const originals = new Map();
  for (const [modulePath, stubExports] of Object.entries(stubs)) {
    originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = makeFakeModule(modulePath, stubExports);
  }

  let runSegmentPipeline;
  try {
    delete require.cache[INDEX_PATH];
    ({ runSegmentPipeline } = require('../segmentPipeline'));
  } finally {
    for (const [modulePath, original] of originals) {
      if (original === undefined) delete require.cache[modulePath];
      else require.cache[modulePath] = original;
    }
    delete require.cache[INDEX_PATH];
  }

  return runSegmentPipeline;
}

function checkShape(result, label) {
  check(result && typeof result === 'object', `${label} 返回对象`);
  check(typeof result.mode === 'string' && result.mode.length > 0, `${label} mode 是非空字符串`,
    `实际 ${JSON.stringify(result.mode)}`);
  check(['high', 'medium', 'low'].includes(result.confidence), `${label} confidence 合法`,
    `实际 ${JSON.stringify(result.confidence)}`);
  check(typeof result.duration === 'number' && Number.isFinite(result.duration), `${label} duration 是有限数字`,
    `实际 ${JSON.stringify(result.duration)}`);
  check(Array.isArray(result.candidateCuts), `${label} candidateCuts 是数组`);
  check(Array.isArray(result.segments), `${label} segments 是数组`);
  check(result.debug && typeof result.debug === 'object', `${label} debug 是对象`);
  check(Array.isArray(result.debug?.warnings), `${label} debug.warnings 是数组`);
  check(Array.isArray(result.debug?.artifactPaths), `${label} debug.artifactPaths 是数组`);
  check(typeof result.debug?.usedAI === 'boolean', `${label} debug.usedAI 是布尔值`);
}

// ---------------------------------------------------------------------------
// 调试产物清理
// ---------------------------------------------------------------------------

const artifactsBefore = new Set(fs.existsSync(DEBUG_DIR) ? fs.readdirSync(DEBUG_DIR) : []);
const startedAt = Date.now();
/** 由 debug.artifactPaths 精确记录的本轮产物，清理时只删这些 */
const createdArtifacts = new Set();

function recordArtifacts(result) {
  for (const artifactPath of result?.debug?.artifactPaths || []) {
    if (path.dirname(artifactPath) === DEBUG_DIR) createdArtifacts.add(artifactPath);
  }
}

/** 只删除「本轮测试新建」的产物，避免误删目录里已有的文件 */
function cleanupArtifacts() {
  if (!fs.existsSync(DEBUG_DIR)) return 0;

  let removed = 0;
  for (const filePath of createdArtifacts) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed += 1;
    }
  }

  // 兜底：极少数未被记录到 artifactPaths 的测试产物（按测试专用 id 前缀 + 时间戳判断）
  for (const file of fs.readdirSync(DEBUG_DIR)) {
    if (artifactsBefore.has(file)) continue;
    const isTestArtifact = file.startsWith('BV_SEG_PIPELINE_TEST') // 含 BV_SEG_PIPELINE_TEST_DIRTY
      || file.startsWith('unknown-'); // null / 字符串等无 id 输入落到的前缀
    if (!isTestArtifact) continue;
    const filePath = path.join(DEBUG_DIR, file);
    if (createdArtifacts.has(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < startedAt - 1000) continue; // 早于本轮开始，不是本轮产物
    fs.unlinkSync(filePath);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 测试素材
// ---------------------------------------------------------------------------

const STABLE_INPUT = {
  videoId: 'BV_SEG_PIPELINE_TEST',
  bvid: 'BV_SEG_PIPELINE_TEST',
  duration: 180,
  visualCuts: [
    { time: 44, score: 0.82, reasons: ['visual_change'] },
    { time: 118, score: 0.68, reasons: ['scene_change'] }
  ],
  audioCuts: [{ time: 47, score: 0.7, reasons: ['audio_pause'] }],
  keywordCuts: [{ time: 122, score: 0.9, reasons: ['keyword:总结一下'], keyword: '总结一下' }],
  transcript: [
    { start: 3, end: 3, text: '大家好，今天我们先介绍项目背景。', hasTimestamp: true },
    { start: 122, end: 122, text: '总结一下，主要结论是这样的。', hasTimestamp: true }
  ]
};

const DIRTY_INPUTS = [
  ['null 输入', null],
  ['字符串输入', '这不是一个对象'],
  ['数组输入', [1, 2, 3]],
  ['缺 duration', { bvid: 'BV_SEG_PIPELINE_TEST_DIRTY', transcript: [] }],
  ['检测器数组混入非法时间', {
    videoId: 'BV_SEG_PIPELINE_TEST',
    bvid: 'BV_SEG_PIPELINE_TEST',
    duration: 60,
    visualCuts: [{ time: '不是时间', score: 0.8 }, { time: -3, score: 0.8 }, { time: 999, score: 0.8 }],
    audioCuts: [{ time: null, score: 0.5 }],
    keywordCuts: '不是数组',
    transcript: 42,
    frames: '不是数组'
  }]
];

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  try {
    await test('① 脏输入不抛错且返回体形状完整', async () => {
      const runSegmentPipeline = loadPipeline();

      for (const [label, input] of DIRTY_INPUTS) {
        let result;
        try {
          result = await runSegmentPipeline(input);
        } catch (error) {
          check(false, `${label} 不抛异常`, error.message);
          continue;
        }
        checkShape(result, label);
        recordArtifacts(result);
      }

      // 非法时间确实被证据层标记为非法，而不是静默丢弃
      const dirty = await runSegmentPipeline(DIRTY_INPUTS[4][1]);
      recordArtifacts(dirty);
      check(dirty.debug.warnings.some(warning => warning.startsWith('invalid_events_unparsable_time:')),
        '不可解析时间留下 invalid_events_unparsable_time 警告');
      check(dirty.debug.warnings.some(warning => warning.startsWith('invalid_events_negative_time:')),
        '负数时间留下 invalid_events_negative_time 警告');
      check(dirty.debug.warnings.some(warning => warning.startsWith('invalid_events_beyond_duration:')),
        '超界时间留下 invalid_events_beyond_duration 警告');
    });

    await test('② 阶段抛错被降级：candidateCutFusion 抛错', async () => {
      const runSegmentPipeline = loadPipeline({
        [FUSION_PATH]: {
          generateCandidateCuts: () => {
            throw new Error('fusion_boom');
          }
        }
      });

      let result;
      try {
        result = await runSegmentPipeline({ bvid: 'BV_SEG_PIPELINE_TEST', duration: 60, transcript: [] });
      } catch (error) {
        check(false, '融合阶段抛错时不向上抛', error.message);
        return;
      }
      checkShape(result, '融合抛错');
      recordArtifacts(result);
      check(result.debug.warnings.some(warning => warning.startsWith('candidate_cut_fusion_failed:')),
        'debug.warnings 出现 candidate_cut_fusion_failed: 前缀',
        JSON.stringify(result.debug.warnings));
      equal(JSON.stringify(result.candidateCuts), JSON.stringify([]), '融合失败时候选切点为空数组');
    });

    await test('② 阶段抛错被降级：segmentValidator 抛错', async () => {
      const runSegmentPipeline = loadPipeline({
        [VALIDATOR_PATH]: {
          validateSegments: () => {
            throw new Error('validator_boom');
          },
          // segmentContract 在装载时会读这些常量，桩必须保留最小导出面
          ADOPTED_TOLERANCE_SECONDS: 5,
          NO_CANDIDATE_CUT_REASON: 'no_candidate_cut_matched',
          formatClock: () => '00:00',
          VALID_TYPES: new Set(),
          VALID_CONFIDENCE: new Set()
        }
      });

      let result;
      try {
        result = await runSegmentPipeline({ bvid: 'BV_SEG_PIPELINE_TEST', duration: 60, transcript: [] });
      } catch (error) {
        check(false, '校验阶段抛错时不向上抛', error.message);
        return;
      }
      checkShape(result, '校验抛错');
      recordArtifacts(result);
      check(result.debug.warnings.some(warning => warning.startsWith('segment_validation_failed:')),
        'debug.warnings 出现 segment_validation_failed: 前缀',
        JSON.stringify(result.debug.warnings));
      equal(JSON.stringify(result.segments), JSON.stringify([]), '校验失败时 segments 为空数组');
    });

    await test('③ debug 写盘失败不影响返回', async () => {
      const runSegmentPipeline = loadPipeline({
        [WRITER_PATH]: {
          writeDebugArtifacts: () => {
            throw new Error('disk_boom');
          }
        }
      });

      let result;
      try {
        result = await runSegmentPipeline({ bvid: 'BV_SEG_PIPELINE_TEST', duration: 60, transcript: [] });
      } catch (error) {
        check(false, '写盘抛错时不向上抛', error.message);
        return;
      }
      checkShape(result, '写盘失败');
      recordArtifacts(result);
      equal(JSON.stringify(result.debug.artifactPaths), JSON.stringify([]), '写盘失败时 artifactPaths 为空数组');
      check(result.debug.warnings.some(warning => warning.startsWith('debug_artifact_write_failed:')),
        'debug.warnings 出现 debug_artifact_write_failed: 前缀',
        JSON.stringify(result.debug.warnings));
    });

    await test('④ 同一份输入连跑两次：segmentId 序列完全一致', async () => {
      const runSegmentPipeline = loadPipeline();

      const first = await runSegmentPipeline(STABLE_INPUT);
      const second = await runSegmentPipeline(STABLE_INPUT);
      recordArtifacts(first);
      recordArtifacts(second);

      check(first.segments.length > 0, '产出片段');
      equal(
        JSON.stringify(first.segments.map(segment => segment.segmentId)),
        JSON.stringify(second.segments.map(segment => segment.segmentId)),
        '两次运行 segmentId 序列完全一致'
      );
      equal(
        JSON.stringify(first.candidateCuts.map(cut => [cut.time, cut.score, cut.sources])),
        JSON.stringify(second.candidateCuts.map(cut => [cut.time, cut.score, cut.sources])),
        '两次运行候选切点一致'
      );
      equal(first.debug.usedAI, false, '无模型客户端时走降级路径');

      // 调试产物确实落在约定目录里，且每次运行一份
      equal(first.debug.artifactPaths.length, 1, '第一次运行写出 1 份调试产物');
      equal(second.debug.artifactPaths.length, 1, '第二次运行写出 1 份调试产物');
      check(first.debug.artifactPaths[0].startsWith(path.join(DEBUG_DIR, 'BV_SEG_PIPELINE_TEST-')),
        '产物文件名以 videoId 前缀开头', first.debug.artifactPaths[0]);
      check(fs.existsSync(first.debug.artifactPaths[0]), '产物文件真实存在');
    });
  } finally {
    const removed = cleanupArtifacts();
    console.log(`\n清理本轮测试调试产物: ${removed} 个`);
    check(createdArtifacts.size > 0, '本轮确实产生了调试产物（清理用例有效）');
    check([...createdArtifacts].every(filePath => !fs.existsSync(filePath)), '本轮产物全部删除，无残留');
  }

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
