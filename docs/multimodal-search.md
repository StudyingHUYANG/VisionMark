# 跨模态视频时刻检索

VisionMark 的检索功能面向当前 BVID：用户输入自然语言，系统从视频画面和 ASR 字幕中寻找相关时间窗口，返回可跳转的起止时间、缩略图、字幕证据和命中模态。当前版本只接受文本查询，不搜索整个视频库。

## 实现概览

```text
视频分析完成
  → 构建重叠时间窗口
  → 代表帧与窗口字幕分别向量化
  → 写入 LanceDB v2 表并切换活动 run

文本查询
  → 视觉帧召回 + 字幕窗口召回
  → 帧分数聚合到窗口
  → RRF 排名融合
  → temporal NMS 去重
  → 可选多模态重排
  → 返回 Top K 时间区间
```

### 离线索引

- 优先复用视频分析阶段的视觉探针帧；视觉探针不可用时退回已有关键帧，检索不受视觉理解阶段最多 30 帧的限制。
- 默认构建 8 秒窗口、4 秒步长。长视频动态增大步长，基础窗口控制在约 450 个；再加入视觉切点和最终分段边界附近的窗口，去重后最多 600 个。
- 每个窗口从约 20%、50%、80% 位置选择代表帧，用感知哈希去除近重复帧，并生成最多三帧的横向拼图。
- ASR 字幕统一为 `{start,end,text}`，按时间重叠关系聚合进窗口。
- 代表帧由 `qwen3-vl-embedding` 生成视觉向量；窗口字幕由 `text-embedding-v4` 生成文本向量。两路默认都是 1024 维，但分别属于各自的模型空间，不直接混合原始相似度。
- 视觉向量写入 `visionmark_visual_windows_v2`，字幕向量写入 `visionmark_text_windows_v2`；SQLite 的 `search_indexes` 保存状态、模型、数量和活动 `runId`。
- 重建索引时先完整写入新 `runId`，再通过 SQLite 事务切换 `activeRunId`，最后清理旧 run。构建失败时保留可用的旧索引。

### 在线检索

1. 同一查询分别由视觉 Embedding 模型和文本 Embedding 模型编码；两路查询向量并行生成。
2. LanceDB 使用 `cosine` 距离，并按经过校验的 `bvid` 和活动 `runId` 过滤。视觉通道召回最多 90 条帧结果，按 `windowId` 聚合后取 Top 30；字幕通道取 Top 30 窗口。
3. 视觉窗口分数使用 `0.7 × 最高帧分数 + 0.3 × Top2 帧平均分`。两路排名用 RRF 融合，默认 `k=60`、视觉和字幕等权；这样不需要直接比较不同模型的原始余弦分数。
4. 对融合候选执行时间 NMS：两个窗口的 temporal IoU 达到 0.5 时只保留排名较高者，最多留下 20 个候选。
5. 可选调用 `qwen3-vl-rerank` 精排，默认返回 Top 5。当前实现把窗口字幕和拼图分别提交为候选，再映射回同一窗口并取较高分数；尚未实现图文作为一个候选的联合重排。

## API 与前端

所有接口都要求登录鉴权。

| 接口 | 用途 |
| --- | --- |
| `POST /api/v1/search/multimodal` | 文本到当前视频时刻的检索 |
| `GET /api/v1/search/status?bvid=...` | 索引状态、模型和向量数量 |
| `GET /api/v1/search/thumbnails/:bvid/:windowId` | 获取鉴权缩略图 |
| `GET /api/v1/search/semantic?q=...&bvid=...` | 旧接口兼容，额外返回 `timestamp` |

请求示例：

```json
{
  "bvid": "BV1234567890",
  "query": "展示手机并介绍续航",
  "topK": 5
}
```

结果包含 `startTime`、`endTime`、`seekTime`、`matchedModalities`、`evidence.transcript` 和 `thumbnailUrl`。前端使用带 Token 的请求下载缩略图并转为 Blob URL，点击结果跳转到 `seekTime`。

## 配置与可靠性

检索服务使用服务端 `DASHSCOPE_API_KEY`；模型、维度、重排开关、窗口大小和并发可通过 `SEARCH_*` 环境变量配置，默认值见 `server/config/search.js`。向量响应会检查数组类型、1024 维长度和有限数值；模型请求最多尝试三次，默认并发上限为二。

字幕缺失时使用纯视觉检索；单个召回通道失败时保留另一通道；重排失败时退回 RRF 排名。索引尚未建立时返回 `SEARCH_INDEX_NOT_READY`，不将其解释为“没有匹配结果”。

当前没有建立 HNSW 近似索引。单视频检索的向量量较小，先使用精确余弦搜索；扩展到大规模跨视频检索时再基于召回率、延迟和内存评估近似索引。

## 验证与当前边界

在 `server` 目录运行 `npm test`，当前 11 项检索单元测试覆盖窗口构建、长视频上限、字幕分窗、代表帧去重、向量校验、帧分数聚合、RRF、时间 NMS、单通道降级和索引未就绪错误。

这些测试与本地视觉向量查询说明基础流程可运行，但尚不构成正式检索质量评测。后续需要使用含有效字幕索引的视频完成双通道端到端测试，并建立人工标注查询集，分别报告视觉、字幕和混合查询的 Recall@K、temporal IoU、MRR 与完整 API 的 P50/P95 延迟。OCR、无答案判断、多尺度时间窗口和跨视频搜索也尚未实现。

## 主要代码

- `server/services/search/videoSearchIndexer.js`：时间窗口索引、向量化和 run 切换。
- `server/services/search/windowBuilder.js`：窗口、字幕聚合和代表帧选择。
- `server/services/vectorDb.js`：LanceDB v2 表和余弦检索。
- `server/services/search/multimodalSearchService.js`：双路召回、RRF、时间 NMS 与重排。
- `server/services/embeddingService.js`：Embedding、Base64 图片与 Rerank 请求。
- `server/routes/search.js`：搜索、状态、缩略图和兼容接口。
- `extension/sidebar/components/SemanticSearch.vue`：状态轮询、结果展示和播放跳转。
