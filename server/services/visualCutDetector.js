const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { killProcessTree } = require('../utils/killProcessTree');
const { toPositiveNumber } = require('../utils/numberUtils');

const DEFAULT_VISUAL_CUT_OPTIONS = Object.freeze({
  histBins: 16,
  baseThreshold: 0.55,
  maxDynamicThreshold: 0.92,
  peakStdFactor: 1.35,
  ssimThreshold: 0.6,
  histThreshold: 0.38,
  phashThreshold: 0.32,
  strongThreshold: 0.72,
  minGapSeconds: 15.0,
  warmupSeconds: 1.5,
  ignoreEndSeconds: 15.0,
  ignoreEndMinDuration: 60.0,
  maxCuts: 80,
  weights: Object.freeze({
    ssim: 0.45,
    histogram: 0.35,
    phash: 0.20
  })
});

function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;

  const framePath = frame.framePath || frame.path;
  const time = Number(frame.time);

  if (!framePath || !Number.isFinite(time)) return null;

  return {
    framePath: path.resolve(String(framePath)),
    time
  };
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames)) return [];

  return frames
    .map(normalizeFrame)
    .filter(Boolean)
    // 次级排序键用路径：同一时间戳的帧在两次运行里顺序一致
    .sort((a, b) => (a.time - b.time) || a.framePath.localeCompare(b.framePath));
}

function mergeOptions(options = {}) {
  return {
    ...DEFAULT_VISUAL_CUT_OPTIONS,
    ...options,
    weights: {
      ...DEFAULT_VISUAL_CUT_OPTIONS.weights,
      ...(options.weights || {})
    }
  };
}

/** 有效 fps 由帧序列本身反推：这是让自适应阈值随输入漂移的那一环 */
function computeEffectiveFps(frames) {
  if (!Array.isArray(frames) || frames.length < 2) return null;
  const span = frames[frames.length - 1].time - frames[0].time;
  if (!(span > 0)) return null;
  return Number(((frames.length - 1) / span).toFixed(4));
}

const DEFAULT_VISUAL_CUT_TIMEOUT_MS = 120000;
const VISUAL_CUT_TIMEOUT_MS_PER_FRAME = 250;

/**
 * 超时按帧数缩放：长视频帧数多，固定 120s 必然超时并静默滑向 ffmpeg scene 回退。
 * timeoutMs 显式传入时优先。
 */
function resolveVisualCutTimeoutMs(frameCount, options = {}) {
  const explicit = Number(options.timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

  const minMs = Number.isFinite(Number(options.minTimeoutMs)) && Number(options.minTimeoutMs) > 0
    ? Number(options.minTimeoutMs)
    : DEFAULT_VISUAL_CUT_TIMEOUT_MS;
  const perFrameMs = Number.isFinite(Number(options.timeoutMsPerFrame)) && Number(options.timeoutMsPerFrame) > 0
    ? Number(options.timeoutMsPerFrame)
    : VISUAL_CUT_TIMEOUT_MS_PER_FRAME;
  const frames = Number.isFinite(Number(frameCount)) && Number(frameCount) > 0 ? Number(frameCount) : 0;

  return Math.max(minMs, Math.round(frames * perFrameMs));
}

function pickNumeric(...candidates) {
  for (const candidate of candidates) {
    if (Number.isFinite(Number(candidate)) && Number(candidate) > 0) return Number(candidate);
  }
  return null;
}

/**
 * 组装 metrics_fusion 路径的 stats。
 * 目的是让「两次跑结果不同」时能立刻定位到是哪一环变了：
 * 帧数 / 有效 fps / scale 宽度 / 阈值 / 分数分布 / 最小间隔 / 上限。
 */
function buildMetricsFusionStats({ frames, options, parsedStats, timeoutMs }) {
  const merged = mergeOptions(options);
  const probe = options?.probe && typeof options.probe === 'object' ? options.probe : {};

  return {
    // 先保留 Python 侧的全部字段（ignoreEndSeconds 等），再用下面这些显式覆盖
    ...(parsedStats && typeof parsedStats === 'object' ? parsedStats : {}),
    method: 'metrics_fusion',
    frameCount: Number.isFinite(Number(parsedStats?.frameCount)) ? Number(parsedStats.frameCount) : frames.length,
    transitionCount: Number.isFinite(Number(parsedStats?.transitionCount)) ? Number(parsedStats.transitionCount) : 0,
    threshold: Number.isFinite(Number(parsedStats?.threshold)) ? Number(parsedStats.threshold) : null,
    meanScore: Number.isFinite(Number(parsedStats?.meanScore)) ? Number(parsedStats.meanScore) : null,
    stdScore: Number.isFinite(Number(parsedStats?.stdScore)) ? Number(parsedStats.stdScore) : null,
    effectiveFps: Number.isFinite(Number(probe.effectiveFps)) ? Number(probe.effectiveFps) : computeEffectiveFps(frames),
    sampleFps: pickNumeric(probe.sampleFps, options?.sampleFps),
    scaleWidth: pickNumeric(probe.scaleWidth, options?.scaleWidth),
    minGapSeconds: Number.isFinite(Number(parsedStats?.minGapSeconds)) ? Number(parsedStats.minGapSeconds) : merged.minGapSeconds,
    maxCuts: Number.isFinite(Number(parsedStats?.maxCuts)) ? Number(parsedStats.maxCuts) : merged.maxCuts,
    baseThreshold: Number.isFinite(Number(parsedStats?.baseThreshold)) ? Number(parsedStats.baseThreshold) : merged.baseThreshold,
    peakStdFactor: Number.isFinite(Number(parsedStats?.peakStdFactor)) ? Number(parsedStats.peakStdFactor) : merged.peakStdFactor,
    warmupSeconds: Number.isFinite(Number(parsedStats?.warmupSeconds)) ? Number(parsedStats.warmupSeconds) : merged.warmupSeconds,
    timeoutMs,
    durationSource: typeof probe.durationSource === 'string' ? probe.durationSource : null,
    probeCached: typeof probe.cached === 'boolean' ? probe.cached : null
  };
}

function resolvePythonCommand() {
  const candidates = ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return command;
  }
  return 'python';
}

