/**
 * ASR 转写服务 - DashScope paraformer-v2 主方案
 * 输入: audioPath (WAV文件路径)
 * 输出: transcript[] = [{ start, end, text }]
 *
 * 时间戳全部来自识别结果（sentence 模式自带 begin_time/end_time），
 * 不做任何按比例插值——编造的时间戳会一路污染 keywordCuts 和契约里的 evidence。
 *
 * OSS 临时对象的生命周期（为什么这么做）：
 *  - 上传音频只是为了给 DashScope 异步任务一个可下载的 URL，任务到达终态
 *    （SUCCEEDED/FAILED）后文件即不再需要，所以本函数在"上传成功之后"的
 *    所有出口（提交失败、轮询到 FAILED、成功、我们自己超时放弃）都删掉本次上传的
 *    那一个对象，用 try/finally 兜住，避免任何一条异常路径把对象永久留在 OSS 上计费；
 *  - 如果我们自己超时放弃，远端任务可能还在跑，此时删掉对象会让它下载失败——
 *    这是可接受的取舍：我们这边已经放弃等待，留着对象只会持续计费；
 *  - 删除只允许用本次生成的精确对象名。任何情况下都不许在这里按前缀批量删，
 *    批量清理只能走 utils/oss.js 的 pruneAudioObjects / removeAudioObjectsFor 显式入口；
 *  - 删除失败只 console.warn，不影响转写结果的返回。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { ossClient, hasOssConfig, buildAudioObjectName, deleteOssObject } = require('../../utils/oss');
const { killProcessTree } = require('../../utils/killProcessTree');
const { toPositiveNumber } = require('../../utils/numberUtils');
const { probeAudioDuration } = require('./audioProbe');

const TAG = '[ASR:DashScope]';

/** DashScope 单文件上传上限 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 压缩副本：16kHz 单声道 64kbps，约 0.5MB/分钟，远低于 1MB/分钟 */
const COMPRESS_SAMPLE_RATE = 16000;
const COMPRESS_BITRATE = '64k';
/** 轮询超时：max(2min, 音频时长*0.5)，固定 2 分钟会让长视频必然超时 */
const MIN_POLL_TIMEOUT_MS = 120000;
const POLL_TIMEOUT_PER_AUDIO_SECOND_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 2000;
/** 压缩副本生成超时：同样按时长缩放 */
const MIN_COMPRESS_TIMEOUT_MS = 120000;
const COMPRESS_TIMEOUT_PER_AUDIO_SECOND_MS = 500;

function resolvePollTimeoutMs(audioDurationSeconds) {
  const duration = Number(audioDurationSeconds);
  const scaled = Number.isFinite(duration) && duration > 0 ? duration * POLL_TIMEOUT_PER_AUDIO_SECOND_MS : 0;
  return Math.max(MIN_POLL_TIMEOUT_MS, Math.round(scaled));
}

function resolveCompressTimeoutMs(audioDurationSeconds) {
  const duration = Number(audioDurationSeconds);
  const scaled = Number.isFinite(duration) && duration > 0 ? duration * COMPRESS_TIMEOUT_PER_AUDIO_SECOND_MS : 0;
  return Math.max(MIN_COMPRESS_TIMEOUT_MS, Math.round(scaled));
}

/** 压缩副本与原音频同目录：{bvid}.asr.mp3 */
function buildCompressedPath(audioPath, bvid) {
  const parsed = path.parse(audioPath);
  const base = path.basename(parsed.name) || bvid || 'audio';
  return path.join(parsed.dir, `${base}.asr.mp3`);
}

