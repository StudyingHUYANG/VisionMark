'use strict';

/**
 * candidateCutFusion 单测（纯函数：无网络、无模型、无写盘）
 *
 * 运行方式: node server/services/segmentPipeline/candidateCutFusion.test.js
 *
 * 钉住的行为：
 *  ① 输入顺序无关性：同一批候选切点用多种排列输入，输出逐字段 JSON 完全相等
 *  ② 同一来源的多个切点只取最大分（不累加、不因重复计分推满）
 *  ③ 阈值语义（按代码实际行为，不按注释猜）：
 *     - MERGE_WINDOW_SECONDS = 5（源码第 26 行）：与「当前簇的加权均值」距离 <= 5 并入
 *     - MIN_SPACING_SECONDS = 10（第 27 行）：相邻间隔 >= 10 全保留；只有 < 10 才丢低分者
 *     - EDGE_GUARD_SECONDS = 8 / EDGE_GUARD_MIN_SCORE = 0.85（第 28-29 行）：
 *       距首尾 < 8 秒且分数 < 0.85 才丢；=8 / >8 保留，>=0.85 分保留
 *  ④ 补点（time_padding）：只在空档 > MAX_GAP_SECONDS(90) 的中点插入；不越界；
 *     受 MAX_PADDING_ITERATIONS(200) 上限约束，不会无限增长
 *  ⑤ 输出切点 time 升序、sources 数组顺序稳定
 *
 * 已知现状（测试如实钉住，不改生产代码）：
 *  - clusterCuts 的锚点是「动态加权均值」（weightedMeanTime 随成员变化），
 *    因此簇的时间跨度可以超过 MERGE_WINDOW_SECONDS；这与 evidenceBuilder.clusterEvents
 *    的「固定簇首锚点、跨度恒 <= 窗口」语义不同。见用例 ⑥。
 *  - 完全并列（time/score/来源/原因全同）且原始载荷不同的切点：compareCuts 返回 0，
 *    稳定排序保留输入顺序，导致 raw 数组顺序随输入变化（其余字段一致）。见用例 ⑦。
 */

const { generateCandidateCuts, mergeNearbyCuts, normalizeCut, transcriptRows } = require('./candidateCutFusion');

/** 与源码保持一致的阈值常量（源码未导出，改动时这里必须同步） */
const MERGE_WINDOW_SECONDS = 5;
const MIN_SPACING_SECONDS = 10;
const EDGE_GUARD_SECONDS = 8;
const EDGE_GUARD_MIN_SCORE = 0.85;
const MAX_GAP_SECONDS = 90;
const MAX_PADDING_ITERATIONS = 200;

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

function timesOf(cuts) {
  return cuts.map(cut => cut.time);
}

// ---------------------------------------------------------------------------
// 测试素材
// ---------------------------------------------------------------------------

