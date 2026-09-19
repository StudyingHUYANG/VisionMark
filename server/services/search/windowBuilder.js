const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parts = String(value || '').split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function normalizeTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map(item => ({
        start: Number(item.start),
        end: Number(item.end ?? item.start),
        text: String(item.text || '').trim()
      }))
      .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.text)
      .sort((a, b) => a.start - b.start);
  }

  if (typeof transcript !== 'string' || !transcript.trim()) return [];
  const rows = transcript.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsed = rows.map(line => {
    const match = line.match(/^\[([^\]]+)]\s*(.*)$/);
    if (!match) return null;
    const start = parseTimestamp(match[1]);
    return Number.isFinite(start) && match[2] ? { start, end: start, text: match[2] } : null;
  }).filter(Boolean);

  for (let index = 0; index < parsed.length; index += 1) {
    const nextStart = parsed[index + 1]?.start;
    parsed[index].end = Number.isFinite(nextStart)
      ? Math.max(parsed[index].start, nextStart)
      : parsed[index].start + 4;
  }
  return parsed;
}

function formatTranscript(transcript) {
  return normalizeTranscript(transcript).map(item => {
    const minutes = Math.floor(item.start / 60);
    const seconds = Math.floor(item.start % 60).toString().padStart(2, '0');
    return `[${minutes}:${seconds}] ${item.text}`;
  }).join('\n');
}

function buildWindows(duration, boundaries = [], options = {}) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  if (!safeDuration) return [];
  const baseWindow = Number(options.windowSeconds) || 8;
  const baseStride = Number(options.strideSeconds) || 4;
  const maxBaseWindows = Number(options.maxBaseWindows) || 450;
  const maxWindows = Number(options.maxWindows) || 600;
  const stride = Math.max(baseStride, safeDuration / maxBaseWindows);
  const windowSeconds = Math.max(baseWindow, stride * 2);
  const windows = [];

  for (let start = 0; start < safeDuration; start += stride) {
    const end = Math.min(safeDuration, start + windowSeconds);
    windows.push({ start, end, priority: 0 });
    if (end >= safeDuration) break;
  }

  for (const rawBoundary of boundaries) {
    const boundary = Number(rawBoundary);
    if (!Number.isFinite(boundary) || boundary < 0 || boundary > safeDuration) continue;
    const start = clamp(boundary - windowSeconds / 2, 0, Math.max(0, safeDuration - windowSeconds));
    windows.push({ start, end: Math.min(safeDuration, start + windowSeconds), priority: 1 });
  }

  const deduped = [];
  for (const candidate of windows.sort((a, b) => b.priority - a.priority || a.start - b.start)) {
    if (deduped.some(item => Math.abs(item.start - candidate.start) < Math.max(0.5, stride * 0.25))) continue;
    deduped.push(candidate);
  }

  let selected = deduped;
  if (selected.length > maxWindows) {
    const important = selected.filter(item => item.priority > 0);
    const regular = selected.filter(item => item.priority === 0);
    const remaining = Math.max(0, maxWindows - important.length);
    const sampled = [];
    for (let index = 0; index < remaining; index += 1) {
      sampled.push(regular[Math.floor((index * regular.length) / Math.max(remaining, 1))]);
    }
    selected = [...important.slice(0, maxWindows), ...sampled.filter(Boolean)].slice(0, maxWindows);
  }

  return selected
    .sort((a, b) => a.start - b.start)
    .map((item, index) => ({
      id: `w_${String(index + 1).padStart(4, '0')}_${Math.round(item.start * 1000)}`,
      startTime: Number(item.start.toFixed(3)),
      endTime: Number(item.end.toFixed(3))
    }));
}

function attachTranscript(windows, transcript) {
  const rows = normalizeTranscript(transcript);
  return windows.map(window => ({
    ...window,
    transcript: rows
      .filter(row => row.end >= window.startTime && row.start <= window.endTime)
      .map(row => row.text)
      .join(' ')
      .trim()
  }));
}

function nearestFrame(frames, target) {
  let best = null;
  let distance = Infinity;
  for (const frame of frames) {
    const current = Math.abs(Number(frame.time) - target);
    if (current < distance) {
      best = frame;
      distance = current;
    }
  }
  return best;
}

function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) return Infinity;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const value = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    distance += value.toString(2).split('1').length - 1;
  }
  return distance;
}

function selectRepresentativeFrames(window, frames, hashes = {}) {
  const duration = window.endTime - window.startTime;
  const targets = [0.2, 0.5, 0.8].map(ratio => window.startTime + duration * ratio);
  const selected = [];
  for (const target of targets) {
    const frame = nearestFrame(frames, target);
    if (!frame || selected.some(item => item.framePath === frame.framePath)) continue;
    const hash = hashes[frame.framePath];
    if (selected.some(item => hammingDistance(hash, hashes[item.framePath]) <= 6)) continue;
    selected.push(frame);
  }
  return selected;
}

function runHashProcess(command, args, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `哈希脚本退出码 ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(paths));
  });
}

async function computeFrameHashes(frames) {
  const paths = [...new Set(frames.map(frame => frame.framePath).filter(Boolean))];
  if (!paths.length) return {};
  const script = path.join(__dirname, 'frame_hashes.py');
  const attempts = process.platform === 'win32'
    ? [['python', [script]], ['py', ['-3', script]]]
    : [['python3', [script]], ['python', [script]]];
  let lastError;
  for (const [command, args] of attempts) {
    try {
      return await runHashProcess(command, args, paths);
    } catch (error) {
      lastError = error;
    }
  }
  console.warn('[SearchIndex] 感知哈希不可用，跳过去重:', lastError?.message);
  return {};
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

module.exports = {
  attachTranscript,
  buildWindows,
  computeFrameHashes,
  ensureDirectory,
  formatTranscript,
  hammingDistance,
  normalizeTranscript,
  selectRepresentativeFrames
};
