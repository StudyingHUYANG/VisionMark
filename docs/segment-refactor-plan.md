# Segment Refactor Plan

## 1. 当前问题

- 关键帧不足后会退化为均匀采样，视觉证据不稳定。
- ASR 当前处于 skip 状态，缺少可验证的文本时间轴。
- 模型直接猜分段，容易编造时间点，也不容易解释每个分段的证据来源。

## 2. 新流程

```text
evidence -> candidateCuts -> AI merge -> finalSegments
```

- evidence：视觉帧差、音频变化、ASR 文本、关键词规则等原始证据。
- candidateCuts：先由确定性规则生成候选切点，带上来源、分数和原因。
- AI merge：AI 只在候选切点附近做合并和命名，不直接自由生成时间点。
- finalSegments：输出最终分段，包含类型、标题、摘要和置信度。

## 3. 新增文件职责

- `server/services/segment/segmentTypes.js`：统一候选切点、转写条目和最终分段的数据结构。
- `server/services/segment/visualCuts.js`：视觉候选切点入口，后续接入帧差和峰值检测。
- `server/services/segment/audioCuts.js`：音频候选切点入口，后续接入静音、音量和能量变化检测。
- `server/services/segment/keywordCuts.js`：基于 ASR 文本的关键词候选切点规则。
- `server/services/segment/candidateCutGenerator.js`：融合视觉、音频、关键词候选切点并做排序去重。
- `server/services/segment/segmentPrompt.js`：构建 AI 合并分段的约束 prompt。
- `server/services/segment/index.js`：统一导出分段框架能力。
- `server/services/asr/transcribeAudio.js`：ASR 接入占位，后续可接 DashScope / paraformer、FunASR、whisper / faster-whisper 或本地 fallback。
- `server/services/asr/asrFallback.js`：ASR fallback 包装，统一返回 transcript、mode、confidence、provider 和 error。
- `server/services/asr/index.js`：统一导出 ASR 框架能力。
- `server/services/vision/frameDiff.js`：视觉差异底层占位，后续实现 histogram diff、SSIM、perceptual hash 和 scene change。
- `server/services/vision/index.js`：统一导出视觉差异能力。

## 4. 协助同学填写位置

- 视觉同学：`server/services/segment/visualCuts.js` 和 `server/services/vision/frameDiff.js`
- 音频/ASR 同学：`server/services/segment/audioCuts.js` 和 `server/services/asr/transcribeAudio.js`
- 关键词规则同学：`server/services/segment/keywordCuts.js`
- 我自己：`server/services/segment/candidateCutGenerator.js` 和 `server/services/segment/segmentPrompt.js`，后续再决定是否接入 `videoAnalyzer.js`

## 5. 当前阶段说明

当前阶段只搭框架，不接入正式分析流程，不影响现有插件功能。
