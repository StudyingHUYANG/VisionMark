/**
 * 音频切点检测服务
 * 通过 FFmpeg 检测音频中的静音段和音量突变点
 * 
 * 输入: audioPath (WAV文件路径)
 * 输出: audioCuts[] = [{ time, score, reasons }]
 */

const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const execPromise = util.promisify(exec);
const TAG = '[AudioCuts]';

// ============ 配置常量 ============

/** 静音检测：噪声门限 (dB) */
const SILENCE_NOISE_DB = -30;
/** 静音检测：最短静音时长 (秒) */
const SILENCE_MIN_DURATION = 0.5;
/** 音量检测：时间窗口 (秒) */
const VOLUME_WINDOW_SEC = 1.0;
/** 音量检测：RMS 差值阈值 (dB) - 相邻窗口差值超过此值标记为切点 */
const VOLUME_CHANGE_THRESHOLD_DB = 8;
/** 去重：两个切点间最小间隔 (秒) */
const MIN_CUT_INTERVAL = 2.0;

/**
 * 检测音频切点（静音 + 音量变化）
 * @param {string} audioPath - 音频文件路径
 * @param {object} [options={}]
 * @param {number} [options.silenceNoiseDb=-30] - 静音噪声门限
 * @param {number} [options.silenceMinDuration=0.5] - 最短静音时长
 * @param {number} [options.volumeWindowSec=1.0] - 音量分析窗口
 * @param {number} [options.volumeChangeThresholdDb=8] - 音量变化阈值
 * @returns {Promise<Array<{time: number, score: number, reasons: string[]}>>}
 */
async function detectAudioCuts(audioPath, options = {}) {
  const {
    silenceNoiseDb = SILENCE_NOISE_DB,
    silenceMinDuration = SILENCE_MIN_DURATION,
    volumeWindowSec = VOLUME_WINDOW_SEC,
    volumeChangeThresholdDb = VOLUME_CHANGE_THRESHOLD_DB
  } = options;

  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }

  console.log(`${TAG} 开始检测音频切点: ${audioPath}`);

  // 并行执行两种检测
  const [silenceCuts, volumeCuts] = await Promise.all([
    detectSilence(audioPath, silenceNoiseDb, silenceMinDuration),
    detectVolumeChanges(audioPath, volumeWindowSec, volumeChangeThresholdDb)
  ]);

  console.log(`${TAG} 静音切点: ${silenceCuts.length} 个, 音量切点: ${volumeCuts.length} 个`);

  // 合并并去重
  const merged = mergeCuts(silenceCuts, volumeCuts);
  console.log(`${TAG} 合并去重后: ${merged.length} 个切点`);

  return merged;
}

/**
 * 静音检测 - 使用 FFmpeg silencedetect
 * 将静音结束时刻作为候选切点（静音结束 = 新内容开始）
 */
async function detectSilence(audioPath, noiseDb, minDuration) {
  const command = `"${ffmpegPath}" -i "${audioPath}" -af silencedetect=noise=${noiseDb}dB:d=${minDuration} -f null -`;

  try {
    const { stderr } = await execPromise(command, {
      shell: true,
      maxBuffer: 10 * 1024 * 1024
    });

    const cuts = [];
    // 解析 silencedetect 输出
    // 格式: [silencedetect @ ...] silence_end: 5.234 | silence_duration: 0.8
    const regex = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
    let match;

    while ((match = regex.exec(stderr)) !== null) {
      const silenceEnd = parseFloat(match[1]);
      const silenceDuration = parseFloat(match[2]);

      // 评分：静音时长越长，分数越高（0.5 - 0.8）
      const score = Math.min(0.8, 0.5 + (silenceDuration - minDuration) * 0.1);

      cuts.push({
        time: Math.round(silenceEnd * 100) / 100,
        score: Math.round(score * 100) / 100,
        reasons: ['silence'],
        _silenceDuration: silenceDuration
      });
    }

    return cuts;
  } catch (error) {
    console.error(`${TAG} 静音检测失败:`, error.message);
    return [];
  }
}

/**
 * 音量变化检测 - 使用 FFmpeg astats 按窗口计算 RMS
 * 相邻窗口 RMS 差值超过阈值则标记为切点
 */
async function detectVolumeChanges(audioPath, windowSec, thresholdDb) {
  // 使用 ffprobe 获取音频时长
  const duration = await getAudioDuration(audioPath);
  if (!duration || duration <= 0) {
    console.warn(`${TAG} 无法获取音频时长`);
    return [];
  }

  // 使用 FFmpeg 按固定窗口计算每段 RMS 值
  // 通过 loudnorm 的 measured_I 或使用 astats 的 RMS_level
  const rmsValues = await computeRmsPerWindow(audioPath, windowSec, duration);

  if (rmsValues.length < 2) {
    return [];
  }

  const cuts = [];

  for (let i = 1; i < rmsValues.length; i++) {
    const diff = Math.abs(rmsValues[i] - rmsValues[i - 1]);

    if (diff >= thresholdDb) {
      const time = i * windowSec;
      // 评分：基于差值归一化到 0.3-0.9
      const score = Math.min(0.9, 0.3 + (diff - thresholdDb) / 20 * 0.6);

      cuts.push({
        time: Math.round(time * 100) / 100,
        score: Math.round(score * 100) / 100,
        reasons: ['volume_change'],
        _rmsDiff: Math.round(diff * 100) / 100
      });
    }
  }

  return cuts;
}