const RICH_INPUT = {
  duration: 120,
  frameTimes: [10, 20, 30],
  visualCuts: [
    { time: 12, score: 0.6, reasons: ['visual_change'] },
    { time: 30, score: 0.7 }
  ],
  audioCuts: [{ time: 14, score: 0.5 }],
  keywordCuts: [{ time: 31, score: 0.9, keyword: '总结' }],
  transcript: ['[0:10] 大家好', '[0:25] 接下来我们看核心功能', '[0:40] 总结一下主要结论'].join('\n')
};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  await test('① 输入顺序无关性：多种排列输出逐字段 JSON 相等', () => {
    const permutations = {
      forward: RICH_INPUT,
      reversed: {
        ...RICH_INPUT,
        visualCuts: RICH_INPUT.visualCuts.slice().reverse(),
        audioCuts: RICH_INPUT.audioCuts.slice().reverse(),
        keywordCuts: RICH_INPUT.keywordCuts.slice().reverse()
      },
      rotated: {
        ...RICH_INPUT,
        visualCuts: [RICH_INPUT.visualCuts[1], RICH_INPUT.visualCuts[0]]
      },
      swappedSources: {
        ...RICH_INPUT,
        visualCuts: [RICH_INPUT.visualCuts[1], RICH_INPUT.visualCuts[0]],
        audioCuts: RICH_INPUT.audioCuts.slice(),
        keywordCuts: RICH_INPUT.keywordCuts.slice().reverse()
      }
    };

    const rendered = Object.entries(permutations)
      .map(([name, input]) => [name, JSON.stringify(generateCandidateCuts(input))]);
    const baseline = rendered[0][1];

    for (const [name, json] of rendered.slice(1)) {
      equal(json === baseline, true, `排列 ${name} 与 forward 逐字段 JSON 相等`);
    }
    check(baseline.length > 100, '基准输出非空');

    // 相同 time 的切点合并后 sources 顺序稳定（按 SOURCE_RANK：keyword → visual → audio）
    const sameTime = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 20, score: 0.8 }],
      audioCuts: [{ time: 20, score: 0.7 }],
      keywordCuts: [{ time: 20, score: 0.9, keyword: '要点' }]
    });
    equal(sameTime.length, 1, '同一时刻的跨源切点合并成一个');
    equal(JSON.stringify(sameTime[0].sources), JSON.stringify(['keyword', 'visual', 'audio']),
      'sources 按固定优先级 keyword→visual→audio 排序');
    equal(sameTime[0].matchedCount, 3, '合并记录 matchedCount=3');

    // 输出 time 升序
    const many = generateCandidateCuts({
      duration: 200,
      visualCuts: [{ time: 150, score: 0.6 }, { time: 20, score: 0.6 }, { time: 90, score: 0.6 }]
    });
    const times = timesOf(many);
    check(times.every((time, index) => index === 0 || times[index - 1] <= time), '输出 time 升序',
      JSON.stringify(times));
  });

  await test('② 同一来源多个切点只取最大分，不累加', () => {
    // 同源两个切点落进同一簇：分数 = max(0.5, 0.6) = 0.6，而不是相加或被推满
    const sameSource = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 20, score: 0.5 }, { time: 22, score: 0.6 }]
    });
    equal(sameSource.length, 1, '两个同源近邻切点合并');
    equal(sameSource[0].score, 0.6, '同源取最大分 0.6');
    equal(sameSource[0].matchedCount, 2, '两个成员都计入 matchedCount');

    // 五个同源 0.5 分切点仍是 0.5，不因重复计分推满
    const repeated = generateCandidateCuts({
      duration: 60,
      visualCuts: [20, 20.5, 21, 21.5, 22].map(time => ({ time, score: 0.5 }))
    });
    equal(repeated.length, 1, '五个同源近邻合并成一个');
    equal(repeated[0].score, 0.5, '重复同源切点不累加（仍是 0.5）');

    // 跨源用 noisy-or：1 - (1-0.9)(1-0.6) = 0.96，仍 <= 1
    const crossSource = generateCandidateCuts({
      duration: 60,
      keywordCuts: [{ time: 20, score: 0.9, keyword: '要点' }],
      visualCuts: [{ time: 22, score: 0.6 }]
    });
    equal(crossSource.length, 1, '跨源近邻合并');
    equal(crossSource[0].score, 0.96, '跨源 noisy-or 合成 0.96');

    // 直接调 mergeNearbyCuts：确认单来源取最大、来源间 noisy-or
    const merged = mergeNearbyCuts([
      normalizeCut({ time: 20, score: 0.4 }, 'visual'),
      normalizeCut({ time: 21, score: 0.9 }, 'visual'),
      normalizeCut({ time: 22, score: 0.5 }, 'audio')
    ], MERGE_WINDOW_SECONDS);
    equal(merged.length, 1, 'mergeNearbyCuts 合并同一窗口');
    equal(merged[0].score, 0.95, 'visual 取 max 0.9 后与 audio 0.5 noisy-or = 0.95');
  });

  await test('③ 阈值 MERGE_WINDOW_SECONDS：恰好等于 5 并入，超过 5 不并', () => {
    // 关掉最小间距过滤，避免间距规则掩盖合并窗口的判定
    const options = { minSpacingSeconds: 0 };
    const exactly = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 10, score: 0.5 }, { time: 15, score: 0.5 }]
    }, options);
    equal(exactly.length, 1, '相距恰好 5 秒 → 同一簇（判定用 <= 窗口）');
    equal(exactly[0].matchedCount, 2, '并入同一簇记录 2 个成员');
    equal(exactly[0].time, 12.5, '同分同源时簇时间 = 算术平均 12.5');

    const over = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 10, score: 0.5 }, { time: 15.01, score: 0.5 }]
    }, options);
    equal(over.length, 2, '相距 5.01 秒（超过 1 个 0.01 单位）→ 两个簇');
    equal(JSON.stringify(timesOf(over)), JSON.stringify([10, 15.01]), '两个簇时间保持原值');
    check(over.every(cut => cut.matchedCount === 1), '两个簇各自只有 1 个成员');
  });

  await test('④ 阈值 MIN_SPACING_SECONDS：只有间隔 < 10 才丢低分者', () => {
    // 语义（源码第 280 行）：cut.time - last.time >= 10 一律保留；
    // 只有 < 10 时才比较分数，分数更高者替换前者（分数相同时保留靠前的那个）
    const warnList = [];
    const exactly = generateCandidateCuts({
      duration: 100,
      visualCuts: [{ time: 20, score: 0.5 }, { time: 30, score: 0.5 }]
    }, { warn: message => warnList.push(message) });
    equal(exactly.length, 2, '间隔恰好 10 秒 → 两个都保留（>= 阈值即保留）');
    check(!warnList.includes('dropped_cuts_by_min_spacing:1'), '恰好等于阈值不丢，无 spacing 警告');

    const over = generateCandidateCuts({
      duration: 100,
      visualCuts: [{ time: 20, score: 0.5 }, { time: 30.01, score: 0.5 }]
    });
    equal(over.length, 2, '间隔 10.01 秒（超过 1 个 0.01 单位）→ 都保留');

    const under = generateCandidateCuts({
      duration: 100,
      visualCuts: [{ time: 20, score: 0.5 }, { time: 29.99, score: 0.5 }]
    });
    equal(under.length, 1, '间隔 9.99 秒（低于阈值）→ 只留一个');
    equal(under[0].time, 20, '同分时保留靠前的切点');

    const warnUnder = [];
    generateCandidateCuts({
      duration: 100,
      visualCuts: [{ time: 20, score: 0.5 }, { time: 29.99, score: 0.9 }]
    }, { warn: message => warnUnder.push(message) });
    check(warnUnder.includes('dropped_cuts_by_min_spacing:1'), '丢切点留下 dropped_cuts_by_min_spacing:1 警告');
  });

  await test('⑤ 阈值 EDGE_GUARD_SECONDS：距边 < 8 且分低才丢', () => {
    // 语义（源码第 268-269 行）：time <= 0 或 >= duration 一律丢；
    // 否则 distanceToEdge = min(time, duration-time)，< 8 且 score < 0.85 才丢
    const atEdge = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 8, score: 0.5 }] });
    equal(JSON.stringify(timesOf(atEdge)), JSON.stringify([8]), '距首端恰好 8 秒（等于阈值）→ 保留');

    const overEdge = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 8.01, score: 0.5 }] });
    equal(JSON.stringify(timesOf(overEdge)), JSON.stringify([8.01]), '距首端 8.01 秒（超过阈值）→ 保留');

    const lowScore = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 7.99, score: 0.5 }] });
    equal(lowScore.length, 0, '距首端 7.99 秒且低分 → 丢弃');

    const highScore = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 7.99, score: 0.85 }] });
    equal(JSON.stringify(timesOf(highScore)), JSON.stringify([7.99]), '距边 <8 但分数恰好 0.85 → 保留（< 0.85 才丢）');

    // 末端同理：distanceToEdge = duration - time
    const tailLow = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 52.01, score: 0.5 }] });
    equal(tailLow.length, 0, '距末端 7.99 秒且低分 → 丢弃');
    const tailAt = generateCandidateCuts({ duration: 60, visualCuts: [{ time: 52, score: 0.5 }] });
    equal(JSON.stringify(timesOf(tailAt)), JSON.stringify([52]), '距末端恰好 8 秒 → 保留');

    const warnList = [];
    generateCandidateCuts({ duration: 60, visualCuts: [{ time: 2, score: 0.5 }] }, {
      warn: message => warnList.push(message)
    });
    check(warnList.includes('dropped_cuts_by_boundary_rule:1'), '越界丢弃留下 dropped_cuts_by_boundary_rule 警告');
  });

  await test('⑥ 补点：不越界、空档收敛；超过 MAX_PADDING_ITERATIONS 时被截断', () => {
    const padded = generateCandidateCuts({
      duration: 300,
      visualCuts: [{ time: 10, score: 0.6 }]
    });
    equal(JSON.stringify(timesOf(padded)), JSON.stringify([10, 82.5, 155, 227.5]),
      '>90 秒空档在中点补点，直到所有空档 <= 90');
    check(padded.every(cut => cut.time > 0 && cut.time < 300), '所有补点严格落在 (0, duration) 内');
    const paddingCuts = padded.filter(cut => cut.sources.includes('time_padding'));
    equal(paddingCuts.length, 3, '3 个补点');
    check(paddingCuts.every(cut => cut.raw === null && cut.matchedCount === 0), '补点 raw=null、matchedCount=0');
    check(paddingCuts.every(cut => cut.score === 0.35), '补点分数为 time_padding 权重 0.35');
    const sortedTimes = timesOf(padded);
    let maxGap = 0;
    for (let i = 1; i < sortedTimes.length; i += 1) maxGap = Math.max(maxGap, sortedTimes[i] - sortedTimes[i - 1]);
    check(maxGap <= MAX_GAP_SECONDS, `补点后最大空档 ${maxGap} <= ${MAX_GAP_SECONDS}`);

    // 极大时长：一轮只补一个点，200 轮后仍有 >90 秒空档，证明 MAX_PADDING_ITERATIONS 上限生效
    const huge = generateCandidateCuts({ duration: 100000, visualCuts: [] });
    const hugeTimes = timesOf(huge);
    check(huge.length <= MAX_PADDING_ITERATIONS, `补点数量 ${huge.length} 不超过 MAX_PADDING_ITERATIONS=${MAX_PADDING_ITERATIONS}`,
      `实际 ${huge.length}`);
    check(huge.length > 100, '极大时长下确实补了大量点（上限而非收敛结束）');
    let hugeMaxGap = 0;
    for (let i = 1; i < hugeTimes.length; i += 1) hugeMaxGap = Math.max(hugeMaxGap, hugeTimes[i] - hugeTimes[i - 1]);
    check(hugeMaxGap > MAX_GAP_SECONDS, `上限截断后仍存在 >${MAX_GAP_SECONDS} 秒空档（说明是 iteration 上限生效）`,
      `实际最大空档 ${hugeMaxGap}`);
    check(hugeTimes.every(time => time > 0 && time < 100000), '补点都不越界');
  });

  await test('⑦ 现状：clusterCuts 锚点是动态加权均值，簇跨度可超过 MERGE_WINDOW_SECONDS', () => {
    // 生成一组切点：每一个都落在「当前簇加权均值 + 4.9」处，
    // 单步距离 <= 5 所以不断并入，但整体跨度远超 5。
    // 这与 evidenceBuilder.clusterEvents 的固定簇首锚点（跨度恒 <= 窗口）语义不同。
    const generated = [10];
    let mean = 10;
    for (let i = 1; i < 12; i += 1) {
      const next = Number((mean + 4.9).toFixed(3));
      generated.push(next);
      mean = (mean * i + next) / (i + 1);
    }

    const result = generateCandidateCuts({
      duration: 100,
      visualCuts: generated.map(time => ({ time, score: 0.6 }))
    });

    equal(result.length, 1, '12 个切点全被并进同一个簇（动态锚点）');
    equal(result[0].matchedCount, 12, '该簇有 12 个成员');
    const rawTimes = result[0].raw.map(cut => cut.time);
    const span = Math.max(...rawTimes) - Math.min(...rawTimes);
    check(span > MERGE_WINDOW_SECONDS,
      `簇跨度 ${span} > MERGE_WINDOW_SECONDS=${MERGE_WINDOW_SECONDS}（动态锚点允许超过窗口）`,
      `原始成员时间 ${JSON.stringify(rawTimes)}`);

    // 对照：若按固定簇首锚点（0 号成员 10 秒），第三个成员 17.35 已经超出窗口
    const wouldSplitUnderFixedAnchor = generated[2] - generated[0] > MERGE_WINDOW_SECONDS;
    check(wouldSplitUnderFixedAnchor, '固定簇首锚点语义下这组输入会被拆成多个簇（语义差异确认）');
  });

  await test('⑧ 现状：完全并列且原始载荷不同的切点，raw 顺序随输入变化', () => {
    // compareCuts 对 time/score/来源/原因全同的切点返回 0（源码第 83-94 行），
    // 稳定排序保留输入顺序，aggregateCluster 的 raw 数组（第 244 行）因此跟着输入顺序走。
    // 这是调试字段的现状，其余业务字段完全一致；已作为缺陷候选记录在测试回报里。
    const options = { minSpacingSeconds: 0, warn: () => {} };
    const first = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 20, score: 0.5, note: 'A' }, { time: 20, score: 0.5, note: 'B' }]
    }, options);
    const second = generateCandidateCuts({
      duration: 60,
      visualCuts: [{ time: 20, score: 0.5, note: 'B' }, { time: 20, score: 0.5, note: 'A' }]
    }, options);

    equal(first.length, 1, '并列切点合并成一个簇');
    equal(second.length, 1, '反序输入同样合并成一个簇');
    const strip = cut => ({ time: cut.time, score: cut.score, reasons: cut.reasons, sources: cut.sources, matchedCount: cut.matchedCount });
    equal(JSON.stringify(strip(first[0])), JSON.stringify(strip(second[0])), '除 raw 外的业务字段完全一致');
    equal(JSON.stringify(first[0].raw.map(cut => cut.note)), JSON.stringify(['A', 'B']),
      '现状：raw 数组按输入顺序 A,B');
    equal(JSON.stringify(second[0].raw.map(cut => cut.note)), JSON.stringify(['B', 'A']),
      '现状：反序输入后 raw 数组变成 B,A');
  });

  await test('⑨ 归一化 transcript：hasTimestamp=false 的占位行号不产生候选切点（带对照）', () => {
    // 归一化行用 hasTimestamp=false 标记 start 是数组下标（占位行号），不是秒数。
    // 10 个普通占位行（start=0..9）+ 第 11 行含过渡词（start=10）：
    // 改动前第 11 行会被当成「第 10 秒」，在结果里凭空生出 time=10 的 text_topic_shift_hint 切点。
    const placeholderRows = Array.from({ length: 10 }, (_, index) => ({
      start: index,
      end: index,
      text: '这是没有时间戳的普通行。',
      hasTimestamp: false
    }));
    placeholderRows.push({ start: 10, end: 10, text: '接下来我们看核心功能。', hasTimestamp: false });

    const mixed = [
      ...placeholderRows,
      { start: 40, end: 40, text: '这里有一个明显的例子。', hasTimestamp: true },
      { start: 60, end: 60, text: '总结一下，主要结论是这样的。', hasTimestamp: true },
      { start: 75, end: 75, text: '接下来我们继续。', hasTimestamp: true }
    ];

    // 直接钉住行过滤：占位行整行剔除，只剩 3 行带真实时间戳的行
    equal(JSON.stringify(transcriptRows(mixed).map(row => row.time)), JSON.stringify([40, 60, 75]),
      'transcriptRows 剔除 hasTimestamp=false 的占位行');

    const cuts = generateCandidateCuts({ duration: 120, transcript: mixed });
    equal(JSON.stringify(timesOf(cuts)), JSON.stringify([60, 75]),
      '占位行号（0..10）不产生任何候选切点，只保留带时间戳行（60/75）的切点');
    check(cuts.every(cut => cut.time !== 10), '不再出现把行号 10 当成第 10 秒的假切点');
    check(cuts.every(cut => cut.reasons.includes('text_topic_shift_hint')), '带时间戳行的提示词切点照常产生');

    // 对照：同一批行若带真实时间戳（hasTimestamp=true），第 10 秒处的切点照常产生 —— 证明不是把功能整个关掉
    const control = [
      { start: 3, end: 3, text: '大家好，今天我们先介绍项目背景。', hasTimestamp: true },
      { start: 10, end: 10, text: '接下来我们看核心功能。', hasTimestamp: true },
      { start: 40, end: 40, text: '这里有一个明显的例子。', hasTimestamp: true },
      { start: 60, end: 60, text: '总结一下，主要结论是这样的。', hasTimestamp: true },
      { start: 75, end: 75, text: '接下来我们继续。', hasTimestamp: true }
    ];
    const controlCuts = generateCandidateCuts({ duration: 120, transcript: control });
    equal(JSON.stringify(timesOf(controlCuts)), JSON.stringify([10, 60, 75]),
      '对照：hasTimestamp=true 时 10 秒处的切点照常产生');

    // 字符串分支经 normalizeTranscript 同样带标记：整段无时间戳时不会有任何行以「行号秒」参与
    equal(JSON.stringify(transcriptRows('第一行\n第二行\n接下来我们看核心功能。')), JSON.stringify([]),
      '字符串分支：无时间戳行同样被剔除');
  });

  await test('⑩ 回归：未归一化原始对象数组 [{start,text}] 输出与改动前逐字段一致', () => {
    // 快照取自改动前实测输出（原始行没有 hasTimestamp 字段，start / time / timestamp 照旧解析）。
    // 这是既有调用方的输入形态，行为不得有任何变化。
    const input = {
      duration: 120,
      transcript: [
        { start: 10, text: '大家好，今天我们先介绍项目背景。' },
        { time: 25, text: '接下来我们看核心功能。' },
        { timestamp: 40, text: '这里有一个明显的例子。' },
        { start: 60, text: '总结一下，主要结论是这样的。' }
      ]
    };
    const beforeSnapshot = `[{"time":25,"score":0.72,"reasons":["text_change","text_topic_shift_hint"],"sources":["text"],"raw":{"time":25,"score":0.72,"reasons":["text_topic_shift_hint"],"sources":["text"],"raw":{"time":25,"text":"接下来我们看核心功能。"}},"matchedCount":1,"adopted":false,"nearbyEvidence":{"beforeText":"大家好，今天我们先介绍项目背景。","afterText":"接下来我们看核心功能。","frameTimes":[]}},{"time":60,"score":0.72,"reasons":["text_change","text_topic_shift_hint"],"sources":["text"],"raw":{"time":60,"score":0.72,"reasons":["text_topic_shift_hint"],"sources":["text"],"raw":{"time":60,"text":"总结一下，主要结论是这样的。"}},"matchedCount":1,"adopted":false,"nearbyEvidence":{"beforeText":"这里有一个明显的例子。","afterText":"总结一下，主要结论是这样的。","frameTimes":[]}}]`;

    equal(JSON.stringify(generateCandidateCuts(input)), JSON.stringify(JSON.parse(beforeSnapshot)),
      '原始对象数组的候选切点逐字段与改动前一致');
  });

  await test('⑪ 回归：testSegmentPipeline 输入（字符串、每行带 [MM:SS]）与改动前逐字段一致', () => {
    // 真实链路（videoAnalyzer 产出的转录每行都带时间戳）本就不该受影响，这里证明对真实输入是 no-op。
    // 快照取自改动前实测输出：与 server/scripts/testSegmentPipeline.js 的输入完全相同。
    const input = {
      videoId: 'mock-bvid',
      bvid: 'mock-bvid',
      duration: 180,
      frames: [0, 12, 30, 48, 75, 102, 135, 170],
      visualCuts: [
        { time: 44, score: 0.82, reasons: ['visual_change'] },
        { time: 118, score: 0.68, reasons: ['scene_change'] }
      ],
      audioCuts: [
        { time: 47, score: 0.7, reasons: ['audio_pause'] }
      ],
      keywordCuts: [
        { time: 122, score: 0.9, reasons: ['keyword:总结一下'] }
      ],
      transcript: [
        '[0:03] 大家好，今天我们先介绍项目背景。',
        '[0:45] 接下来我们看核心功能。',
        '[1:22] 这里有一个明显的例子。',
        '[2:02] 总结一下，主要结论是这样的。'
      ].join('\n')
    };
    const beforeSnapshot = `[{"time":45.26,"score":0.985,"reasons":["audio_change","audio_pause","text_change","text_topic_shift_hint","visual_change"],"sources":["visual","audio","text"],"raw":[{"time":44,"score":0.82,"reasons":["visual_change"]},{"time":45,"score":0.72,"reasons":["text_topic_shift_hint"],"sources":["text"],"raw":{"time":45,"text":"接下来我们看核心功能。"}},{"time":47,"score":0.7,"reasons":["audio_pause"]}],"matchedCount":3,"adopted":false,"nearbyEvidence":{"beforeText":"接下来我们看核心功能。","afterText":"这里有一个明显的例子。","frameTimes":[]}},{"time":120.82,"score":0.991,"reasons":["keyword:总结一下","keyword_change","scene_change","text_change","text_topic_shift_hint","visual_change"],"sources":["keyword","visual","text"],"raw":[{"time":118,"score":0.68,"reasons":["scene_change"]},{"time":122,"score":0.9,"reasons":["keyword:总结一下"]},{"time":122,"score":0.72,"reasons":["text_topic_shift_hint"],"sources":["text"],"raw":{"time":122,"text":"总结一下，主要结论是这样的。"}}],"matchedCount":3,"adopted":false,"nearbyEvidence":{"beforeText":"这里有一个明显的例子。","afterText":"总结一下，主要结论是这样的。","frameTimes":[]}}]`;

    equal(JSON.stringify(generateCandidateCuts(input)), JSON.stringify(JSON.parse(beforeSnapshot)),
      'testSegmentPipeline 输入的候选切点逐字段与改动前一致（对真实输入 no-op）');
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
