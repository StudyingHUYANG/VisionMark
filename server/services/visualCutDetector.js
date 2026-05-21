const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

  return new Promise((resolve, reject) => {
    const child = spawn('python', [scriptPath], {
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
        reject(new Error(parsed?.error || stderr || `视觉切点检测进程退出码 ${code}`));
        return;
      }

      resolve({
        visualCuts: Array.isArray(parsed.visualCuts) ? parsed.visualCuts : [],
        stats: parsed.stats || null,
        transitions: Array.isArray(parsed.transitions) ? parsed.transitions : undefined
      });
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

async function getVisualCuts(frames, options = {}) {
  const result = await analyzeVisualCuts(frames, options);
  return result.visualCuts;
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
  getVisualCuts,
  framesFromTimestampedDirectory
};
