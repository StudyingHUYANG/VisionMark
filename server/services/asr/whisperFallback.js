/**
 * ASR Fallback - 本地 Whisper 转写
 * 当 DashScope 不可用时的降级方案
 * 通过 child_process 调用 Python whisper 脚本
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TAG = '[ASR:Whisper]';
const SCRIPT_PATH = path.join(__dirname, '../../../scripts/whisper_transcribe.py');

/**
 * 使用本地 Whisper 模型进行语音识别
 * @param {string} audioPath - 音频文件路径
 * @param {object} options
 * @param {string} [options.model='base'] - Whisper 模型大小 (tiny/base/small/medium/large)
 * @param {string} [options.language='zh'] - 语言提示
 * @param {string} [options.pythonPath='python'] - Python 可执行文件路径
 * @param {function} [options.onProgress] - 进度回调
 * @returns {Promise<{transcript: Array<{start: number, end: number, text: string}>}>}
 */
async function transcribeWithWhisper(audioPath, options = {}) {
  const {
    model = 'base',
    language = 'zh',
    pythonPath = 'python',
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
      reject(new Error(`启动 Whisper 进程失败: ${err.message}（请确保已安装 Python 和 openai-whisper）`));
    });

    // 超时处理（10分钟）
    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Whisper 转写超时（10分钟）'));
    }, 10 * 60 * 1000);
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
      proc.kill();
      resolve(false);
    }, 5000);
  });
}

module.exports = {
  transcribeWithWhisper,
  isWhisperAvailable
};
