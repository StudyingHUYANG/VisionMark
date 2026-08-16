const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const EmbeddingService = require('../embeddingService');
const vectorDb = require('../vectorDb');
const searchConfig = require('../../config/search');
const indexStore = require('./searchIndexStore');
const {
  attachTranscript,
  buildWindows,
  computeFrameHashes,
  ensureDirectory,
  normalizeTranscript,
  selectRepresentativeFrames
} = require('./windowBuilder');

const execFileAsync = promisify(execFile);

function validateBvid(bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) throw new Error('非法 BVID');
  return bvid;
}

function collectBoundaries(visualCuts = [], segments = []) {
  const values = [];
  for (const cut of visualCuts || []) values.push(Number(cut.time));
  for (const segment of segments || []) {
    values.push(Number(segment.start ?? segment.startTime ?? segment.start_time));
    values.push(Number(segment.end ?? segment.endTime ?? segment.end_time));
  }
  return values.filter(Number.isFinite);
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function createContactSheet(framePaths, outputPath) {
  ensureDirectory(path.dirname(outputPath));
  const available = framePaths.filter(framePath => framePath && fs.existsSync(framePath)).slice(0, 3);
  if (!available.length) return null;
  if (available.length === 1) {
    fs.copyFileSync(available[0], outputPath);
    return outputPath;
  }

  const args = [];
  for (const framePath of available) args.push('-i', framePath);
  const filters = available.map((_, index) => `[${index}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[v${index}]`);
  filters.push(`${available.map((_, index) => `[v${index}]`).join('')}hstack=inputs=${available.length}[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '5', '-y', outputPath);
  try {
    await execFileAsync(ffmpegInstaller.path, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return outputPath;
  } catch (error) {
    console.warn('[SearchIndex] 三帧拼图失败，回退到中心帧:', error.message);
    fs.copyFileSync(available[Math.floor(available.length / 2)], outputPath);
    return outputPath;
  }
}

class VideoSearchIndexer {
  constructor(options = {}) {
    this.embedding = options.embeddingService || new EmbeddingService();
    this.vectorDb = options.vectorDb || vectorDb;
    this.store = options.indexStore || indexStore;
    this.config = options.config || searchConfig;
  }

  report(onProgress, percent, status, message) {
    if (typeof onProgress === 'function') onProgress(percent, status, message);
  }

  async indexVideo(input, onProgress = null) {
    const bvid = validateBvid(input.bvid);
    const runId = crypto.randomUUID();
    const models = {
      visual: this.config.visualModel,
      text: this.config.textModel,
      rerank: this.config.rerankModel,
      dimension: this.config.dimension
    };
    this.store.setStatus(bvid, 'pending', { pendingRunId: runId, ...{
      visualModel: models.visual,
      textModel: models.text,
      rerankModel: models.rerank,
      dimension: models.dimension
    } });
    this.report(onProgress, 1, 'pending', '检索索引任务已创建');

    try {
      if (!this.embedding.isReady()) throw new Error('DASHSCOPE_API_KEY 未配置');
      const frames = (input.frames || [])
        .map(frame => ({ framePath: frame.framePath, time: Number(frame.time) }))
        .filter(frame => frame.framePath && Number.isFinite(frame.time) && fs.existsSync(frame.framePath))
        .sort((a, b) => a.time - b.time);
      const transcriptSegments = normalizeTranscript(input.transcriptSegments || input.transcript);
      if (!frames.length && !transcriptSegments.length) throw new Error('没有可用于检索的画面或字幕');

      this.store.setStatus(bvid, 'extracting', { pendingRunId: runId });
      this.report(onProgress, 5, 'extracting', '正在构建检索时间窗口');
      const boundaries = collectBoundaries(input.visualCuts, input.segments);
      let windows = buildWindows(input.duration, boundaries, {
        windowSeconds: this.config.baseWindowSeconds,
        strideSeconds: this.config.baseStrideSeconds,
        maxWindows: this.config.maxWindows
      });
      windows = attachTranscript(windows, transcriptSegments);

      const hashes = await computeFrameHashes(frames);
      const assetsDir = path.join(this.config.assetsDir, bvid, runId);
      ensureDirectory(assetsDir);
      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        window.frames = selectRepresentativeFrames(window, frames, hashes);
        window.thumbnailPath = window.frames.length
          ? await createContactSheet(window.frames.map(frame => frame.framePath), path.join(assetsDir, `${window.id}.jpg`))
          : null;
        if ((index + 1) % 20 === 0 || index === windows.length - 1) {
          this.report(onProgress, 5 + Math.round(((index + 1) / Math.max(windows.length, 1)) * 20), 'extracting', `正在生成检索缩略图 ${index + 1}/${windows.length}`);
        }
      }

      this.store.setStatus(bvid, 'embedding', { pendingRunId: runId });
      const uniqueFramePaths = [...new Set(windows.flatMap(window => window.frames.map(frame => frame.framePath)))];
      const visualVectors = new Map();
      let completedImages = 0;
      for (const batch of chunk(uniqueFramePaths, 10)) {
        const vectors = await this.embedding.embedImages(batch);
        batch.forEach((framePath, index) => visualVectors.set(framePath, vectors[index]));
        completedImages += batch.length;
        this.report(onProgress, 25 + Math.round((completedImages / Math.max(uniqueFramePaths.length, 1)) * 45), 'embedding', `正在向量化画面 ${completedImages}/${uniqueFramePaths.length}`);
      }

      const textWindows = windows.filter(window => window.transcript);
      const textVectors = new Map();
      let completedTexts = 0;
      for (const batch of chunk(textWindows, 10)) {
        const vectors = await this.embedding.embedTextBatch(batch.map(window => window.transcript));
        batch.forEach((window, index) => textVectors.set(window.id, vectors[index]));
        completedTexts += batch.length;
        this.report(onProgress, 70 + Math.round((completedTexts / Math.max(textWindows.length, 1)) * 20), 'embedding', `正在向量化字幕 ${completedTexts}/${textWindows.length}`);
      }

      const visualRows = [];
      const textRows = [];
      for (const window of windows) {
        window.frames.forEach((frame, frameIndex) => {
          const vector = visualVectors.get(frame.framePath);
          if (!vector) return;
          visualRows.push({
            id: `${runId}_${window.id}_f${frameIndex}`,
            runId,
            windowId: window.id,
            bvid,
            startTime: window.startTime,
            endTime: window.endTime,
            frameTime: frame.time,
            transcript: window.transcript || '',
            thumbnailPath: window.thumbnailPath || '',
            vector
          });
        });
        const textVector = textVectors.get(window.id);
        if (textVector) {
          textRows.push({
            id: `${runId}_${window.id}_t`,
            runId,
            windowId: window.id,
            bvid,
            startTime: window.startTime,
            endTime: window.endTime,
            transcript: window.transcript,
            thumbnailPath: window.thumbnailPath || '',
            vector: textVector
          });
        }
      }
      if (!visualRows.length && !textRows.length) throw new Error('没有生成有效检索向量');

      this.store.setStatus(bvid, 'committing', { pendingRunId: runId });
      this.report(onProgress, 94, 'committing', '正在提交 LanceDB 索引');
      await this.vectorDb.appendRun(visualRows, textRows);
      const counts = {
        windows: windows.length,
        visual: visualRows.length,
        transcript: textRows.length
      };
      this.store.activateRun(bvid, runId, counts, models);
      this.report(onProgress, 100, 'ready', '跨模态检索索引已就绪');

      this.vectorDb.cleanupOldRuns(bvid, runId).catch(error => {
        console.warn('[SearchIndex] 清理旧索引失败:', error.message);
      });
      return { runId, counts };
    } catch (error) {
      const current = this.store.getIndexRow(bvid);
      this.store.setStatus(bvid, current?.active_run_id ? 'ready' : 'failed', {
        pendingRunId: null,
        error: error.message
      });
      this.report(onProgress, 100, 'failed', error.message);
      throw error;
    }
  }
}

module.exports = VideoSearchIndexer;
