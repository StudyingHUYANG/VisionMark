const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, '../../debug/segment-pipeline');

function sanitizeId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function compactInputSummary(input = {}) {
  return {
    videoId: input.videoId || input.bvid || null,
    bvid: input.bvid || input.videoId || null,
    duration: input.duration || 0,
    frames: Array.isArray(input.frames) ? input.frames.length : 0,
    visualCuts: Array.isArray(input.visualCuts) ? input.visualCuts.length : 0,
    audioCuts: Array.isArray(input.audioCuts) ? input.audioCuts.length : 0,
    keywordCuts: Array.isArray(input.keywordCuts) ? input.keywordCuts.length : 0,
    hasTranscript: Boolean(input.transcript),
    modelConfig: input.modelConfig ? {
      textModel: input.modelConfig.textModel,
      visionModel: input.modelConfig.visionModel,
      baseUrl: input.modelConfig.baseUrl
    } : null
  };
}

function writeDebugArtifacts(input = {}, artifact = {}) {
  const warnings = [];
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const id = sanitizeId(input.videoId || input.bvid);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(DEBUG_DIR, `${id}-${timestamp}.json`);
    const payload = {
      inputSummary: compactInputSummary(input),
      evidence: artifact.evidence || null,
      candidateCuts: artifact.candidateCuts || [],
      aiPromptPreview: artifact.aiPromptPreview || null,
      aiRawOutput: artifact.aiRawOutput || null,
      // 内部原始数组（流水线内部格式）：只用于调试，不属于契约字段
      internalSegments: artifact.internalSegments || [],
      // 正式产物：契约格式片段
      finalSegments: artifact.finalSegments || [],
      warnings: artifact.warnings || [],
      mode: artifact.mode || 'fallback',
      confidence: artifact.confidence || 'low'
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { artifactPaths: [filePath], warnings };
  } catch (error) {
    warnings.push(`debug_artifact_write_failed:${error.message}`);
    return { artifactPaths: [], warnings };
  }
}

function getLatestDebugArtifact(videoId) {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const safeId = sanitizeId(videoId);
  const files = fs.readdirSync(DEBUG_DIR)
    .filter(file => file.startsWith(`${safeId}-`) && file.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  const filePath = path.join(DEBUG_DIR, files[0]);
  return {
    path: filePath,
    content: JSON.parse(fs.readFileSync(filePath, 'utf8'))
  };
}

/**
 * 删除某个 videoId 的全部 debug 产物。
 *
 * 产物名是 `${safeId}-${时间戳}.json`，所以 `startsWith(safeId + '-')` 既不会串到
 * 相邻 id（'BV1aa' 不会命中 'BV1aab-...'），也不会漏掉同一次分析之外的旧产物。
 * 这里只做显式删除——debug 产物目前没有自动清理入口，调用方不主动清就会一直堆积。
 * 单个文件删不掉（被占用等）只记日志，不影响其它文件。
 *
 * @returns {number} 实际删除的文件数；目录不存在返回 0
 */
function removeArtifactsFor(videoId) {
  if (!fs.existsSync(DEBUG_DIR)) return 0;

  const safeId = sanitizeId(videoId);
  let removed = 0;
  for (const file of fs.readdirSync(DEBUG_DIR)) {
    if (!file.startsWith(`${safeId}-`) || !file.endsWith('.json')) continue;
    try {
      fs.unlinkSync(path.join(DEBUG_DIR, file));
      removed += 1;
    } catch (error) {
      console.warn(`[SegmentPipeline] 删除 debug 产物失败: ${file} — ${error.message}`);
    }
  }
  return removed;
}

module.exports = {
  writeDebugArtifacts,
  getLatestDebugArtifact,
  removeArtifactsFor,
  DEBUG_DIR
};
