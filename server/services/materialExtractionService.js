const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ASSETS_DIR = path.join(__dirname, '../database/material_assets');
const VALID_BVID = /^BV[0-9A-Za-z]{10}$/;
const VALID_RUN_ID = /^[0-9a-f-]{36}$/i;
const VALID_FILE_NAME = /^clip_\d{3}_frame_\d{2}\.jpg$/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function assertBvid(bvid) {
  if (!VALID_BVID.test(String(bvid || ''))) throw new Error('非法 BVID');
  return String(bvid);
}

function assertRunId(runId) {
  if (!VALID_RUN_ID.test(String(runId || ''))) throw new Error('非法素材分析 runId');
  return String(runId);
}

function normalizeFrames(frames = []) {
  return (Array.isArray(frames) ? frames : [])
    .map(frame => ({
      framePath: String(frame?.framePath || frame?.path || ''),
      time: Number(frame?.time)
    }))
    .filter(frame => frame.framePath && Number.isFinite(frame.time) && fs.existsSync(frame.framePath))
    .sort((left, right) => left.time - right.time);
}

function normalizeSegments(segments = [], duration = 0) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const normalized = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const startTime = clamp(Number(segment?.start ?? segment?.startTime ?? segment?.start_time), 0, safeDuration);
      const endTime = clamp(Number(segment?.end ?? segment?.endTime ?? segment?.end_time), 0, safeDuration);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;
      return {
        sourceIndex: index,
        startTime,
        endTime,
        title: String(segment?.title || `素材片段 ${index + 1}`).trim(),
        summary: String(segment?.summary || segment?.description || '').trim(),
        type: String(segment?.type || 'unknown').toLowerCase(),
        confidence: String(segment?.confidence || 'low').toLowerCase()
      };
    })
    .filter(Boolean);

  if (!normalized.length && safeDuration > 0) {
    normalized.push({
      sourceIndex: 0,
      startTime: 0,
      endTime: safeDuration,
      title: '完整视频素材',
      summary: '',
      type: 'unknown',
      confidence: 'low'
    });
  }
  return normalized;
}

function selectRepresentativeFrames(segment, frames, limit = 3) {
  const candidates = normalizeFrames(frames).filter(frame => {
    return frame.time >= segment.startTime && frame.time <= segment.endTime;
  });
  if (!candidates.length) return [];

  const count = Math.max(1, Math.min(Number(limit) || 3, 5));
  const ratios = count === 1
    ? [0.5]
    : Array.from({ length: count }, (_, index) => 0.15 + (0.7 * index / (count - 1)));
  const selected = [];

  for (const ratio of ratios) {
    const target = segment.startTime + (segment.endTime - segment.startTime) * ratio;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const frame of candidates) {
      if (selected.some(item => item.framePath === frame.framePath)) continue;
      const distance = Math.abs(frame.time - target);
      if (distance < nearestDistance) {
        nearest = frame;
        nearestDistance = distance;
      }
    }
    if (nearest) selected.push(nearest);
  }

  return selected.sort((left, right) => left.time - right.time);
}

function materialScore(segment) {
  const confidenceScore = { high: 0.62, medium: 0.48, low: 0.32 }[segment.confidence] || 0.32;
  const typeScore = { content: 0.2, summary: 0.16, intro: 0.1, transition: 0.04, unknown: 0.06 }[segment.type] || 0.06;
  const duration = segment.endTime - segment.startTime;
  const durationScore = Math.min(duration, 30) / 30 * 0.12;
  const descriptionScore = segment.summary ? 0.06 : 0;
  return Number(clamp(confidenceScore + typeScore + durationScore + descriptionScore, 0, 1).toFixed(3));
}

