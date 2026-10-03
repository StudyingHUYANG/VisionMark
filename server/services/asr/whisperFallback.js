/**
 * ASR Fallback - 本地 Whisper 转写
 * 当 DashScope 不可用时的降级方案
 * 通过 child_process 调用 Python whisper 脚本
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { killProcessTree } = require('../../utils/killProcessTree');

const TAG = '[ASR:Whisper]';
const SCRIPT_PATH = path.join(__dirname, '../../../scripts/whisper_transcribe.py');
/** 超时下限 10 分钟；音频更长时按时长放大（1 倍速的保守估计） */
const MIN_TIMEOUT_MS = 10 * 60 * 1000;

function resolveWhisperTimeoutMs(audioDurationSeconds) {
  const duration = Number(audioDurationSeconds);
  const scaled = Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0;
  return Math.max(MIN_TIMEOUT_MS, Math.round(scaled));
}

/**
 * 使用本地 Whisper 模型进行语音识别
 * @param {string} audioPath - 音频文件路径
 * @param {object} options
 * @param {string} [options.model='base'] - Whisper 模型大小 (tiny/base/small/medium/large)
 * @param {string} [options.language='zh'] - 语言提示
 * @param {string} [options.pythonPath='python'] - Python 可执行文件路径
 * @param {number} [options.audioDuration] - 音频时长（秒），用于按比例算超时
 * @param {function} [options.onProgress] - 进度回调
 * @returns {Promise<{transcript: Array<{start: number, end: number, text: string}>}>}
 */
async function transcribeWithWhisper(audioPath, options = {}) {
  const {
    model = 'base',
    language = 'zh',
    pythonPath = 'python',
    audioDuration = null,
    onProgress
  } = options;

  // 检查 Python 脚本是否存在
  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`Whisper 脚本不存在: ${SCRIPT_PATH}`);
  }

  // 检查音频文件
  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }

  console.log(`${TAG} 开始本地 Whisper 转写 (model=${model})...`);
  if (onProgress) onProgress('whisper_starting', 10);

  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT_PATH,
      '--audio', audioPath,
      '--model', model,
      '--language', language,
      '--output-format', 'json'
    ];

    const proc = spawn(pythonPath, args, {
      cwd: path.dirname(SCRIPT_PATH),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = resolveWhisperTimeoutMs(audioDuration);
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcessTree(proc);
      reject(new Error(`Whisper 转写超时（${Math.round(timeoutMs / 1000)}s，音频时长 ${audioDuration ? `${Math.round(audioDuration)}s` : '未知'}）`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      stderr += msg;
      // 解析进度信息
      if (msg.includes('%|')) {
        if (onProgress) onProgress('whisper_transcribing', 50);
      }
    });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        console.error(`${TAG} Whisper 进程退出码: ${code}`);
        console.error(`${TAG} stderr: ${stderr.substring(0, 500)}`);
        reject(new Error(`Whisper 转写失败 (exit code ${code}): ${stderr.substring(0, 200)}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        const transcript = (result.segments || result || []).map(seg => ({
          start: Number(seg.start) || 0,
          end: Number(seg.end) || 0,
          text: (seg.text || '').trim()
        }));

        console.log(`${TAG} 转写完成，共 ${transcript.length} 条记录`);
        if (onProgress) onProgress('done', 100);
        resolve({ transcript });
      } catch (parseError) {
        reject(new Error(`解析 Whisper 输出失败: ${parseError.message}`));
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`启动 Whisper 进程失败: ${err.message}（请确保已安装 Python 和 openai-whisper）`));
    });
  });
}

/**
 * 检查 Whisper 是否可用
 */
async function isWhisperAvailable(pythonPath = 'python') {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath, ['-c', 'import whisper; print(whisper.__version__)'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });

    setTimeout(() => {
      killProcessTree(proc);
      resolve(false);
    }, 5000);
  });
}

module.exports = {
  transcribeWithWhisper,
  isWhisperAvailable,
  resolveWhisperTimeoutMs
};
