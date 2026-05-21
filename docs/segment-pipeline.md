# Segment Pipeline

## 为什么重构

旧分段方式主要依赖 AI 一次性输出 `segments`，缺少连续时间变化、文本语义连续性、候选切点、边界证据、置信度和降级逻辑。新流程把分段拆成可解释的后端主链路，避免模型不可用或证据不足时接口直接失败。

```text
evidence -> candidateCuts -> AI merge -> final segments
```

## 模块说明

代码位于 `server/services/segmentPipeline/`：

- `index.js`: 主入口 `runSegmentPipeline(input, options)`，串联证据、候选切点、AI 归并、校验和 debug artifact。
- `evidenceBuilder.js`: 统一 `duration/frameTimes/transcript/visualCuts/audioCuts/keywordCuts`，输出 `availableSources/mode/confidence/warnings`。
- `candidateCutFusion.js`: 融合视觉、音频、关键词、文本话题变化和时间补点候选切点。
- `semanticMergePrompt.js`: 构造强约束 AI prompt，并提供 `extractJsonFromModelOutput` 容错解析。
- `semanticSegmentMerger.js`: 调用模型做语义归并；模型不可用、调用失败或 JSON 非法时自动 fallback。
- `segmentValidator.js`: 修复非法分段、覆盖范围、重叠、空洞、枚举和 adopted 标记。
- `debugArtifactWriter.js`: 写入和读取调试产物。

## candidateCuts 字段

```json
{
  "time": 42.5,
  "score": 0.76,
  "reasons": ["visual_change", "keyword:总结一下"],
  "sources": ["visual", "keyword"],
  "raw": {},
  "adopted": true,
  "nearbyEvidence": {
    "beforeText": "",
    "afterText": "",
    "frameTimes": []
  }
}
```

默认权重：`keyword=0.9`、`visual=0.75`、`audio=0.65`、`text=0.7`、`time_padding=0.35`。5 秒内候选点会融合，最终候选点至少间隔 10 秒；超过 90 秒没有候选点时会插入 `time_padding`。

## 输出结构

`runSegmentPipeline` 返回稳定结构：

```json
{
  "mode": "full",
  "confidence": "high",
  "duration": 180,
  "candidateCuts": [],
  "segments": [],
  "debug": {
    "usedAI": true,
    "fallbackReason": null,
    "artifactPaths": [],
    "warnings": []
  }
}
```

`segments` 的 `type` 只允许 `intro/content/ad/summary/transition/unknown`。

## fallback 逻辑

以下情况会 fallback，不会让接口直接崩溃：

- `modelClient` 不存在。
- AI 调用失败。
- AI 输出不是合法 JSON。
- AI 返回空 segments。
- validator 发现没有可用 segment。

fallback 会使用 `candidateCuts` 切分视频，保证起点为 0、终点为 `duration`，标题为 `Segment 1`、`Segment 2` 等，并用 transcript 简单生成摘要。

## 后端接口

`VideoAnalyzer.analyzeVideo` 在旧 AI 分析完成后调用：

```js
runSegmentPipeline(input, { modelClient })
```

分析返回和持久化内容保留旧字段，同时新增：

- `candidateCuts`
- `segmentPipeline`
- `final_segments`

`GET /api/v1/segments?bvid=xxx` 保留旧 `segments`，并额外返回 `candidateCuts/segmentPipeline/final_segments`。

调试接口：

```http
GET /video-analysis/segments/:videoId/debug
```

返回最新 artifact 的 `evidence/candidateCuts/finalSegments/warnings/mode/confidence`。没有产物时返回 404。

## Debug Artifacts

调试产物保存到：

```text
server/debug/segment-pipeline/{videoId-or-bvid}-{timestamp}.json
```

文件包含 `inputSummary/evidence/candidateCuts/aiPromptPreview/aiRawOutput/finalSegments/warnings/mode/confidence`。只保存摘要和必要调试信息，不保存 API key 或完整大文件。

## 测试命令

```bash
node server/scripts/testSegmentPipeline.js
node -c server/services/segmentPipeline/*.js
node -c server/routes/videoAnalysis.js
node -c server/services/videoAnalyzer.js
node -c server/server.js
npm run build
```

`testSegmentPipeline.js` 使用 mock `duration/transcript/visualCuts/audioCuts/keywordCuts`，验证无真实模型客户端时 fallback 不崩溃。

## 后续接入点

其他同学可以在进入 pipeline 前补充更强证据：

- `getVisualCuts(frames)`: 返回 `{ time, score, reasons, sources }[]`，接入 `visualCuts`。
- `getAudioCuts(audioPath)`: 返回静音、音量突变、说话人变化等 `{ time, score, reasons }[]`，接入 `audioCuts`。
- `detectKeywordCuts(transcript, rules)`: 返回广告、总结、转场关键词 `{ time, score, keyword, reasons }[]`，接入 `keywordCuts`。

这些输入都允许为空，pipeline 会根据可用证据自动选择 `full/visual_only/transcript_only/fallback` 模式。