function transcriptExcerpt(transcriptSegments, startTime, endTime, maxLength = 180) {
  const text = (Array.isArray(transcriptSegments) ? transcriptSegments : [])
    .filter(row => {
      const start = Number(row?.start);
      const end = Number(row?.end ?? row?.start);
      return Number.isFinite(start) && Number.isFinite(end) && end >= startTime && start <= endTime;
    })
    .map(row => String(row?.text || '').trim())
    .filter(Boolean)
    .join(' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function suggestedRange(segment, representativeFrames, clipSeconds) {
  const duration = segment.endTime - segment.startTime;
  const targetDuration = Math.min(duration, Math.max(2, Number(clipSeconds) || 8));
  const centerFrame = representativeFrames[Math.floor(representativeFrames.length / 2)];
  const center = centerFrame?.time ?? (segment.startTime + segment.endTime) / 2;
  let startTime = clamp(center - targetDuration / 2, segment.startTime, segment.endTime - targetDuration);
  let endTime = startTime + targetDuration;
  if (endTime > segment.endTime) {
    endTime = segment.endTime;
    startTime = Math.max(segment.startTime, endTime - targetDuration);
  }
  return {
    startTime: Number(startTime.toFixed(3)),
    endTime: Number(endTime.toFixed(3))
  };
}

function buildMaterialExtraction(input = {}, options = {}) {
  const bvid = assertBvid(input.bvid);
  const duration = Math.max(0, Number(input.duration) || 0);
  const runId = crypto.randomUUID();
  const assetsDir = path.resolve(options.assetsDir || DEFAULT_ASSETS_DIR);
  const runDir = path.join(assetsDir, bvid, runId);
  const maxClips = Math.max(1, Math.min(Number(options.maxClips) || 12, 30));
  const framesPerClip = Math.max(1, Math.min(Number(options.framesPerClip) || 3, 5));
  const minDuration = Math.max(0, Number(options.minDuration) || 3);
  const excludedTypes = new Set(options.excludedTypes || ['ad']);
  const frames = normalizeFrames(input.frames);

  const candidates = normalizeSegments(input.segments, duration)
    .filter(segment => !excludedTypes.has(segment.type))
    .filter(segment => segment.endTime - segment.startTime >= minDuration)
    .map(segment => ({ ...segment, score: materialScore(segment) }))
    .sort((left, right) => right.score - left.score || left.startTime - right.startTime)
    .slice(0, maxClips)
    .sort((left, right) => left.startTime - right.startTime);

  fs.mkdirSync(runDir, { recursive: true });
  const clips = candidates.map((segment, clipIndex) => {
    const representativeFrames = selectRepresentativeFrames(segment, frames, framesPerClip);
    const publicFrames = representativeFrames.map((frame, frameIndex) => {
      const fileName = `clip_${String(clipIndex + 1).padStart(3, '0')}_frame_${String(frameIndex + 1).padStart(2, '0')}.jpg`;
      fs.copyFileSync(frame.framePath, path.join(runDir, fileName));
      return {
        time: Number(frame.time.toFixed(3)),
        url: `/video-analysis/material-frames/${bvid}/${runId}/${fileName}`
      };
    });
    const suggested = suggestedRange(segment, representativeFrames, options.clipSeconds);
    return {
      id: `${runId}:${clipIndex + 1}`,
      sourceSegmentIndex: segment.sourceIndex,
      startTime: Number(segment.startTime.toFixed(3)),
      endTime: Number(segment.endTime.toFixed(3)),
      duration: Number((segment.endTime - segment.startTime).toFixed(3)),
      suggestedStartTime: suggested.startTime,
      suggestedEndTime: suggested.endTime,
      title: segment.title,
      summary: segment.summary,
      transcriptExcerpt: transcriptExcerpt(input.transcriptSegments, segment.startTime, segment.endTime),
      type: segment.type,
      confidence: segment.confidence,
      materialScore: segment.score,
      representativeFrames: publicFrames
    };
  });

  return {
    runId,
    generatedAt: new Date().toISOString(),
    clips
  };
}

function resolveMaterialFramePath({ bvid, runId, fileName }, options = {}) {
  const safeBvid = assertBvid(bvid);
  const safeRunId = assertRunId(runId);
  if (!VALID_FILE_NAME.test(String(fileName || ''))) throw new Error('非法代表帧文件名');
  const assetsDir = path.resolve(options.assetsDir || DEFAULT_ASSETS_DIR);
  const resolved = path.resolve(assetsDir, safeBvid, safeRunId, fileName);
  const expectedRoot = `${path.resolve(assetsDir, safeBvid, safeRunId)}${path.sep}`;
  if (!resolved.startsWith(expectedRoot)) throw new Error('非法代表帧路径');
  return resolved;
}

module.exports = {
  DEFAULT_ASSETS_DIR,
  buildMaterialExtraction,
  materialScore,
  normalizeSegments,
  resolveMaterialFramePath,
  selectRepresentativeFrames,
  suggestedRange,
  transcriptExcerpt
};
