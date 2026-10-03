/**
 * 音频时长探测
 *
 * 只服务于「按音频时长缩放超时」这类容错场景：
 * 拿不到就返回 null，由调用方退回到固定下限，不抛错。
 *
 * 顺序：ffprobe → wav 头解析 → null
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const { resolveFfprobePath } = require('../bilibiliDownloader');

const TAG = '[ASR:Probe]';
const FFPROBE_TIMEOUT_MS = 15000;
const MAX_HEADER_SCAN_BYTES = 64 * 1024;

/** 用 ffprobe 读容器层时长 */
function probeWithFfprobe(audioPath) {
  const ffprobePath = resolveFfprobePath();
  if (!ffprobePath) return null;

  try {
    const result = spawnSync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
      { encoding: 'utf8', timeout: FFPROBE_TIMEOUT_MS, windowsHide: true }
    );
    if (result.error || result.status !== 0) return null;

    const value = Number.parseFloat(String(result.stdout || '').trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * 解析 wav 头算时长（ffprobe 不可用时的兜底）。
 * 只处理标准 RIFF/WAVE：从 fmt 块拿 byteRate，从 data 块拿数据长度。
 */
function readWavDuration(audioPath) {
  let fd;
  try {
    const stat = fs.statSync(audioPath);
    if (stat.size < 44) return null;

    fd = fs.openSync(audioPath, 'r');
    const header = Buffer.alloc(Math.min(MAX_HEADER_SCAN_BYTES, stat.size));
    const read = fs.readSync(fd, header, 0, header.length, 0);

    if (read < 12) return null;
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let byteRate = null;
    let dataSize = null;

    while (offset + 8 <= read) {
      const chunkId = header.toString('ascii', offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);

      if (chunkId === 'fmt ') {
        // fmt 数据区布局：format(2) channels(2) sampleRate(4) byteRate(4)…
        if (offset + 20 > read) return null;
        byteRate = header.readUInt32LE(offset + 16);
      } else if (chunkId === 'data') {
        // 部分写入工具会把 data 长度留成 0xFFFFFFFF，此时按文件实际大小推算
        dataSize = (chunkSize === 0xFFFFFFFF || offset + 8 + chunkSize > stat.size)
          ? stat.size - offset - 8
          : chunkSize;
        break;
      }

      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // 关闭失败不影响结果
      }
    }
  }
}

/**
 * @returns {{duration: number|null, source: 'ffprobe'|'wav_header'|'unknown'}}
 */
function probeAudioDuration(audioPath) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    return { duration: null, source: 'unknown' };
  }

  const fromFfprobe = probeWithFfprobe(audioPath);
  if (fromFfprobe !== null) return { duration: fromFfprobe, source: 'ffprobe' };

  const fromWav = readWavDuration(audioPath);
  if (fromWav !== null) {
    console.warn(`${TAG} ffprobe 不可用，按 wav 头估算时长: ${fromWav.toFixed(1)}s`);
    return { duration: fromWav, source: 'wav_header' };
  }

  return { duration: null, source: 'unknown' };
}

module.exports = {
  probeAudioDuration,
  readWavDuration,
  probeWithFfprobe
};
