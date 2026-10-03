'use strict';

/**
 * evidenceBuilder 单测（纯函数：无网络、无模型、无 ffmpeg、无写盘）
 *
 * 运行方式: node server/services/segmentPipeline/evidenceBuilder.test.js
 *
 * 钉住的行为：
 *  ① 原始事件全保留：非法时间只打 valid=false / invalidReason，不静默丢弃，
 *     并产出 invalid_events_<reason>:<n> 警告
 *  ② 聚类锚点固定为簇首事件，簇跨度恒 <= CLUSTER_WINDOW_SECONDS
 *  ③ 簇的 sourceCount = 不同来源数（不是成员数），perSourceCounts 按来源计数
 *  ④ 转录归一化：数字/MM:SS/HH:MM:SS/全角冒号/方括号；字符串输入与数组输入等价
 *  ⑤ normalizeFrameTimes 四种形态（数字 / {time} / {timestamp} / {timestampMs}）+
 *     去重 + 升序 + 剔除负数与非法值
 *  ⑥ 无时间戳的行：归一化时 start 仍是数组下标（行号），但绝不参与 transcriptSnippet
 *     取文本；部分行缺时间戳时告警 transcript_partially_missing_timestamps:<n>
 *  ⑦ normalizeFrameTimes 把 null / undefined / 空字符串视为缺失值剔除，
 *     但 time:0 是合法帧时间（视频起点），必须保留
 *  ⑧ 端到端：含无时间戳行的 transcript 不会污染契约 segments[].description
 *  ⑨ normalizeTranscript 幂等：对已归一化数组再归一化结果逐字段不变，占位行号（hasTimestamp=false）
 *     不会被洗白成真时间戳；transcriptSnippet 对二次归一化输入仍不取无时间戳的行
 *  ⑩ 记录现状（非期望）：transcriptText 对无时间戳行仍渲染为 [0:00]/[0:01]；
 *     normalizeFrameTimes 对布尔值仍按 Number(true)===1 收下
 */

const {
  buildEvidence,
  clusterEvents,
  buildDetectorEvents,
  normalizeTranscript,
  normalizeFrameTimes,
  parseTimeToSeconds,
  transcriptSnippet,
  CLUSTER_WINDOW_SECONDS
} = require('./evidenceBuilder');

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

function eventOf(events, source) {
  return events.find(event => event.source === source);
}

const INDEX_PATH = require.resolve('./index');
const WRITER_PATH = require.resolve('./debugArtifactWriter');

/**
 * 装载一份 segmentPipeline，并把调试产物写盘替换成空实现（本文件保持「不写盘」）。
 * index.js 在模块加载时就把 writeDebugArtifacts 解构进闭包，桩必须在 require 前放进缓存；
 * 装载完成后立刻还原缓存，已装载模块的闭包仍持有桩引用（与 segmentPipeline.test.js 同法）。
 */
