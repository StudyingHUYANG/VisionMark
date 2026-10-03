'use strict';

/**
 * 候选切点融合。
 *
 * 确定性约定：
 *  1. 所有切点先按「时间 → 分数 → 来源 → 原因」排成全序，处理顺序与调用方传入的数组顺序无关。
 *  2. 合并以「簇」为单位，簇内聚合使用可交换运算（加权均值 / 按来源取最大后 noisy-or），
 *     因此同一批切点无论到达顺序如何，结果完全一致。
 *  3. 同一来源的多个切点只取最大分，不累加，避免分数被重复计分推满。
 */

const { parseTimeToSeconds, toFiniteNumber, uniqueSorted, normalizeTranscript } = require('./evidenceBuilder');

const SOURCE_WEIGHTS = {
  keyword: 0.9,
  visual: 0.75,
  audio: 0.65,
  text: 0.7,
  time_padding: 0.35
};

/** 来源展示与排序优先级，保证 sources 数组顺序稳定 */
const SOURCE_RANK = ['keyword', 'visual', 'audio', 'text', 'time_padding'];

const MERGE_WINDOW_SECONDS = 5;
const MIN_SPACING_SECONDS = 10;
const EDGE_GUARD_SECONDS = 8;
const EDGE_GUARD_MIN_SCORE = 0.85;
const MAX_GAP_SECONDS = 90;
const MAX_PADDING_ITERATIONS = 200;
const NEARBY_FRAME_WINDOW_SECONDS = 8;
const NEARBY_FRAME_LIMIT = 6;

const TRANSITION_HINTS = ['接下来', '然后', '但是', '所以', '总结', '最后', '回到', '换句话说', '另一方面'];
const TOPIC_SHIFT_GAP_SECONDS = 18;
const TOPIC_SHIFT_LENGTH_DELTA = 18;
const TOPIC_SHIFT_HINT_SCORE = 0.72;
const TOPIC_SHIFT_GAP_SCORE = 0.5;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

/** 无法解析时返回 null，用于区分「显式给了 0 分」和「没给分」 */
function clamp01OrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceRank(source) {
  const index = SOURCE_RANK.indexOf(source);
  return index === -1 ? SOURCE_RANK.length : index;
}

