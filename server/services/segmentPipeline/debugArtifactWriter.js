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

module.exports = {
  writeDebugArtifacts,
  getLatestDebugArtifact,
  DEBUG_DIR
};