function loadPipelineWithoutDiskWrite() {
  const originalWriter = require.cache[WRITER_PATH];
  require.cache[WRITER_PATH] = {
    id: WRITER_PATH,
    filename: WRITER_PATH,
    loaded: true,
    exports: { writeDebugArtifacts: () => ({ artifactPaths: [], warnings: [] }) },
    children: [],
    paths: []
  };

  try {
    delete require.cache[INDEX_PATH];
    return require('./index').runSegmentPipeline;
  } finally {
    if (originalWriter === undefined) delete require.cache[WRITER_PATH];
    else require.cache[WRITER_PATH] = originalWriter;
    delete require.cache[INDEX_PATH];
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  await test('① 原始事件全保留：非法时间只标记、不丢弃', () => {
    const unparsable = { time: '不是时间', score: 0.5, reasons: ['visual_change'] };
    const negative = { time: -5, score: 0.5, reasons: ['audio_pause'] };
    const beyond = { time: 500, score: 0.5, reasons: ['keyword:总结'] };

    const evidence = buildEvidence({
      duration: 100,
      visualCuts: [unparsable],
      audioCuts: [negative],
      keywordCuts: [beyond]
    });

    equal(evidence.events.length, 3, '三个非法事件仍全部保留在 events 里');

    const visualEvent = eventOf(evidence.events, 'visual');
    const audioEvent = eventOf(evidence.events, 'audio');
    const keywordEvent = eventOf(evidence.events, 'keyword');

    equal(visualEvent.valid, false, '不可解析时间 → valid=false');
    equal(visualEvent.invalidReason, 'unparsable_time', '不可解析时间 → unparsable_time');
    equal(visualEvent.time, null, '不可解析时间 → time=null（不静默变 0）');
    equal(visualEvent.rawTime, '不是时间', '原始时间戳原样保留在 rawTime');
    equal(visualEvent.raw, unparsable, '原始输入对象按引用保留在 raw');
    equal(visualEvent.score, 0.5, '非法时间里分数仍保留');

    equal(audioEvent.valid, false, '负数时间 → valid=false');
    equal(audioEvent.invalidReason, 'negative_time', '负数时间 → negative_time');
    equal(audioEvent.time, -5, '负数时间原样保留（不被截断为 0）');

    equal(keywordEvent.valid, false, '超出 duration → valid=false');
    equal(keywordEvent.invalidReason, 'beyond_duration', '超出 duration → beyond_duration');
    equal(keywordEvent.time, 500, '超界时间原样保留');

    check(evidence.warnings.includes('invalid_events_unparsable_time:1'), '警告 invalid_events_unparsable_time:1');
    check(evidence.warnings.includes('invalid_events_negative_time:1'), '警告 invalid_events_negative_time:1');
    check(evidence.warnings.includes('invalid_events_beyond_duration:1'), '警告 invalid_events_beyond_duration:1');

    equal(evidence.clusters.length, 0, '非法事件不进入聚类');

    // 旧链路视图（供 candidateCutFusion 等消费）才做过滤，并留下 dropped 警告
    equal(evidence.visualCuts.length, 0, '合法视图剔除非法 visual 切点');
    check(evidence.warnings.includes('dropped_invalid_visual_cuts:1'), '旧视图丢弃有警告');

    // duration 缺失时不把超界事件判为 beyond_duration（没有可比较的时长）
    const noDuration = buildEvidence({ visualCuts: [{ time: 500 }] });
    equal(noDuration.events[0].invalidReason, null, 'duration=0 时不判 beyond_duration');
    equal(noDuration.events[0].valid, true, 'duration 未知时 500 秒仍是合法事件');
  });

  await test('② 聚类锚点固定：0 / 2.9 / 5.7 得到两个簇，跨度不超过窗口', () => {
    const evidence = buildEvidence({
      duration: 100,
      visualCuts: [{ time: 0, score: 0.6 }, { time: 2.9, score: 0.6 }, { time: 5.7, score: 0.6 }]
    });

    equal(evidence.events.length, 3, '三个事件都在');
    equal(evidence.clusters.length, 2, '固定锚点聚类得到两个簇（不是单链连成一个大簇）');
    equal(evidence.clusterWindowSeconds, CLUSTER_WINDOW_SECONDS, '窗口常量为 3 秒');

    const [first, second] = evidence.clusters;
    equal(first.memberCount, 2, '第一个簇含 0 与 2.9');
    equal(first.start, 0, '第一个簇起点 0');
    equal(first.end, 2.9, '第一个簇终点 2.9');
    equal(first.span, 2.9, '第一个簇跨度 2.9');
    equal(first.anchorTime, 0, '锚点恒为簇首事件时间');
    equal(second.memberCount, 1, '5.7 与锚点 0 相差 5.7 > 3，另成一簇');
    equal(second.start, 5.7, '第二个簇起点 5.7');
    equal(second.span, 0, '单成员簇跨度 0');

    for (const cluster of evidence.clusters) {
      check(cluster.span <= CLUSTER_WINDOW_SECONDS, `簇跨度 ${cluster.span} <= ${CLUSTER_WINDOW_SECONDS}`,
        `实际 ${cluster.span}`);
    }

    // 直接调 clusterEvents：输入顺序打乱后输出必须逐字段一致
    const events = buildDetectorEvents({
      duration: 100,
      visualCuts: [{ time: 0, score: 0.6 }, { time: 2.9, score: 0.6 }, { time: 5.7, score: 0.6 }]
    }, 100);
    const forward = clusterEvents(events, CLUSTER_WINDOW_SECONDS);
    const reversed = clusterEvents(events.slice().reverse(), CLUSTER_WINDOW_SECONDS);
    equal(JSON.stringify(reversed), JSON.stringify(forward), '簇输出与输入事件顺序无关');
  });

  await test('③ sourceCount 等于不同来源数、perSourceCounts 计数正确', () => {
    const evidence = buildEvidence({
      duration: 100,
      visualCuts: [{ time: 10, score: 0.6 }, { time: 11.5, score: 0.5 }],
      audioCuts: [{ time: 12.5, score: 0.7 }]
    });

    equal(evidence.clusters.length, 1, '三个事件落在同一窗口 → 一个簇');
    const cluster = evidence.clusters[0];
    equal(cluster.memberCount, 3, '成员数是 3');
    equal(cluster.sourceCount, 2, 'sourceCount 是不同来源数 2，不是成员数 3');
    equal(JSON.stringify(cluster.sources), JSON.stringify(['visual', 'audio']), 'sources 按固定优先级排序');
    equal(cluster.perSourceCounts.visual, 2, 'perSourceCounts.visual = 2');
    equal(cluster.perSourceCounts.audio, 1, 'perSourceCounts.audio = 1');
    equal(cluster.perSourceCounts.keyword, undefined, '没有 keyword 来源');

    // 簇内成员的 id 由来源+原始序号构成，可回溯
    const visualMembers = cluster.members.filter(member => member.source === 'visual');
    equal(JSON.stringify(visualMembers.map(member => member.id)), JSON.stringify(['visual#0', 'visual#1']),
      '成员 id 保留原始序号');
  });

  await test('④ 转录归一化：多种时间格式与字符串/数组等价', () => {
    equal(parseTimeToSeconds('[0:03]'), 3, '[0:03] → 3 秒');
    equal(parseTimeToSeconds('[01:02:03]'), 3723, '[01:02:03] → 3723 秒');
    equal(parseTimeToSeconds('[0：03]'), 3, '全角冒号 [0：03] → 3 秒');
    equal(parseTimeToSeconds('2:30'), 150, '裸 MM:SS 也能解析');
    equal(parseTimeToSeconds('不是时间'), null, '不可解析返回 null，不返回 0');
    equal(parseTimeToSeconds('-1:00'), null, '负数分段不可解析');
    equal(parseTimeToSeconds('[0:03:04:05]'), null, '四段不可解析');

    const lines = [
      '[0:03] 第一行',
      '[01:02:03] 第二行',
      '[0：03] 第三行'
    ];
    const fromString = normalizeTranscript(lines.join('\n'));
    const fromArray = normalizeTranscript(lines.slice());

    equal(JSON.stringify(fromString), JSON.stringify(fromArray), '字符串输入与数组输入结果等价');
    equal(fromString.length, 3, '三行都解析成功');
    const byText = text => fromString.find(row => row.text === text);
    equal(byText('第一行').start, 3, '[0:03] start=3');
    equal(byText('第二行').start, 3723, '[01:02:03] start=3723');
    equal(byText('第三行').start, 3, '全角冒号 [0：03] start=3');
    equal(JSON.stringify(fromString.map(row => row.start)), JSON.stringify([3, 3, 3723]),
      '输出按 start 升序排列');
    check(fromString.every(row => row.hasTimestamp === true), '三行 hasTimestamp 均为 true');
    equal(byText('第一行').text, '第一行', '文本去掉时间标记');
    equal(byText('第一行').end, byText('第一行').start, '单点时间戳 end=start');

    const untimed = normalizeTranscript(['没有时间戳的一行']);
    equal(untimed.length, 1, '无时间戳的行仍保留');
    equal(untimed[0].hasTimestamp, false, '无时间戳 → hasTimestamp=false');

    // 归一化行为不变：缺时间戳的行 start 仍用数组下标（行号）占位，
    // 排序因此可能错位 —— 下游取区间文本必须靠 hasTimestamp 过滤，不能靠 start。
    const partial = buildEvidence({
      duration: 100,
      transcript: ['第一行没有时间戳', '第二行没有时间戳', '[0:05] 第三行有时间戳']
    });
    equal(JSON.stringify(partial.transcript.map(row => row.start)), JSON.stringify([0, 1, 5]),
      '缺时间戳的行 start 仍用行号占位（归一化行为未变），与真实时间戳一起排序');
    equal(partial.transcript[0].hasTimestamp, false, '第 1 行 hasTimestamp=false');
    check(!partial.warnings.includes('transcript_missing_timestamps'),
      '只有部分行缺时间戳时不告警 transcript_missing_timestamps（该警告仅针对全部缺失）');
    check(partial.warnings.includes('transcript_partially_missing_timestamps:2'),
      '部分行缺时间戳 → 告警 transcript_partially_missing_timestamps:2（缺失行数正确）',
      JSON.stringify(partial.warnings));

    // 全部行都没有时间戳时才告警原文案，且不重复报部分缺失
    const allUntimed = buildEvidence({ duration: 100, transcript: ['甲', '乙', '丙'] });
    check(allUntimed.warnings.includes('transcript_missing_timestamps'),
      '全部行都没有时间戳时告警 transcript_missing_timestamps');
    check(!allUntimed.warnings.some(message => message.startsWith('transcript_partially_missing_timestamps')),
      '全部缺失时只保留原警告，不再报 partial');
    equal(JSON.stringify(allUntimed.transcript.map(row => row.start)), JSON.stringify([0, 1, 2]),
      '全缺时间戳时 start 依次为行号');

    // 对象数组形态
    const rows = normalizeTranscript([
      { start: 3, end: 6, text: '对象行' },
      { timestamp: '0:10', text: 'timestamp 字段' },
      { text: '没有时间' }
    ]);
    const rowByText = text => rows.find(row => row.text === text);
    equal(rowByText('对象行').start, 3, '对象行 start 解析');
    equal(rowByText('timestamp 字段').start, 10, 'timestamp 字段可解析');
    equal(rowByText('没有时间').hasTimestamp, false, '缺时间字段 → hasTimestamp=false');
    equal(rowByText('没有时间').start, 2, '缺时间字段的行 start=数组下标 2（归一化行为未变）');

    // transcriptSnippet 只取区间内、带时间戳的行
    const snippet = transcriptSnippet(partial.transcript, 4, 10);
    check(snippet.includes('第三行有时间戳'), 'snippet 取到区间内文本');
    check(!snippet.includes('第一行'), 'snippet 不取区间外文本');

    // 修复：行号当 start 的行不参与取区间文本，
    // 否则这些文本会经 validator 的 summary 兜底污染契约 description
    equal(transcriptSnippet(partial.transcript, 0, 4), '',
      '无时间戳的行即使行号落进区间，也不被 transcriptSnippet 取用');

    // 字符串输入先归一化，再按同一套 hasTimestamp 过滤
    const untimedAndTimedText = '无时间戳的一行\n[0:05] 带时间戳的一行';
    equal(transcriptSnippet(untimedAndTimedText, 0, 4), '',
      '字符串输入同样不取无时间戳的行');
    equal(transcriptSnippet(untimedAndTimedText, 0, 10), '带时间戳的一行',
      '字符串输入仍能取到区间内带时间戳的行');

    // 正常输入（全部带时间戳）行为完全不变
    equal(transcriptSnippet(partial.transcript, 5, 10), '第三行有时间戳',
      '全部带时间戳时取区间文本的行为不变');

    // 未归一化的原始行（没有 hasTimestamp 字段）退回解析 start，旧调用方行为不变
    equal(transcriptSnippet([{ start: 3, text: '原始行' }], 0, 5), '原始行',
      '原始数组行仍按 start 参与取区间文本');
    equal(transcriptSnippet([{ text: '没有时间的原始行' }], 0, 5), '',
      '原始数组行没有时间字段时同样不参与取区间文本');
  });

  await test('⑤ normalizeFrameTimes：四种形态、去重、升序、剔除空值与非法值', () => {
    const frames = [
      1.5,
      { time: 3 },
      { timestamp: 2 },
      { timestampMs: 1500 },
      { time: 3 }
    ];
    const times = normalizeFrameTimes(frames, []);
    equal(JSON.stringify(times), JSON.stringify([1.5, 2, 3]), '数字/time/timestamp/timestampMs(/1000) 四形态合并去重升序');

    const messy = normalizeFrameTimes([3, 1, 2, -1, 'abc', NaN, {}, null, undefined, ''], []);
    equal(JSON.stringify(messy), JSON.stringify([1, 2, 3]), '剔除负数、空值与非法值，保留合法数字并升序');

    equal(JSON.stringify(normalizeFrameTimes([1, 1.0, '1.0'], [])), JSON.stringify([1]), '等价数值去重');

    // 显式 frameTimes 参数非空时优先于 frames
    equal(JSON.stringify(normalizeFrameTimes([9], [{ time: 1 }])), JSON.stringify([1]),
      'frameTimes 非空时优先使用 frameTimes');

    // 非数组输入返回空数组
    equal(JSON.stringify(normalizeFrameTimes(null, null)), JSON.stringify([]), '非数组输入返回空数组');

    // 空值剔除：Number(null)===0、Number('')===0，不能让缺失值伪装成第 0 秒的帧
    equal(JSON.stringify(normalizeFrameTimes([{ time: null }], [])), JSON.stringify([]),
      '{time:null} 被剔除（不再被 Number(null)=0 当成 0 秒）');
    equal(JSON.stringify(normalizeFrameTimes([{ timestamp: null }], [])), JSON.stringify([]),
      '{timestamp:null} 被剔除');
    equal(JSON.stringify(normalizeFrameTimes([{ timestampMs: null }], [])), JSON.stringify([]),
      '{timestampMs:null} 被剔除');
    equal(JSON.stringify(normalizeFrameTimes([{ time: undefined }, { timestamp: undefined }], [])),
      JSON.stringify([]), '{time/timestamp:undefined} 被剔除');
    equal(JSON.stringify(normalizeFrameTimes([{ time: '' }], [])), JSON.stringify([]),
      "{time:''} 被剔除");
    equal(JSON.stringify(normalizeFrameTimes([{ time: null, timestamp: 3 }], [])), JSON.stringify([3]),
      '主字段为空时继续尝试备用字段');

    // 回归：0 是合法帧时间（视频起点），不能被这次改为「剔除空值」误杀
    equal(JSON.stringify(normalizeFrameTimes([{ time: 0 }, 0], [])), JSON.stringify([0]),
      'time:0 与数字 0 都是合法帧时间，必须保留');
    equal(JSON.stringify(normalizeFrameTimes([{ timestamp: 0 }], [])), JSON.stringify([0]),
      'timestamp:0 必须保留');
    equal(JSON.stringify(normalizeFrameTimes([{ timestampMs: 0 }], [])), JSON.stringify([0]),
      'timestampMs:0 → 0 秒，必须保留');

    const evidence = buildEvidence({ duration: 100, frames: frames, frameTimes: [] });
    equal(JSON.stringify(evidence.frameTimes), JSON.stringify([1.5, 2, 3]), 'buildEvidence 使用同一套 frameTimes 归一化');

    // 已知行为（只记录，不修改，断言钉住「现状」而非期望）：
    // 布尔值仍被 Number() 收下 —— Number(true)===1、Number(false)===0；
    // 而字符串 'true'/'false' 是 NaN，仍会被剔除。如需改变需另开任务。
    equal(JSON.stringify(normalizeFrameTimes([true, false], [])), JSON.stringify([0, 1]),
      '已知行为：normalizeFrameTimes 对布尔值按 Number() 收下（true→1、false→0，现状）');
    equal(JSON.stringify(normalizeFrameTimes(['true', 'false'], [])), JSON.stringify([]),
      "已知行为：字符串 'true'/'false' 仍是 NaN 被剔除（现状）");
  });

  await test('⑥ 端到端：部分行无时间戳时，契约 description 不含这些行', async () => {
    const runSegmentPipeline = loadPipelineWithoutDiskWrite();

    const untimedHead = '无时间戳的开场白文本';
    const untimedTail = '无时间戳的结尾文本';
    const result = await runSegmentPipeline({
      videoId: 'BV_EVIDENCE_BUILDER_TEST',
      bvid: 'BV_EVIDENCE_BUILDER_TEST',
      duration: 60,
      frames: [0, 20, 40],
      visualCuts: [{ time: 20, score: 0.8, reasons: ['visual_change'] }],
      transcript: [untimedHead, '[0:10] 带时间戳的正文文本', untimedTail]
    });

    check(Array.isArray(result.segments) && result.segments.length > 0, '端到端产出片段');
    const descriptions = (result.segments || []).map(segment => segment.description).join('\n');
    check(!descriptions.includes(untimedHead) && !descriptions.includes(untimedTail),
      '无时间戳行的文本不会经 summary 进入契约 description', descriptions);
    check(descriptions.includes('带时间戳的正文文本'), '带时间戳行的文本仍进入 description', descriptions);
    check(result.debug.warnings.includes('transcript_partially_missing_timestamps:2'),
      '端到端保留 transcript_partially_missing_timestamps:2 警告', JSON.stringify(result.debug.warnings));
  });

  await test('⑦ normalizeTranscript 幂等：重复归一化不把占位行号洗白成时间戳', () => {
    // 输入同时包含「带 [0:05] 时间戳的行」和「无时间戳的行」
    const rawLines = ['没有时间戳的第一行', '[0:05] 带时间戳的一行', '没有时间戳的第三行'];
    const once = normalizeTranscript(rawLines);

    equal(JSON.stringify(once), JSON.stringify([
      { start: 0, end: 0, text: '没有时间戳的第一行', hasTimestamp: false },
      { start: 2, end: 2, text: '没有时间戳的第三行', hasTimestamp: false },
      { start: 5, end: 5, text: '带时间戳的一行', hasTimestamp: true }
    ]), '一次归一化：无时间戳行用行号 0/2 占位，唯一真时间戳 5，按 start 升序');

    const twice = normalizeTranscript(once);
    const thrice = normalizeTranscript(twice);

    equal(JSON.stringify(twice), JSON.stringify(once), '归一化两次与一次结果逐字段相同（幂等）');
    equal(JSON.stringify(thrice), JSON.stringify(once), '归一化三次仍等于一次（稳定不动点）');

    equal(twice.filter(row => row.hasTimestamp === false).length, 2, '二次归一化后无时间戳行仍是 2 行');
    for (const text of ['没有时间戳的第一行', '没有时间戳的第三行']) {
      const row = twice.find(item => item.text === text);
      equal(row.hasTimestamp, false, `「${text}」二次归一化后 hasTimestamp 仍为 false（未被洗白）`);
    }
    const timed = twice.find(item => item.text === '带时间戳的一行');
    equal(timed.hasTimestamp, true, '本来就是合法时间戳的归一化行原样保留 hasTimestamp=true');
    equal(timed.start, 5, '带真时间戳的行 start 不被重解析（仍为 5）');

    // 端到端形态：把上一次 buildEvidence 的 transcript 再喂回 buildEvidence，结果仍幂等
    const evidenceOnce = buildEvidence({ duration: 100, transcript: rawLines });
    const evidenceTwice = buildEvidence({ duration: 100, transcript: evidenceOnce.transcript });
    equal(JSON.stringify(evidenceTwice.transcript), JSON.stringify(evidenceOnce.transcript),
      'buildEvidence 二次消费已归一化 transcript 仍逐字段相同');
    equal(JSON.stringify(evidenceTwice.transcript.map(row => row.hasTimestamp)), JSON.stringify([false, false, true]),
      '二次消费后 hasTimestamp 标记未被洗白');

    // 回归：transcriptSnippet 对归一化两次的输入仍不取无时间戳的行
    equal(transcriptSnippet(twice, 0, 4), '',
      '二次归一化输入：行号落在 [0,4) 区间的无时间戳行仍不被 snippet 取用');
    equal(transcriptSnippet(twice, 0, 10), '带时间戳的一行', '二次归一化输入：区间内带时间戳的行仍正常取到');
    equal(transcriptSnippet(twice, 0, 4), transcriptSnippet(once, 0, 4), 'snippet 对一次/二次归一化输入一致');

    // 回归：原始（未归一化）对象数组解析结果与改动前完全一致
    const rawRows = [
      { start: 3, end: 6, text: '对象行' },
      { timestamp: '0:10', text: 'timestamp 字段' },
      { text: '没有时间' },
      '裸字符串行',
      '[0:07] 方括号行'
    ];
    const expectedRows = [
      { start: 2, end: 2, text: '没有时间', hasTimestamp: false },
      { start: 3, end: 6, text: '对象行', hasTimestamp: true },
      { start: 3, end: 3, text: '裸字符串行', hasTimestamp: false },
      { start: 7, end: 7, text: '方括号行', hasTimestamp: true },
      { start: 10, end: 10, text: 'timestamp 字段', hasTimestamp: true }
    ];
    equal(JSON.stringify(normalizeTranscript(rawRows)), JSON.stringify(expectedRows),
      '原始混合数组（对象+字符串）解析结果与改动前一致');
    equal(JSON.stringify(normalizeTranscript(normalizeTranscript(rawRows))), JSON.stringify(expectedRows),
      '原始混合数组归一化两次仍等于改动前的一次结果（幂等且不改变原语义）');

    // 回归：字符串输入与字符串数组输入等价，且对解析结果再归一化仍幂等
    const rawText = ['没有时间戳的开头', '[0:05] 有时间戳的正文', '没有时间戳的结尾'].join('\n');
    const fromRawText = normalizeTranscript(rawText);
    equal(JSON.stringify(fromRawText), JSON.stringify(normalizeTranscript(rawText.split('\n'))),
      '字符串输入与字符串数组输入结果等价（改动前后一致）');
    equal(JSON.stringify(normalizeTranscript(fromRawText)), JSON.stringify(fromRawText),
      '字符串解析结果二次归一化幂等');

    // 已知行为（只记录，不修改，断言钉住「现状」而非期望）：
    // transcriptToText（即 evidence.transcriptText）不过滤 hasTimestamp，
    // 无时间戳行的占位行号仍会被渲染成 [0:00] / [0:01]。
    const untimedOnly = buildEvidence({ duration: 100, transcript: ['甲', '乙'] });
    equal(untimedOnly.transcriptText, '[0:00] 甲\n[0:01] 乙',
      '已知行为：无时间戳行在 transcriptText 中仍渲染为 [0:00] / [0:01]（现状，非期望）');
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