function sortSources(sources) {
  return sources.slice().sort((a, b) => {
    const rankDiff = sourceRank(a) - sourceRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

function primarySource(cut) {
  return Array.isArray(cut?.sources) && cut.sources.length > 0 ? cut.sources[0] : 'unknown';
}

/**
 * 全序比较器。任何一步排序都用它，确保处理顺序只由内容决定。
 */
function compareCuts(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  if (a.score !== b.score) return b.score - a.score;

  const rankDiff = sourceRank(primarySource(a)) - sourceRank(primarySource(b));
  if (rankDiff !== 0) return rankDiff;

  const aKey = (a.reasons || []).join('|');
  const bKey = (b.reasons || []).join('|');
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 单个切点归一化；时间无法解析或为负时返回 null */
function normalizeCut(cut, source) {
  const time = parseTimeToSeconds(cut?.time ?? cut?.timestamp ?? cut?.start_time ?? cut?.start);
  if (!Number.isFinite(time) || time < 0) return null;

  const explicitScore = clamp01OrNull(cut?.score ?? cut?.confidence);
  const score = explicitScore !== null ? explicitScore : clamp01(SOURCE_WEIGHTS[source] ?? 0.5);

  const reasons = asArray(cut?.reasons).filter(reason => typeof reason === 'string' && reason.trim());
  const reasonFallback = source === 'keyword' && cut?.keyword ? `keyword:${cut.keyword}` : `${source}_change`;
  const declaredSources = asArray(cut?.sources).filter(item => typeof item === 'string' && item.trim());

  return {
    time,
    score,
    reasons: uniqueSorted([...reasons, reasonFallback]),
    sources: sortSources(uniqueSorted([source, ...declaredSources])),
    raw: cut
  };
}

/**
 * 转录文本 → [{ time, text }]，兼容数组与字符串（含全角冒号）。
 *
 * 归一化行（evidenceBuilder.normalizeTranscript 的产物）用 hasTimestamp 标记 start 的语义：
 * false 表示 start 是数组下标（占位行号），不是秒数。这类行必须剔除 —— 若照常解析，
 * 行号 0/1/2 会被当成第 0/1/2 秒，凭空衍生 text_topic_shift_* 语义切点。
 * 字符串输入经由 normalizeTranscript 归一化，同样带该标记，因此天然被统一过滤覆盖。
 * 未归一化的原始行没有 hasTimestamp 字段，照旧解析 start / time / timestamp，
 * 能解析出时间就参与，保持既有调用方（原始对象数组）的行为不变。
 */
function transcriptRows(transcript) {
  const rawRows = Array.isArray(transcript)
    ? transcript
    : (typeof transcript === 'string' ? normalizeTranscript(transcript) : []);

  return rawRows
    // 只剔除显式标记为 false 的行；hasTimestamp === true 与无该字段的原始行一律照常参与。
    .filter(row => !(row && typeof row === 'object' && row.hasTimestamp === false))
    .map(row => ({
      time: parseTimeToSeconds(row?.start ?? row?.time ?? row?.timestamp),
      text: String(row?.text ?? row?.content ?? '').trim()
    }))
    .filter(row => Number.isFinite(row.time) && row.text)
    .sort((a, b) => a.time - b.time);
}

/**
 * 从转录文本推导话题切换候选切点。
 * 两种触发条件给出可区分的原因，便于回溯是哪条规则命中。
 */
function transcriptSemanticCuts(transcript) {
  const rows = transcriptRows(transcript);
  if (rows.length < 3) return [];

  const cuts = [];
  for (let i = 1; i < rows.length; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];
    const gap = current.time - previous.time;
    const hasHint = TRANSITION_HINTS.some(hint => current.text.includes(hint));

    if (hasHint) {
      cuts.push({
        time: current.time,
        score: TOPIC_SHIFT_HINT_SCORE,
        reasons: ['text_topic_shift_hint'],
        sources: ['text'],
        raw: current
      });
      continue;
    }

    const lengthShift = Math.abs(current.text.length - previous.text.length) >= TOPIC_SHIFT_LENGTH_DELTA;
    if (gap >= TOPIC_SHIFT_GAP_SECONDS && lengthShift) {
      cuts.push({
        time: current.time,
        score: TOPIC_SHIFT_GAP_SCORE,
        reasons: ['text_topic_shift_gap'],
        sources: ['text'],
        raw: current
      });
    }
  }

  return cuts;
}

// ---------------------------------------------------------------------------
// 融合
// ---------------------------------------------------------------------------

/** 簇的代表时间：按分数加权平均；权重全为 0 时退化为算术平均 */
function weightedMeanTime(members) {
  let weightSum = 0;
  let timeSum = 0;
  for (const member of members) {
    weightSum += member.score;
    timeSum += member.time * member.score;
  }
  if (weightSum > 0) return timeSum / weightSum;
  return members.reduce((sum, member) => sum + member.time, 0) / members.length;
}

/**
 * 分数融合：同来源取最大值（不累加），来源之间用 noisy-or。
 * 结果恒在 [0,1]，重复同源切点不会把分数推高。
 */
function combineSourceScores(members) {
  const bestPerSource = new Map();
  for (const member of members) {
    const source = primarySource(member);
    const best = bestPerSource.get(source);
    if (best === undefined || member.score > best) bestPerSource.set(source, member.score);
  }

  let remaining = 1;
  for (const score of bestPerSource.values()) {
    remaining *= (1 - clamp01(score));
  }
  return clamp01(1 - remaining);
}

/** 单链聚类：与当前簇代表时间的距离不超过 window 就并入 */
function clusterCuts(sortedCuts, windowSeconds) {
  const clusters = [];
  let current = [];

  for (const cut of sortedCuts) {
    if (current.length === 0) {
      current = [cut];
      continue;
    }
    const distance = Math.abs(cut.time - weightedMeanTime(current));
    if (distance <= windowSeconds) {
      current.push(cut);
    } else {
      clusters.push(current);
      current = [cut];
    }
  }

  if (current.length > 0) clusters.push(current);
  return clusters;
}

function aggregateCluster(members) {
  const sources = sortSources(uniqueSorted(members.flatMap(member => member.sources)));
  return {
    time: Number(weightedMeanTime(members).toFixed(2)),
    score: Number(combineSourceScores(members).toFixed(3)),
    reasons: uniqueSorted(members.flatMap(member => member.reasons)),
    sources,
    raw: members.length === 1 ? members[0].raw : members.map(member => member.raw),
    matchedCount: members.length
  };
}

function mergeNearbyCuts(cuts, windowSeconds = MERGE_WINDOW_SECONDS) {
  const sorted = cuts.slice().sort(compareCuts);
  return clusterCuts(sorted, windowSeconds)
    .map(aggregateCluster)
    .sort(compareCuts);
}

// ---------------------------------------------------------------------------
// 边界与间距
// ---------------------------------------------------------------------------

/** 只保留 0 < time < duration 的切点；贴近首尾的切点需要足够高的分数 */
function enforceBoundaries(cuts, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];

  return cuts.filter(cut => {
    if (!Number.isFinite(cut.time)) return false;
    if (cut.time <= 0 || cut.time >= duration) return false;

    const distanceToEdge = Math.min(cut.time, duration - cut.time);
    if (distanceToEdge < EDGE_GUARD_SECONDS && cut.score < EDGE_GUARD_MIN_SCORE) return false;

    return true;
  });
}

/** 相邻切点间隔小于 minSpacing 时保留分数更高的一个 */
function enforceMinSpacing(cuts, minSpacing = MIN_SPACING_SECONDS) {
  const kept = [];
  for (const cut of cuts.slice().sort(compareCuts)) {
    const last = kept[kept.length - 1];
    if (!last || cut.time - last.time >= minSpacing) {
      kept.push(cut);
      continue;
    }
    if (cut.score > last.score) kept[kept.length - 1] = cut;
  }
  return kept;
}

/** 超过 MAX_GAP_SECONDS 的空档在中点补一个低分切点，保证长视频不会整段无边界 */
function insertTimePaddingCuts(cuts, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return cuts.slice();

  const result = cuts.slice();
  for (let iteration = 0; iteration < MAX_PADDING_ITERATIONS; iteration += 1) {
    const boundaries = [0, ...result.map(cut => cut.time), duration].sort((a, b) => a - b);

    let inserted = false;
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start <= MAX_GAP_SECONDS) continue;

      result.push({
        time: Number(((start + end) / 2).toFixed(2)),
        score: SOURCE_WEIGHTS.time_padding,
        reasons: ['time_padding'],
        sources: ['time_padding'],
        raw: null,
        // 与融合切点保持同构：补位切点不对应任何原始输入，所以是 0
        matchedCount: 0
      });
      inserted = true;
      break;
    }

    if (!inserted) break;
  }

  return result.sort(compareCuts);
}

