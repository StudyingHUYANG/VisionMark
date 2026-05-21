const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

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
    .sort((a, b) => a.time - b.time);
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
      stats: {
        frameCount: normalizedFrames.length,
        transitionCount: 0,
        threshold: null,
        meanScore: 0,
        stdScore: 0
      }
    };
  }

  const scriptPath = path.join(__dirname, 'visual_cut_metrics.py');
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 120000;
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
      child.kill();
      reject(new Error(`视觉切点检测超时(${timeoutMs}ms)`));
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

      resolve({
        visualCuts: Array.isArray(parsed.visualCuts) ? parsed.visualCuts : [],
        stats: parsed.stats || null,
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
  const sceneThreshold = Number.isFinite(Number(options.sceneThreshold))
    ? Number(options.sceneThreshold)
    : 0.32;
  const minGapSeconds = Number.isFinite(Number(options.minGapSeconds))
    ? Number(options.minGapSeconds)
    : 15;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 120000;
  const absoluteVideoPath = path.resolve(String(videoPath || ''));

  if (!fs.existsSync(absoluteVideoPath)) {
    return {
      visualCuts: [],
      stats: {
        frameCount: 0,
        transitionCount: 0,
        threshold: sceneThreshold,
        meanScore: 0,
        stdScore: 0,
        method: 'ffmpeg_scene'
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
      child.kill();
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

      resolve({
        visualCuts: selected,
        stats: {
          frameCount: null,
          transitionCount: selected.length,
          threshold: sceneThreshold,
          meanScore: null,
          stdScore: null,
          minGapSeconds,
          method: 'ffmpeg_scene'
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
    .sort((a, b) => a.time - b.time);
}

module.exports = {
  DEFAULT_VISUAL_CUT_OPTIONS,
  analyzeVisualCuts,
  analyzeSceneCutsWithFfmpeg,
  getVisualCuts,
  framesFromTimestampedDirectory
};
