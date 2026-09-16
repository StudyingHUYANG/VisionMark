const crypto = require('crypto');

function requireText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`segment.${field} 不能为空`);
  return text;
}

function optionalText(value) {
  return String(value || '').trim();
}

function normalizeSegment(segment, index = 0) {
  if (!segment || typeof segment !== 'object') throw new TypeError('segment 必须是对象');
  const videoId = requireText(segment.videoId || segment.bvid, 'videoId');
  const start = Number(segment.start ?? segment.start_time);
  const end = Number(segment.end ?? segment.end_time);
  if (!Number.isFinite(start) || start < 0) throw new TypeError('segment.start 必须是非负数字');
  if (!Number.isFinite(end) || end <= start) throw new TypeError('segment.end 必须大于 start');

  const title = optionalText(segment.title) || `Segment ${index + 1}`;
  const summary = optionalText(segment.summary || segment.description);
  const transcript = optionalText(segment.transcript || segment.text || segment.content);
  if (!summary && !transcript) throw new TypeError('segment.summary 和 segment.transcript 至少提供一个');
  const segmentId = optionalText(segment.segmentId || segment.id) || `${videoId}-${start}-${end}`;

  return { videoId, segmentId, start, end, title, summary, transcript };
}

function buildIndexText(segment) {
  return [
    `标题：${segment.title}`,
    segment.summary && `摘要：${segment.summary}`,
    segment.transcript && `字幕：${segment.transcript}`
  ].filter(Boolean).join('\n');
}

function stableRecordId(videoId, segmentId) {
  return crypto.createHash('sha256').update(`${videoId}\0${segmentId}`).digest('hex');
}

module.exports = { normalizeSegment, buildIndexText, stableRecordId };
