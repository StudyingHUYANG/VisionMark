# Segment Pipeline

黄睿琦负责的分段主链路：

```text
evidence -> candidateCuts -> AI merge -> final segments
```

## 模块位置

```text
server/services/segmentPipeline/
  index.js
  evidenceBuilder.js
  candidateCutFusion.js
  semanticMergePrompt.js
  semanticSegmentMerger.js
  segmentValidator.js
  debugArtifactWriter.js
```

## 本地测试

```bash
node server/scripts/testSegmentPipeline.js
```

测试脚本使用 mock visualCuts/audioCuts/keywordCuts/transcript，验证在没有真实模型客户端时会 fallback 且不会崩溃。

## 接口返回

`POST /video-analysis/analyze` 保留旧字段，并新增：

```json
{
  "candidateCuts": [],
  "segmentPipeline": {},
  "segments": []
}
```

`GET /api/v1/segments?bvid=xxx` 保留旧 `segments`，并额外返回：

```json
{
  "candidateCuts": [],
  "segmentPipeline": {},
  "final_segments": []
}
```

## Debug Artifacts

每次运行 pipeline 会写入：

```text
server/debug/segment-pipeline/{videoId-or-bvid}-{timestamp}.json
```

可通过调试接口读取最近一次结果：

```bash
GET /video-analysis/segments/:videoId/debug
```

文件包含 evidence、candidateCuts、AI prompt preview、AI raw output、finalSegments、warnings、mode 和 confidence。不会保存 API key，也会截断输入摘要。