/**
 * 获取音频时长 (秒) - 使用 ffmpeg 解析
 */
async function getAudioDuration(audioPath) {
  // 方案 1：用 ffmpeg -i 获取 duration
  const command = `"${ffmpegPath}" -i "${audioPath}" -f null - 2>&1`;
  try {
    const result = await execPromise(command, { shell: true }).catch(e => ({
      stdout: e.stdout || '',
      stderr: e.stderr || e.message || ''
    }));
    const output = result.stderr || result.stdout || '';
    // 解析 Duration: 00:01:23.45
    const match = output.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (match) {
      return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
    }
  } catch (_) {}

  // 方案 2：用 WAV 文件头计算（仅限 PCM WAV）
  try {
    const stats = fs.statSync(audioPath);
    // WAV PCM 16-bit mono 16kHz: 每秒 32000 字节
    const headerSize = 44; // 标准 WAV 头
    const bytesPerSecond = 16000 * 2 * 1; // sampleRate * bytesPerSample * channels
    const dataSize = stats.size - headerSize;
    if (dataSize > 0) {
      return dataSize / bytesPerSecond;
    }
  } catch (_) {}

  return 0;
}

/**
 * 按窗口计算 RMS 能量 (dB)
 * 使用 FFmpeg astats 滤镜 + segment 实现分段统计
 */
async function computeRmsPerWindow(audioPath, windowSec, totalDuration) {
  // 使用 volume filter 输出每帧的 RMS，然后按窗口聚合
  // 更可靠的方案：使用 afade 分段 + astats
  // 实际采用：使用 ebur128 或简单的分段 volumedetect

  // 方案：通过 lavfi astats 的 reset 参数按帧统计，然后聚合
  const framesPerWindow = Math.ceil(windowSec * 100); // 假设100fps的统计率
  const command = `"${ffmpegPath}" -i "${audioPath}" -af astats=metadata=1:reset=${framesPerWindow} -f null - 2>&1`;

  try {
    const { stdout, stderr } = await execPromise(command, {
      shell: true,
      maxBuffer: 50 * 1024 * 1024
    }).catch(e => ({ stdout: '', stderr: e.stderr || e.stdout || '' }));

    const output = stderr || stdout || '';

    // 解析 lavfi.astats.Overall.RMS_level
    const rmsRegex = /lavfi\.astats\.Overall\.RMS_level=([-\d.]+)/g;
    const allRms = [];
    let m;
    while ((m = rmsRegex.exec(output)) !== null) {
      const val = parseFloat(m[1]);
      if (isFinite(val)) {
        allRms.push(val);
      }
    }

    if (allRms.length > 0) {
      // astats reset 已经按窗口输出，直接使用最后一帧的值作为窗口RMS
      // 每个 reset 周期输出一次统计，取每个周期最后的值
      return allRms;
    }

    // 备选方案：如果 astats 无输出，使用简单的分段 volumedetect
    return await computeRmsFallback(audioPath, windowSec, totalDuration);
  } catch (error) {
    console.warn(`${TAG} astats 计算失败，使用备选方案:`, error.message);
    return await computeRmsFallback(audioPath, windowSec, totalDuration);
  }
}

/**
 * 备选 RMS 计算方案：逐段提取并使用 volumedetect
 */
async function computeRmsFallback(audioPath, windowSec, totalDuration) {
  const windowCount = Math.ceil(totalDuration / windowSec);
  // 限制最大窗口数，避免执行太多命令
  const maxWindows = Math.min(windowCount, 600);
  const actualWindowSec = totalDuration / maxWindows;

  const rmsValues = [];

  // 批量执行，每次处理一段
  for (let i = 0; i < maxWindows; i++) {
    const startTime = i * actualWindowSec;
    const command = `"${ffmpegPath}" -ss ${startTime} -t ${actualWindowSec} -i "${audioPath}" -af volumedetect -f null - 2>&1`;

    try {
      const result = await execPromise(command, {
        shell: true,
        maxBuffer: 1024 * 1024
      }).catch(e => ({ stdout: '', stderr: e.stderr || e.stdout || '' }));

      const output = result.stderr || result.stdout || '';
      const meanMatch = output.match(/mean_volume:\s*([-\d.]+)/);
      if (meanMatch) {
        rmsValues.push(parseFloat(meanMatch[1]));
      } else {
        rmsValues.push(-Infinity);
      }
    } catch (_) {
      rmsValues.push(-Infinity);
    }
  }

  return rmsValues;
}

/**
 * 合并静音切点和音量切点，去重
 */
function mergeCuts(silenceCuts, volumeCuts) {
  // 合并所有切点
  const allCuts = [...silenceCuts, ...volumeCuts];

  // 按时间排序
  allCuts.sort((a, b) => a.time - b.time);

  // 去重：相距 MIN_CUT_INTERVAL 内的合并
  const merged = [];

  for (const cut of allCuts) {
    const last = merged[merged.length - 1];

    if (last && Math.abs(cut.time - last.time) < MIN_CUT_INTERVAL) {
      // 合并：取更高分，合并 reasons
      if (cut.score > last.score) {
        last.score = cut.score;
      }
      for (const reason of cut.reasons) {
        if (!last.reasons.includes(reason)) {
          last.reasons.push(reason);
        }
      }
    } else {
      // 新切点（去除内部调试字段）
      merged.push({
        time: cut.time,
        score: cut.score,
        reasons: [...cut.reasons]
      });
    }
  }

  return merged;
}

module.exports = {
  detectAudioCuts
};
