'use strict';

/**
 * 分段主流程：证据 → 候选切点 → 语义合并 → 校验修复 → 调试产物。
 *
 * 每个阶段都独立兜底：任一阶段抛异常都会被降级成可解释的结果，
 * runSegmentPipeline 自身不会因为脏输入或模型不可用而抛出。
 */

const {
  buildEvidence,
  buildEmptyEvidence,
  inferConfidence,
  createWarningCollector
} = require('./evidenceBuilder');
const { generateCandidateCuts } = require('./candidateCutFusion');
const { mergeSegmentsWithAI } = require('./semanticSegmentMerger');
const { validateSegments } = require('./segmentValidator');
const { toContractSegments } = require('./segmentContract');
const { writeDebugArtifacts } = require('./debugArtifactWriter');

const EMPTY_MERGE_DEBUG = {
  usedAI: false,
  fallbackReason: null,
  aiPromptPreview: null,
  aiRawOutput: null,
  warnings: []
};

async function runSegmentPipeline(input = {}, options = {}) {
  const warnings = [];
  const warn = createWarningCollector(warnings);

  const safeInput = input && typeof input === 'object' ? input : {};
  const safeOptions = options && typeof options === 'object' ? options : {};

  // 1. 证据归一化
  let evidence;
  try {
    evidence = buildEvidence(safeInput);
  } catch (error) {
    warn(`evidence_build_failed:${error.message}`);
    evidence = buildEmptyEvidence(safeInput);
  }
  for (const message of evidence.warnings || []) warn(message);

  // 2. 候选切点融合
  let candidateCuts = [];
  try {
    candidateCuts = generateCandidateCuts(evidence, { ...safeOptions, warn });
  } catch (error) {
    warn(`candidate_cut_fusion_failed:${error.message}`);
  }

  // 3. 语义合并（内部已含 fallback）
  let mergeResult;
  try {
    mergeResult = await mergeSegmentsWithAI(
      { ...evidence, candidateCuts, modelConfig: safeInput.modelConfig },
      safeOptions.modelClient || safeInput.modelClient
    );
  } catch (error) {
    warn(`semantic_merge_failed:${error.message}`);
    mergeResult = {
      segments: [],
      debug: { ...EMPTY_MERGE_DEBUG, fallbackReason: `semantic_merge_failed:${error.message}` }
    };
  }

  const mergeDebug = mergeResult?.debug || EMPTY_MERGE_DEBUG;
  for (const message of mergeDebug.warnings || []) warn(message);

  // 4. 校验与边界修复
  let validated;
  try {
    validated = validateSegments({
      duration: evidence.duration,
      candidateCuts,
      segments: Array.isArray(mergeResult?.segments) ? mergeResult.segments : [],
      transcript: evidence.transcript,
      fallbackReason: mergeDebug.fallbackReason
    });
  } catch (error) {
    warn(`segment_validation_failed:${error.message}`);
    validated = {
      segments: [],
      candidateCuts: candidateCuts.map(cut => ({ ...cut, adopted: false })),
      warnings: []
    };
  }
  for (const message of validated.warnings || []) warn(message);

  const finalSegments = Array.isArray(validated.segments) ? validated.segments : [];
  const finalCandidateCuts = Array.isArray(validated.candidateCuts) ? validated.candidateCuts : [];

  // 5. 契约化：内部格式（start/end/summary + 枚举 confidence）→ 跨模块片段契约对象
  let contractSegments = [];
  try {
    const contract = toContractSegments(finalSegments, {
      bvid: evidence.bvid,
      duration: evidence.duration,
      transcript: evidence.transcript,
      candidateCuts: finalCandidateCuts
    });
    contractSegments = contract.segments;
    for (const message of contract.warnings || []) warn(message);
  } catch (error) {
    warn(`segment_contract_failed:${error.message}`);
  }

  // 6. 置信度：由证据模式与被采用的候选切点数量共同决定
  const confidence = inferConfidence(
    evidence.mode,
    finalCandidateCuts.filter(cut => cut.adopted).length
  );

  // 7. 调试产物（写盘失败不影响返回结果）；内部原始数组以 internalSegments 保留，不混入正式字段
  let debugWrite = { artifactPaths: [], warnings: [] };
  try {
    debugWrite = writeDebugArtifacts(safeInput, {
      evidence,
      candidateCuts: finalCandidateCuts,
      aiPromptPreview: mergeDebug.aiPromptPreview,
      aiRawOutput: mergeDebug.aiRawOutput,
      internalSegments: finalSegments,
      finalSegments: contractSegments,
      warnings: [...warnings],
      mode: evidence.mode,
      confidence
    }) || debugWrite;
  } catch (error) {
    warn(`debug_artifact_write_failed:${error.message}`);
  }
  for (const message of debugWrite.warnings || []) warn(message);

  return {
    mode: evidence.mode,
    confidence,
    duration: evidence.duration,
    candidateCuts: finalCandidateCuts,
    segments: contractSegments,
    debug: {
      usedAI: Boolean(mergeDebug.usedAI),
      fallbackReason: mergeDebug.fallbackReason || null,
      artifactPaths: debugWrite.artifactPaths || [],
      warnings
    }
  };
}

module.exports = {
  runSegmentPipeline
};
