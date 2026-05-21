const { buildEvidence, inferConfidence } = require('./evidenceBuilder');
const { generateCandidateCuts } = require('./candidateCutFusion');
const { mergeSegmentsWithAI } = require('./semanticSegmentMerger');
const { validateSegments } = require('./segmentValidator');
const { writeDebugArtifacts } = require('./debugArtifactWriter');

async function runSegmentPipeline(input = {}) {
  const evidence = buildEvidence(input);
  const candidateCuts = generateCandidateCuts(evidence);
  const mergeResult = await mergeSegmentsWithAI({
    ...evidence,
    candidateCuts,
    modelConfig: input.modelConfig
  }, input.modelClient);

  const validated = validateSegments({
    duration: evidence.duration,
    candidateCuts,
    segments: mergeResult.segments,
    fallbackReason: mergeResult.debug.fallbackReason
  });

  const confidence = inferConfidence(evidence.mode, validated.candidateCuts.filter(cut => cut.adopted).length);
  const debugWrite = writeDebugArtifacts(input, {
    evidence,
    candidateCuts: validated.candidateCuts,
    aiPromptPreview: mergeResult.debug.aiPromptPreview,
    aiRawOutput: mergeResult.debug.aiRawOutput,
    finalSegments: validated.segments,
    warnings: validated.warnings,
    mode: evidence.mode,
    confidence
  });

  const warnings = [...validated.warnings, ...debugWrite.warnings];

  return {
    mode: evidence.mode,
    confidence,
    duration: evidence.duration,
    candidateCuts: validated.candidateCuts,
    segments: validated.segments,
    debug: {
      usedAI: mergeResult.debug.usedAI,
      fallbackReason: mergeResult.debug.fallbackReason,
      artifactPaths: debugWrite.artifactPaths,
      warnings
    }
  };
}

module.exports = {
  runSegmentPipeline
};