/** 用 ffmpeg 生成 16kHz 单声道 mp3 副本；失败/超时必须删掉半成品 */
function compressAudio(audioPath, outputPath, { timeoutMs, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i', audioPath,
      '-vn',
      '-ac', '1',
      '-ar', String(COMPRESS_SAMPLE_RATE),
      '-acodec', 'libmp3lame',
      '-b:a', COMPRESS_BITRATE,
      outputPath
    ];

    let child;
    let finished = false;
    let timedOut = false;
    let stderr = '';

    const cleanupPartial = () => {
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (_) {
        // 清理失败不影响错误上报
      }
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      timedOut = true;
      killProcessTree(child);
      cleanupPartial();
      reject(new Error(`音频压缩超时(${timeoutMs}ms)`));
    }, timeoutMs);

    try {
      child = spawnImpl(ffmpegPath, args, { windowsHide: true });
    } catch (error) {
      clearTimeout(timer);
      reject(new Error(`音频压缩启动失败: ${error.message}`));
      return;
    }

    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanupPartial();
      reject(new Error(`音频压缩失败: ${error.message}`));
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0 || timedOut) {
        cleanupPartial();
        reject(new Error(`音频压缩失败(退出码 ${code}): ${stderr.slice(-300)}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * 选择实际上传的文件：超过上限时改用压缩副本。
 * 压缩副本存在且不旧于源文件时直接复用，避免每次分析都重压。
 */
async function prepareUploadAudio(audioPath, options = {}) {
  const { bvid = 'unknown', audioDuration = null, degradations = [], spawnImpl = spawn } = options;

  const stats = fs.statSync(audioPath);
  if (stats.size <= MAX_UPLOAD_BYTES) {
    return { uploadPath: audioPath, uploadSize: stats.size, compressed: false };
  }

  const sourceSizeMB = stats.size / (1024 * 1024);
  const compressedPath = buildCompressedPath(audioPath, bvid);
  let compressedSize = null;

  if (fs.existsSync(compressedPath)) {
    const existing = fs.statSync(compressedPath);
    if (existing.size > 0 && existing.mtimeMs >= stats.mtimeMs) {
      compressedSize = existing.size;
      console.log(`${TAG} 复用已有压缩副本: ${compressedPath} (${(compressedSize / 1024 / 1024).toFixed(1)}MB)`);
    }
  }

  if (compressedSize === null) {
    console.log(`${TAG} 音频 ${sourceSizeMB.toFixed(1)}MB 超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限，生成压缩副本...`);
    await compressAudio(audioPath, compressedPath, {
      timeoutMs: resolveCompressTimeoutMs(audioDuration),
      spawnImpl
    });
    compressedSize = fs.statSync(compressedPath).size;
  }

  if (compressedSize > MAX_UPLOAD_BYTES) {
    throw new Error(
      `音频压缩后仍超过上传上限（${(compressedSize / 1024 / 1024).toFixed(1)}MB > ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`
    );
  }

  degradations.push(
    `音频 ${sourceSizeMB.toFixed(1)}MB 超过上传上限，已改用 ${COMPRESS_SAMPLE_RATE}Hz 单声道压缩副本`
    + `(${(compressedSize / 1024 / 1024).toFixed(1)}MB, ${COMPRESS_BITRATE})；音频切点仍使用无损 wav`
  );

  return { uploadPath: compressedPath, uploadSize: compressedSize, compressed: true };
}

/**
 * 使用阿里云 DashScope paraformer-v2 异步API 进行语音识别
 * @param {string} audioPath - 音频文件路径（WAV 格式，16kHz 单声道）
 * @param {object} options
 * @param {string} options.apiKey - DashScope API Key
 * @param {string} [options.asrModel='paraformer-v2'] - ASR 模型名称
 * @param {string} [options.bvid] - 视频BV号（用于OSS路径）
 * @param {number} [options.audioDuration] - 音频时长（秒），用于按比例算轮询超时
 * @param {function} [options.onProgress] - 进度回调
 * @returns {Promise<{transcript: Array<{start: number, end: number, text: string}>, raw: any, degradations: string[]}>}
 */
async function transcribeWithDashScope(audioPath, options = {}) {
  const {
    apiKey,
    asrModel = 'paraformer-v2',
    bvid = 'unknown',
    onProgress,
    spawnImpl = spawn,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  } = options;

  if (!apiKey) {
    throw new Error('缺少 apiKey 参数');
  }

  if (!ossClient || !hasOssConfig) {
    throw new Error('OSS 未配置，无法上传音频文件');
  }

  // 检查文件是否存在
  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }

  const degradations = [];
  // 上游时长探测失败时会传 null；Number(null) === 0 是有限数，直接判断会把它当成 0 秒，
  // "没给就现场探测"的兜底永远不可达，轮询超时也会被压到下限。
  const audioDuration = toPositiveNumber(options.audioDuration) ?? probeAudioDuration(audioPath).duration;

  // 超过上限不再直接放弃，改用压缩副本上传
  const { uploadPath, uploadSize, compressed } = await prepareUploadAudio(audioPath, {
    bvid,
    audioDuration,
    degradations,
    spawnImpl
  });

  const fileSizeMB = uploadSize / (1024 * 1024);
  console.log(`${TAG} 音频文件: ${uploadPath} (${fileSizeMB.toFixed(2)}MB${compressed ? ', 压缩副本' : ''})`);

  // Step 1: 上传音频到 OSS
  console.log(`${TAG} 上传音频到 OSS...`);
  if (onProgress) onProgress('uploading', 20);

  const ossObjectName = buildAudioObjectName(bvid, path.basename(uploadPath));
  try {
    await ossClient.put(ossObjectName, uploadPath);
  } catch (error) {
    throw new Error(`OSS 上传失败: ${error.message}`);
  }

  const audioUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION || 'oss-cn-beijing'}.aliyuncs.com/${ossObjectName}`;
  console.log(`${TAG} 音频已上传: ${audioUrl}`);

  // 上传成功之后无论走哪条路径（提交失败 / 轮询到 FAILED / 成功 / 我们自己超时放弃），
  // 都必须回收本次上传的这一个对象。delete 用与 put 相同的 ossClient，保证操作的是同一个桶。
  try {
    // Step 2: 提交异步 ASR 任务
    console.log(`${TAG} 提交语音识别任务...`);
    if (onProgress) onProgress('submitting', 30);

    const submitResponse = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
      {
        model: asrModel,
        input: {
          file_urls: [audioUrl]
        },
        parameters: {
          text_mode: 'sentence',
          language_hints: ['zh', 'en'],
          disfluency_removal: false,
          timestamp_alignment: true
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        }
      }
    );

    if (!submitResponse.data.output?.task_id) {
      throw new Error('提交任务失败，未获取到 task_id');
    }

    const taskId = submitResponse.data.output.task_id;
    console.log(`${TAG} 任务已提交: ${taskId}`);

    // Step 3: 轮询任务结果（超时按音频时长缩放）
    const intervalMs = Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) > 0
      ? Number(pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.round(Number(options.timeoutMs))
      : resolvePollTimeoutMs(audioDuration);
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

    if (onProgress) onProgress('transcribing', 50);
    console.log(`${TAG} 等待任务完成（最多 ${maxAttempts} 次 / ${(timeoutMs / 1000).toFixed(0)}s）`);

    let attempts = 0;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      attempts++;

      const resultResponse = await axios.get(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const taskStatus = resultResponse.data.output?.task_status;
      console.log(`${TAG} 任务状态: ${taskStatus} (${attempts}/${maxAttempts})`);

      if (onProgress) {
        const percent = 50 + Math.floor((attempts / maxAttempts) * 40);
        onProgress('transcribing', Math.min(percent, 90));
      }

      if (taskStatus === 'SUCCEEDED') {
        const rawOutput = resultResponse.data.output;
        const transcript = await parseTranscriptionResult(rawOutput, apiKey);
        console.log(`${TAG} 转写完成，共 ${transcript.length} 条记录`);
        if (onProgress) onProgress('done', 100);
        return { transcript, raw: rawOutput, degradations, uploadCompressed: compressed };
      } else if (taskStatus === 'FAILED') {
        const msg = resultResponse.data.output?.message || '未知错误';
        throw new Error(`语音识别任务失败: ${msg}`);
      } else if (taskStatus !== 'RUNNING' && taskStatus !== 'PENDING') {
        throw new Error(`未知任务状态: ${taskStatus}`);
      }
    }

    throw new Error(
      `语音识别任务超时（等待 ${(timeoutMs / 1000).toFixed(0)}s，`
      + `音频时长 ${audioDuration ? `${Math.round(audioDuration)}s` : '未知'}，轮询 ${attempts} 次）`
    );
  } finally {
    // 安全红线：只删本次运行刚刚上传的那一个对象，用精确对象名；
    // 这里绝不按前缀批量删，批量清理只能走 utils/oss.js 的显式入口。
    const removed = await deleteOssObject(ossObjectName, { client: ossClient });
    if (removed) {
      console.log(`${TAG} 已清理 OSS 临时对象: ${ossObjectName}`);
    }
  }
}

/**
 * 解析 DashScope 返回的转录结果为统一格式
 * @returns {Array<{start: number, end: number, text: string}>}
 */
async function parseTranscriptionResult(output, apiKey) {
  if (!output?.results || output.results.length === 0) {
    return [];
  }

  const firstResult = output.results[0];

  // 如果有 transcription_url，需要下载
  if (firstResult.transcription_url) {
    const response = await axios.get(firstResult.transcription_url);
    return parseTranscriptionData(response.data);
  }

  // 直接包含 transcription_text（旧格式兼容）
  if (firstResult.transcription_text) {
    return output.results.map(r => ({
      start: (r.begin_time || 0) / 1000,
      end: (r.end_time || r.begin_time || 0) / 1000,
      text: r.transcription_text || ''
    }));
  }

  return [];
}

/**
 * 解析从 transcription_url 下载的转录数据
 * 支持多种数据格式，时间戳一律取自原始的 begin_time/end_time
 */
function parseTranscriptionData(data) {
  const transcript = [];

  // 格式1: { transcripts: [{ sentences: [{ begin_time, end_time, text }] }] }
  if (data.transcripts && data.transcripts.length > 0) {
    const allSentences = data.transcripts.flatMap(t => t.sentences || []);
    for (const sentence of allSentences) {
      transcript.push({
        start: (sentence.begin_time || 0) / 1000,
        end: (sentence.end_time || sentence.begin_time || 0) / 1000,
        text: (sentence.text || '').trim()
      });
    }
    return transcript;
  }

  // 格式2: { transcription_lines: [{ text, begin_time, end_time }] }
  if (data.transcription_lines && data.transcription_lines.length > 0) {
    for (const line of data.transcription_lines) {
      transcript.push({
        start: (line.begin_time || 0) / 1000,
        end: (line.end_time || line.begin_time || 0) / 1000,
        text: (line.text || '').trim()
      });
    }
    return transcript;
  }

  // 格式3: 直接数组 [{ text, begin_time, end_time }]
  if (Array.isArray(data)) {
    for (const item of data) {
      transcript.push({
        start: (item.begin_time || 0) / 1000,
        end: (item.end_time || item.begin_time || 0) / 1000,
        text: (item.text || '').trim()
      });
    }
    return transcript;
  }

  console.warn(`${TAG} 无法解析转录数据结构`);
  return [];
}

module.exports = {
  transcribeWithDashScope,
  parseTranscriptionData,
  prepareUploadAudio,
  compressAudio,
  resolvePollTimeoutMs,
  resolveCompressTimeoutMs,
  MAX_UPLOAD_BYTES
};