/** 附加切点附近的文字与帧证据，供模型与调试回溯 */
function addNearbyEvidence(cut, rows, frameTimes) {
  let beforeText = '';
  let afterText = '';

  for (const row of rows) {
    if (row.time < cut.time) {
      beforeText = row.text;
      continue;
    }
    afterText = row.text;
    break;
  }

  return {
    ...cut,
    nearbyEvidence: {
      beforeText,
      afterText,
      frameTimes: frameTimes
        .filter(time => Math.abs(time - cut.time) <= NEARBY_FRAME_WINDOW_SECONDS)
        .slice(0, NEARBY_FRAME_LIMIT)
    }
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function generateCandidateCuts(input = {}, options = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const duration = toFiniteNumber(safeInput.duration) ?? 0;
  const frameTimes = asArray(safeInput.frameTimes).filter(time => Number.isFinite(time));
  const transcriptSource = safeInput.transcript ?? safeInput.transcriptText ?? '';
  const rows = transcriptRows(transcriptSource);

  const mergeWindowSeconds = toFiniteNumber(options.mergeWindowSeconds) ?? MERGE_WINDOW_SECONDS;
  const minSpacingSeconds = toFiniteNumber(options.minSpacingSeconds) ?? MIN_SPACING_SECONDS;

  // 丢证据必须留下痕迹：调用方通过 options.warn 收集
  const notify = typeof options.warn === 'function' ? options.warn : () => {};

  const rawCuts = [
    ...asArray(safeInput.visualCuts).map(cut => normalizeCut(cut, 'visual')),
    ...asArray(safeInput.audioCuts).map(cut => normalizeCut(cut, 'audio')),
    ...asArray(safeInput.keywordCuts).map(cut => normalizeCut(cut, 'keyword')),
    ...transcriptSemanticCuts(transcriptSource).map(cut => normalizeCut(cut, 'text'))
  ].filter(Boolean);

  let cuts = enforceBoundaries(rawCuts, duration);
  let droppedOutOfRange = rawCuts.length - cuts.length;

  cuts = mergeNearbyCuts(cuts, mergeWindowSeconds);
  cuts = insertTimePaddingCuts(cuts, duration);

  const beforeSecondBoundaryPass = cuts.length;
  cuts = enforceBoundaries(cuts, duration);
  droppedOutOfRange += beforeSecondBoundaryPass - cuts.length;

  const beforeSpacing = cuts.length;
  cuts = enforceMinSpacing(cuts, minSpacingSeconds);
  const droppedBySpacing = beforeSpacing - cuts.length;

  if (droppedOutOfRange > 0) notify(`dropped_cuts_by_boundary_rule:${droppedOutOfRange}`);
  if (droppedBySpacing > 0) notify(`dropped_cuts_by_min_spacing:${droppedBySpacing}`);

  return cuts
    .map(cut => addNearbyEvidence({
      ...cut,
      time: Number(cut.time.toFixed(2)),
      score: Number(clamp01(cut.score).toFixed(3)),
      adopted: false
    }, rows, frameTimes))
    .sort(compareCuts);
}

module.exports = {
  generateCandidateCuts,
  mergeNearbyCuts,
  normalizeCut,
  compareCuts,
  transcriptRows,
  SOURCE_WEIGHTS
};
