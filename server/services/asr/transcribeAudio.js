/**
 * ASR 转写服务 - DashScope paraformer-v2 主方案
 * 输入: audioPath (WAV文件路径)
 * 输出: transcript[] = [{ start, end, text }]
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ossClient, hasOssConfig } = require('../../utils/oss');

const TAG = '[ASR:DashScope]';

/**
 * 使用阿里云 DashScope paraformer-v2 异步API 进行语音识别
 * @param {string} audioPath - 音频文件路径（WAV 格式，16kHz 单声道）
 * @param {object} options
 * @param {string} options.apiKey - DashScope API Key
 * @param {string} [options.asrModel='paraformer-v2'] - ASR 模型名称
 * @param {string} [options.bvid] - 视频BV号（用于OSS路径）
 * @param {function} [options.onProgress] - 进度回调
 * @returns {Promise<{transcript: Array<{start: number, end: number, text: string}>, raw: any}>}
 */
async function transcribeWithDashScope(audioPath, options = {}) {
  const {
    apiKey,
    asrModel = 'paraformer-v2',
    bvid = 'unknown',
    onProgress
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

  // 检查文件大小（限制 100MB）
  const stats = fs.statSync(audioPath);
  const fileSizeMB = stats.size / (1024 * 1024);
  if (fileSizeMB > 100) {
    throw new Error(`音频文件过大 (${fileSizeMB.toFixed(2)}MB)，超过 100MB 限制`);
  }

  console.log(`${TAG} 音频文件: ${audioPath} (${fileSizeMB.toFixed(2)}MB)`);

  // Step 1: 上传音频到 OSS
  console.log(`${TAG} 上传音频到 OSS...`);
  if (onProgress) onProgress('uploading', 20);

  const ossObjectName = `audio/${bvid}/${path.basename(audioPath)}`;
  try {
    await ossClient.put(ossObjectName, audioPath);
  } catch (error) {
    throw new Error(`OSS 上传失败: ${error.message}`);
  }

  const audioUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION || 'oss-cn-beijing'}.aliyuncs.com/${ossObjectName}`;
  console.log(`${TAG} 音频已上传: ${audioUrl}`);

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

  // Step 3: 轮询任务结果
  if (onProgress) onProgress('transcribing', 50);
  const maxAttempts = 60;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));
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
      return { transcript, raw: rawOutput };
    } else if (taskStatus === 'FAILED') {
      const msg = resultResponse.data.output?.message || '未知错误';
      throw new Error(`语音识别任务失败: ${msg}`);
    } else if (taskStatus !== 'RUNNING' && taskStatus !== 'PENDING') {
      throw new Error(`未知任务状态: ${taskStatus}`);
    }
  }

  throw new Error('语音识别任务超时（超过 2 分钟）');
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
 * 支持多种数据格式
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
  parseTranscriptionData
};
