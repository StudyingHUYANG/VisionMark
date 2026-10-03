/**
 * ASR 统一入口 - 自动 fallback
 *
 * 策略：
 *   1. 尝试 DashScope paraformer-v2（需要 OSS + API Key）
 *   2. 若失败 -> 尝试本地 Whisper
 *   3. 若都失败 -> 返回空结果 + 错误信息
 *
 * 使用方式：
 *   const { transcribe } = require('./services/asr');
 *   const result = await transcribe(audioPath, options);
 *
 * 降级原因通过 result.degradations 一并返回，调用方必须记进日志，不能静默吞掉。
 */

const { transcribeWithDashScope } = require('./transcribeAudio');
const { transcribeWithWhisper, isWhisperAvailable } = require('./whisperFallback');
const { probeAudioDuration } = require('./audioProbe');
const { buildEffectiveModelConfig } = require('../modelConfigService');

const TAG = '[ASR]';

/**
 * 转写音频文件（自动 fallback）
 * @param {string} audioPath - 音频文件路径（WAV 格式）
 * @param {object} [options={}]
 * @param {object} [options.userConfig] - 用户自定义模型配置
 * @param {string} [options.bvid] - 视频BV号
 * @param {string} [options.whisperModel='base'] - Whisper 模型大小
 * @param {string} [options.pythonPath='python'] - Python 路径
 * @param {function} [options.onProgress] - 进度回调 (stage, percent)
 * @returns {Promise<{transcript: Array<{start: number, end: number, text: string}>, provider: string, error?: string, degradations: string[]}>}
 */
async function transcribe(audioPath, options = {}) {
  const {
    userConfig = null,
    bvid = 'unknown',
    whisperModel = 'base',
    pythonPath = 'python',
    onProgress
  } = options;

  const modelConfig = buildEffectiveModelConfig(userConfig);
  const degradations = [];

  // 音频时长用于按比例算超时；拿不到就退回固定下限
  const probe = probeAudioDuration(audioPath);
  if (probe.duration) {
    console.log(`${TAG} 音频时长: ${probe.duration.toFixed(1)}s (来源=${probe.source})`);
  } else {
    console.warn(`${TAG} 无法探测音频时长，超时按固定下限计算`);
  }

  // 尝试方案 1: DashScope paraformer-v2
  try {
    console.log(`${TAG} 尝试 DashScope paraformer-v2...`);
    const result = await transcribeWithDashScope(audioPath, {
      apiKey: modelConfig.apiKey,
      asrModel: modelConfig.asrModel || 'paraformer-v2',
      bvid,
      audioDuration: probe.duration,
      onProgress
    });

    for (const note of result.degradations || []) {
      degradations.push(note);
      console.warn(`${TAG} 降级: ${note}`);
    }

    if (result.transcript && result.transcript.length > 0) {
      console.log(`${TAG} DashScope 转写成功，共 ${result.transcript.length} 条`);
      return {
        transcript: result.transcript,
        provider: 'dashscope',
        degradations
      };
    }

    degradations.push('DashScope 返回空结果');
    console.warn(`${TAG} DashScope 返回空结果，尝试 fallback...`);
  } catch (error) {
    degradations.push(`DashScope 失败: ${error.message}`);
    console.warn(`${TAG} DashScope 失败: ${error.message}，尝试 Whisper fallback...`);
  }

  // 尝试方案 2: 本地 Whisper
  try {
    const whisperAvailable = await isWhisperAvailable(pythonPath);
    if (!whisperAvailable) {
      degradations.push('Whisper 不可用（未安装 openai-whisper 或 Python 不可用）');
      console.warn(`${TAG} Whisper 不可用（未安装或 Python 不可用）`);
      return {
        transcript: [],
        provider: 'none',
        // 带上具体原因，避免「到底为什么没转写」在调用方一侧丢失
        error: `DashScope 失败且 Whisper 未安装: ${degradations.join('; ')}`,
        degradations
      };
    }

    console.log(`${TAG} 尝试本地 Whisper (model=${whisperModel})...`);
    const result = await transcribeWithWhisper(audioPath, {
      model: whisperModel,
      language: 'zh',
      pythonPath,
      audioDuration: probe.duration,
      onProgress
    });

    if (result.transcript && result.transcript.length > 0) {
      console.log(`${TAG} Whisper 转写成功，共 ${result.transcript.length} 条`);
      return {
        transcript: result.transcript,
        provider: 'whisper',
        degradations
      };
    }

    degradations.push('Whisper 返回空结果');
    return {
      transcript: [],
      provider: 'whisper',
      error: 'Whisper 返回空结果',
      degradations
    };
  } catch (whisperError) {
    degradations.push(`Whisper 失败: ${whisperError.message}`);
    console.error(`${TAG} Whisper 也失败: ${whisperError.message}`);
    return {
      transcript: [],
      provider: 'none',
      error: `所有 ASR 方案均失败。${degradations.join('; ')}`,
      degradations
    };
  }
}

module.exports = {
  transcribe
};
