# Segment 语义检索接口

## 索引数据契约

分析模块只需要向 `SearchIndexService#indexSegments(segments)` 传入数组：

```json
{
  "videoId": "BV_TEST",
  "segmentId": "BV_TEST-0",
  "start": 0,
  "end": 30,
  "title": "手机外观展示",
  "summary": "主持人展示手机背面和摄像头模组",
  "transcript": "这款手机采用圆形镜头设计"
}
```

- `videoId`、`start`、`end` 必填；兼容输入别名 `bvid`、`start_time`、`end_time`。
- `segmentId` 推荐由上游稳定提供；缺省时按 `videoId-start-end` 生成。
- `summary` 与 `transcript` 至少一个非空；兼容 `description`、`text`、`content`。
- 唯一键是 `videoId + segmentId`，重复索引会更新旧记录，不会追加重复数据。
- 标题、摘要和字幕拼成一段索引文本；写入和查询统一使用 `TEXT_EMBEDDING_MODEL`（默认 `text-embedding-v2`）。

## HTTP 接口

两个接口均沿用现有 JWT 鉴权：

- `POST /api/v1/search/segments`：body 为 `{ "segments": [...] }`。
- `GET /api/v1/search/semantic?q=游戏性能&videoId=BV_TEST&topK=5`。

搜索兼容旧参数名 `bvid` 和 `topk`。`topK` 必须是 1-20 的整数。

搜索结果固定包含：

```json
{
  "videoId": "BV_TEST",
  "segmentId": "BV_TEST-1",
  "start": 30,
  "end": 60,
  "score": 0.92,
  "title": "游戏性能测试",
  "snippet": "连续游戏后帧率稳定"
}
```

无匹配是成功响应，`results` 为空数组。错误响应包含稳定的 `error.code`：

- `EMBEDDING_NOT_CONFIGURED`：未配置 `DASHSCOPE_API_KEY`。
- `SEGMENT_INDEX_NOT_FOUND`：segment 表尚未建立。
- `VECTOR_DIMENSION_MISMATCH`：模型或索引向量维度不一致。
- `EMBEDDING_FAILED`：Embedding 服务调用失败。
- `INVALID_REQUEST`：输入契约或 `topK` 不合法。

## 本地独立验证

在 `server` 目录执行：

```text
npm test
npm run demo:search
```

demo 使用确定性的本地 mock embedding，不需要 API Key，也不依赖真实视频分析输出。
