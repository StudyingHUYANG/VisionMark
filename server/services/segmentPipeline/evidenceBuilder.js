'use strict';

/**
 * 证据层：把多个独立检测器的事件归一化并聚类，不做任何「选切点」的决策。
 *
 * 契约（下游必须遵守）：
 *   1. 原始事件全部保留，时间戳原样不动，不做跨源时间合并。
 *   2. 聚类窗口内的近邻事件打包成簇；簇只描述「哪些事件同时在附近发生」。
 *   3. 簇的可信度 = 簇内不同 source 的数量（sourceCount），不引入跨源分数比较。
 *   4. 上游只产证据与簇；最终切点由下游（插件）决定。
 *
 * 之所以不叫 confidence：evidence.confidence 是 high/medium/low 的整体置信度，
 * 同名会让下游误解；簇指标固定叫 sourceCount。
 */

const TRANSCRIPT_LINE_PATTERN = /^\[(\d{1,3}:\d{1,2}(?::\d{1,2})?)\]\s*(.*)$/;

/** 聚类窗口：相邻事件与簇首事件相差不超过这个秒数就归入同一簇 */
const CLUSTER_WINDOW_SECONDS = 3;

/**
 * 三个独立检测器 → 事件来源的映射。
 * 第三个检测器（transcript 关键词）的输出走 keywordCuts；若要改叫 transcript，改这里一行。
 */
const DETECTOR_SOURCES = [
  { input: 'visualCuts', source: 'visual' },
  { input: 'audioCuts', source: 'audio' },
  { input: 'keywordCuts', source: 'keyword' }
];

/** 来源的确定性排序，保证 sources 数组顺序稳定 */
const SOURCE_ORDER = DETECTOR_SOURCES.map(item => item.source);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 解析时间：支持数字、"MM:SS"、"HH:MM:SS"、带方括号的时间标记，全角冒号也能解析。
 * 无法解析时返回 null，绝不静默返回 0。
 */
function parseTimeToSeconds(value) {
  const direct = toFiniteNumber(value);
  if (direct !== null) return direct;
  if (typeof value !== 'string') return null;

  const normalised = value.trim().replace(/：/g, ':');
  if (!normalised) return null;

  const bracketed = normalised.match(/[\[【]\s*([^\]】]+?)\s*[\]】]/);
  const source = bracketed ? bracketed[1] : normalised;

  const parts = source.split(':').map(part => part.trim());
  if (parts.length < 1 || parts.length > 3) return null;

  const numbers = parts.map(part => toFiniteNumber(part));
  if (numbers.some(number => number === null || number < 0)) return null;

  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0];
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function createWarningCollector(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  const seen = new Set(list);
  return (message) => {
    if (!message || seen.has(message)) return;
    seen.add(message);
    list.push(message);
  };
}

function sourceRank(source) {
  const index = SOURCE_ORDER.indexOf(source);
  return index === -1 ? SOURCE_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// 转录归一化
// ---------------------------------------------------------------------------

function parseTranscriptLine(line, fallbackIndex) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;

  const normalised = trimmed.replace(/：/g, ':');
  const match = normalised.match(TRANSCRIPT_LINE_PATTERN);
  if (match) {
    const start = parseTimeToSeconds(match[1]);
    return {
      start: Number.isFinite(start) ? start : fallbackIndex,
      hasTimestamp: Number.isFinite(start),
      text: match[2].trim()
    };
  }

  return { start: fallbackIndex, hasTimestamp: false, text: trimmed };
}

function normalizeTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map((item, index) => {
        if (typeof item === 'string') {
          const parsed = parseTranscriptLine(item, index);
          if (!parsed || !parsed.text) return null;
          return { start: parsed.start, end: parsed.start, text: parsed.text, hasTimestamp: parsed.hasTimestamp };
        }

        const text = String(item?.text ?? item?.content ?? '').trim();
        if (!text) return null;

        const start = parseTimeToSeconds(item?.start ?? item?.time ?? item?.timestamp ?? item?.begin_time);
        const end = parseTimeToSeconds(item?.end ?? item?.end_time);
        const safeStart = Number.isFinite(start) ? start : index;
        return {
          start: safeStart,
          end: Number.isFinite(end) ? end : safeStart,
          text,
          hasTimestamp: Number.isFinite(start)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  if (typeof transcript !== 'string' || !transcript.trim()) return [];

  return transcript
    .split(/\r?\n/)
    .map((line, index) => {
      const parsed = parseTranscriptLine(line, index);
      if (!parsed || !parsed.text) return null;
      return { start: parsed.start, end: parsed.start, text: parsed.text, hasTimestamp: parsed.hasTimestamp };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function transcriptToText(transcriptSegments) {
  return transcriptSegments
    .map(item => {
      const minute = Math.floor(item.start / 60);
      const second = Math.floor(item.start % 60);
      return `[${minute}:${String(second).padStart(2, '0')}] ${item.text}`;
    })
    .join('\n');
}

/** 取 [start, end) 区间内的转录原文，只拼接截断、不改写，供 summary 兜底使用 */
function transcriptSnippet(transcript, start, end, maxLength = 120) {
  const rows = Array.isArray(transcript) ? transcript : normalizeTranscript(transcript);

  const text = rows
    .map(row => ({
      time: parseTimeToSeconds(row?.start ?? row?.time ?? row?.timestamp),
      text: String(row?.text ?? row?.content ?? '').trim()
    }))
    .filter(row => row.time !== null && row.time >= start && row.time < end && row.text)
    .map(row => row.text)
    .join(' ');

  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeFrameTimes(frames, frameTimes = []) {
  const source = Array.isArray(frameTimes) && frameTimes.length > 0 ? frameTimes : frames;
  if (!Array.isArray(source)) return [];

  return [...new Set(
    source
      .map(frame => {
        if (Number.isFinite(Number(frame)) && typeof frame !== 'object') return Number(frame);
        if (frame && typeof frame === 'object') {
          if (Number.isFinite(Number(frame.time))) return Number(frame.time);
          if (Number.isFinite(Number(frame.timestamp))) return Number(frame.timestamp);
          if (Number.isFinite(Number(frame.timestampMs))) return Number(frame.timestampMs) / 1000;
        }
        return null;
      })
      .filter(time => Number.isFinite(time) && time >= 0)
  )].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 事件层：原始事件全部保留
// ---------------------------------------------------------------------------

/**
 * 单个检测器输出 → 事件。
 * 无论时间是否合法都保留在事件列表里，只打 valid / invalidReason 标记，不静默丢弃。
 */
function toEvent(cut, source, index, duration) {
  const rawTime = cut?.time ?? cut?.timestamp ?? cut?.start_time ?? cut?.start;
  const time = parseTimeToSeconds(rawTime);
  const score = toFiniteNumber(cut?.score ?? cut?.confidence);

  let invalidReason = null;
  if (time === null) invalidReason = 'unparsable_time';
  else if (time < 0) invalidReason = 'negative_time';
  else if (Number.isFinite(duration) && duration > 0 && time > duration) invalidReason = 'beyond_duration';

  const reasons = Array.isArray(cut?.reasons)
    ? cut.reasons.filter(reason => typeof reason === 'string' && reason.trim())
    : [];

  return {
    id: `${source}#${index}`,
    source,
    time,
    rawTime: rawTime === undefined ? null : rawTime,
    score,
    reasons,
    valid: invalidReason === null,
    invalidReason,
    raw: cut
  };
}

/** 确定性排序：时间升序 → 来源优先级 → 原始序号；同输入必然同输出 */
function compareEvents(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  const rankDiff = sourceRank(a.source) - sourceRank(b.source);
  if (rankDiff !== 0) return rankDiff;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/**
 * 聚类。窗口以簇首事件为锚点：`event.time - anchorTime <= window` 才并入。
 * 这样簇的时间跨度恒 <= window，避免单链聚合把一串相距很远的同源事件连成一个大簇。
 */
function clusterEvents(events, windowSeconds = CLUSTER_WINDOW_SECONDS) {
  const usable = (Array.isArray(events) ? events : [])
    .filter(event => event && event.valid)
    .sort(compareEvents);

  const groups = [];
  let current = null;

  for (const event of usable) {
    if (!current || event.time - current.anchorTime > windowSeconds) {
      current = { anchorTime: event.time, members: [event] };
      groups.push(current);
      continue;
    }
    current.members.push(event);
  }

  return groups.map(group => {
    const times = group.members.map(member => member.time);
    const sources = [...new Set(group.members.map(member => member.source))]
      .sort((a, b) => sourceRank(a) - sourceRank(b));

    const perSourceCounts = {};
    for (const member of group.members) {
      perSourceCounts[member.source] = (perSourceCounts[member.source] || 0) + 1;
    }

    return {
      // 时间范围由真实事件时间构成，不含任何合成/平均出来的时刻
      start: Math.min(...times),
      end: Math.max(...times),
      span: Number((Math.max(...times) - Math.min(...times)).toFixed(3)),
      anchorTime: group.anchorTime,
      // 簇可信度 = 不同来源的数量。跨源分数一律不比较、不融合。
      sourceCount: sources.length,
      sources,
      memberCount: group.members.length,
      perSourceCounts,
      members: group.members.map(member => ({
        id: member.id,
        source: member.source,
        time: member.time,
        score: member.score,
        reasons: member.reasons
      }))
    };
  });
}

/** 归一化三个检测器的输出为事件列表 */
function buildDetectorEvents(input, duration) {
  const events = [];

  for (const { input: key, source } of DETECTOR_SOURCES) {
    const cuts = Array.isArray(input?.[key]) ? input[key] : [];
    cuts.forEach((cut, index) => {
      events.push(toEvent(cut, source, index, duration));
    });
  }

  return events;
}

/**
 * 旧链路兼容视图：解析时间、剔除非法项、按时间升序。
 *
 * 仅供仍在使用该字段的模块（candidateCutFusion 等）保持既有行为；
 * 新的下游应改用 events / clusters —— 那里不丢任何原始事件。
 */
function normalizeCutsForLegacy(cuts, duration) {
  if (!Array.isArray(cuts)) return { cuts: [], dropped: 0 };

  const hasDuration = Number.isFinite(duration) && duration > 0;
  let dropped = 0;

  const normalized = cuts
    .map(cut => {
      const time = parseTimeToSeconds(cut?.time ?? cut?.timestamp ?? cut?.start_time ?? cut?.start);
      if (time === null || time < 0) {
        dropped += 1;
        return null;
      }
      if (hasDuration && time > duration) {
        dropped += 1;
        return null;
      }
      return { ...cut, time };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  return { cuts: normalized, dropped };
}

// ---------------------------------------------------------------------------
// 证据组装
// ---------------------------------------------------------------------------

function inferMode({ visualCuts, audioCuts, keywordCuts, transcript }) {
  const hasVisual = Array.isArray(visualCuts) && visualCuts.length > 0;
  const hasAudio = Array.isArray(audioCuts) && audioCuts.length > 0;
  const hasKeywords = Array.isArray(keywordCuts) && keywordCuts.length > 0;
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;

  if (hasVisual && (hasAudio || hasKeywords || hasTranscript)) return 'full';
  if (hasVisual) return 'visual_only';
  if (hasTranscript || hasKeywords) return 'transcript_only';
  return 'fallback';
}

function inferConfidence(mode, candidateCount) {
  if (mode === 'full' && candidateCount >= 2) return 'high';
  if ((mode === 'full' || mode === 'transcript_only' || mode === 'visual_only') && candidateCount > 0) {
    return 'medium';
  }
  return 'low';
}

function buildEmptyEvidence(input = {}) {
  return {
    videoId: input.videoId || input.bvid || null,
    bvid: input.bvid || input.videoId || null,
    duration: 0,
    mode: 'fallback',
    confidence: 'low',
    frameTimes: [],
    transcript: [],
    transcriptText: '',
    visualCuts: [],
    audioCuts: [],
    keywordCuts: [],
    events: [],
    clusters: [],
    clusterWindowSeconds: CLUSTER_WINDOW_SECONDS,
    availableSources: { visual: false, audio: false, transcript: false, keyword: false },
    warnings: [],
    existingAnalysis: input.existingAnalysis || null,
    modelConfig: null
  };
}

function buildEvidence(input = {}) {
  if (!input || typeof input !== 'object') return buildEmptyEvidence({});

  const warnings = [];
  const warn = createWarningCollector(warnings);

  const rawDuration = toFiniteNumber(input.duration);
  if (input.duration !== undefined && input.duration !== null && rawDuration === null) {
    warn('invalid_duration_using_zero');
  }
  const duration = rawDuration !== null && rawDuration > 0 ? rawDuration : 0;

  const transcript = normalizeTranscript(input.transcript);
  const frameTimes = normalizeFrameTimes(input.frames, input.frameTimes);

  // 三路事件：全部保留，只打合法标记
  const events = buildDetectorEvents(input, duration);
  const invalidCounts = {};
  for (const event of events) {
    if (!event.valid) {
      invalidCounts[event.invalidReason] = (invalidCounts[event.invalidReason] || 0) + 1;
    }
  }
  for (const [reason, count] of Object.entries(invalidCounts)) {
    warn(`invalid_events_${reason}:${count}`);
  }

  const clusters = clusterEvents(events, CLUSTER_WINDOW_SECONDS);

  // 旧链路视图：保持 candidateCutFusion 等既有消费方的行为不变
  const legacyVisual = normalizeCutsForLegacy(input.visualCuts, duration);
  const legacyAudio = normalizeCutsForLegacy(input.audioCuts, duration);
  const legacyKeyword = normalizeCutsForLegacy(input.keywordCuts, duration);
  for (const [label, result] of [['visual', legacyVisual], ['audio', legacyAudio], ['keyword', legacyKeyword]]) {
    if (result.dropped > 0) warn(`dropped_invalid_${label}_cuts:${result.dropped}`);
  }

  if (transcript.length > 0 && transcript.every(item => !item.hasTimestamp)) {
    warn('transcript_missing_timestamps');
  }

  const mode = inferMode({
    visualCuts: legacyVisual.cuts,
    audioCuts: legacyAudio.cuts,
    keywordCuts: legacyKeyword.cuts,
    transcript
  });
  const confidence = inferConfidence(mode, clusters.filter(cluster => cluster.sourceCount >= 2).length);

  return {
    videoId: input.videoId || input.bvid || null,
    bvid: input.bvid || input.videoId || null,
    duration,
    mode,
    confidence,
    frameTimes,
    transcript,
    transcriptText: transcriptToText(transcript),

    // 旧链路视图：已归一化/过滤，仅供既有消费方使用
    visualCuts: legacyVisual.cuts,
    audioCuts: legacyAudio.cuts,
    keywordCuts: legacyKeyword.cuts,

    // 事件层：所有原始事件（含非法时间），时间戳原样保留，不删除任何来源
    events,
    // 聚类层：只打包，不选择；切点交下游决定
    clusters,
    clusterWindowSeconds: CLUSTER_WINDOW_SECONDS,

    availableSources: {
      visual: events.some(event => event.source === 'visual' && event.valid),
      audio: events.some(event => event.source === 'audio' && event.valid),
      transcript: transcript.length > 0,
      keyword: events.some(event => event.source === 'keyword' && event.valid)
    },
    warnings,
    existingAnalysis: input.existingAnalysis || null,
    modelConfig: input.modelConfig ? {
      textModel: input.modelConfig.textModel,
      visionModel: input.modelConfig.visionModel,
      baseUrl: input.modelConfig.baseUrl
    } : null
  };
}

module.exports = {
  buildEvidence,
  buildEmptyEvidence,
  inferConfidence,
  inferMode,
  // 事件与聚类层
  CLUSTER_WINDOW_SECONDS,
  DETECTOR_SOURCES,
  buildDetectorEvents,
  clusterEvents,
  // 供其他模块复用，避免出现第二套时间/转录解析
  parseTimeToSeconds,
  normalizeTranscript,
  normalizeFrameTimes,
  transcriptSnippet,
  toFiniteNumber,
  uniqueSorted,
  createWarningCollector
};