async function analyzeVisualCuts(frames, options = {}) {
  const normalizedFrames = normalizeFrames(frames);
  if (normalizedFrames.length < 2) {
    return {
      visualCuts: [],
      stats: buildMetricsFusionStats({
        frames: normalizedFrames,
        options,
        parsedStats: null,
        timeoutMs: resolveVisualCutTimeoutMs(normalizedFrames.length, options)
      })
    };
  }

  const scriptPath = path.join(__dirname, 'visual_cut_metrics.py');
  const timeoutMs = resolveVisualCutTimeoutMs(normalizedFrames.length, options);
  const payload = JSON.stringify({
    frames: normalizedFrames,
    options: mergeOptions(options),
    includeDebug: Boolean(options.includeDebug)
  });
  const pythonCommand = options.pythonCommand || resolvePythonCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [scriptPath], {
      cwd: path.join(__dirname, '..', '..'),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcessTree(child);
      reject(new Error(`视觉切点检测超时(${timeoutMs}ms, frames=${normalizedFrames.length})`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    let stdinError = null;

    child.stdin.on('error', error => {
      stdinError = error;
    });

    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch (error) {
        reject(new Error(`视觉切点检测输出解析失败: ${error.message}; stderr=${stderr}`));
        return;
      }

      if (code !== 0 || parsed?.error) {
        reject(new Error(parsed?.error || stderr || stdinError?.message || `视觉切点检测进程退出码 ${code}`));
        return;
      }

      // 切点顺序固定：时间升序，同分同时间再按分数降序，保证同输入两次运行输出一致
      const visualCuts = Array.isArray(parsed.visualCuts)
        ? parsed.visualCuts
          .slice()
          .sort((a, b) => (Number(a?.time) - Number(b?.time)) || (Number(b?.score) - Number(a?.score)))
        : [];

      resolve({
        visualCuts,
        stats: buildMetricsFusionStats({
          frames: normalizedFrames,
          options,
          parsedStats: parsed.stats,
          timeoutMs
        }),
        transitions: Array.isArray(parsed.transitions) ? parsed.transitions : undefined
      });
    });

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`视觉切点检测输入失败: ${error.message}`));
    }
  });
}

async function getVisualCuts(frames, options = {}) {
  const result = await analyzeVisualCuts(frames, options);
  return result.visualCuts;
}

function parseShowinfoTimes(stderr) {
  return [...String(stderr || '').matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map(match => Number(match[1]))
    .filter(time => Number.isFinite(time) && time >= 0)
    .filter((time, index, list) => index === 0 || Math.abs(time - list[index - 1]) > 0.5);
}

async function analyzeSceneCutsWithFfmpeg(videoPath, options = {}) {
  // Number(null) === 0 会被 Number.isFinite 放行，显式传 null 就成了阈值 0：
  // ffmpeg 的 select='gt(scene,0)' 几乎选中每一帧，输出量与耗时都会爆。
  // 改用 toPositiveNumber，null/undefined/''/NaN/<=0 一律回退默认 0.32。
  const sceneThreshold = toPositiveNumber(options.sceneThreshold) ?? 0.32;
  // 同理：minGapSeconds 为 0 会让"最小间隔"约束完全失效（每个 scene 变化都被收下），
  // 显式传 null/0 时回退 15。
  const minGapSeconds = toPositiveNumber(options.minGapSeconds) ?? 15;
  // null/undefined/' '/0 都视为"未提供"：Number.isFinite(Number(null)) 为真且等 0，
  // 会让检测定时器以 0ms 立即触发；toPositiveNumber 连 > 0 守卫一起带上，直接回退 120s。
  const timeoutMs = toPositiveNumber(options.timeoutMs) ?? 120000;
  const absoluteVideoPath = path.resolve(String(videoPath || ''));

  if (!fs.existsSync(absoluteVideoPath)) {
    return {
      visualCuts: [],
      stats: {
        method: 'ffmpeg_scene',
        frameCount: 0,
        transitionCount: 0,
        threshold: sceneThreshold,
        meanScore: null,
        stdScore: null,
        effectiveFps: null,
        scaleWidth: null,
        sampleFps: null,
        minGapSeconds,
        maxCuts: null,
        timeoutMs
      }
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-i', absoluteVideoPath,
      '-an',
      '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
      '-vsync', 'vfr',
      '-f', 'null',
      '-'
    ], { windowsHide: true });

    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcessTree(child);
      reject(new Error(`ffmpeg scene 检测超时(${timeoutMs}ms)`));
    }, timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg scene 检测进程退出码 ${code}`));
        return;
      }

      const selected = [];
      for (const time of parseShowinfoTimes(stderr)) {
        if (selected.length && time - selected[selected.length - 1].time < minGapSeconds) continue;
        selected.push({
          time: Number(time.toFixed(3)),
          score: Number(Math.max(0.45, Math.min(0.9, sceneThreshold + 0.35)).toFixed(3)),
          reasons: ['visual_change', 'scene_change', 'ffmpeg_scene'],
          method: 'ffmpeg_scene',
          metrics: {
            sceneThreshold
          }
        });
      }

      // 时间升序 + 分数降序，同输入两次运行的切点序列完全一致
      selected.sort((a, b) => (a.time - b.time) || (b.score - a.score));

      resolve({
        visualCuts: selected,
        stats: {
          method: 'ffmpeg_scene',
          frameCount: null,
          transitionCount: selected.length,
          threshold: sceneThreshold,
          meanScore: null,
          stdScore: null,
          effectiveFps: null,
          scaleWidth: null,
          sampleFps: null,
          minGapSeconds,
          maxCuts: null,
          timeoutMs
        }
      });
    });
  });
}

function framesFromTimestampedDirectory(framesDir) {
  const absoluteDir = path.resolve(framesDir);
  if (!fs.existsSync(absoluteDir)) return [];

  return fs.readdirSync(absoluteDir)
    .filter(file => /\.(jpe?g|png|webp)$/i.test(file))
    .map((file, index) => {
      const timestampMatch = file.match(/^frame_\d+_(\d+)\.(?:jpe?g|png|webp)$/i);
      const numericMatch = file.match(/(\d+)\.(?:jpe?g|png|webp)$/i);
      const timestampMs = timestampMatch
        ? Number(timestampMatch[1])
        : Number.NaN;
      const fallbackIndex = numericMatch ? Number(numericMatch[1]) - 1 : index;

      return {
        framePath: path.join(absoluteDir, file),
        time: Number.isFinite(timestampMs)
          ? timestampMs / 1000
          : Math.max(0, fallbackIndex)
      };
    })
    .filter(frame => Number.isFinite(frame.time))
    .sort((a, b) => (a.time - b.time) || a.framePath.localeCompare(b.framePath));
}

module.exports = {
  DEFAULT_VISUAL_CUT_OPTIONS,
  analyzeVisualCuts,
  analyzeSceneCutsWithFfmpeg,
  getVisualCuts,
  framesFromTimestampedDirectory,
  resolveVisualCutTimeoutMs,
  buildMetricsFusionStats,
  computeEffectiveFps
};
