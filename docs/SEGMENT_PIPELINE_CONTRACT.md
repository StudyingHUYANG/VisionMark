# 片段契约说明（segment_pipeline 产出）

> 产出方：视频分析链路 / 分段流水线（张晗旭）
> 代码位置：`server/services/segmentPipeline/segmentContract.js`（契约映射，纯函数）
> 取数位置：`runSegmentPipeline(...)` 返回值的 `segments` 字段；对外经 `VideoAnalyzer.analyzeVideo` 的
> `analysis.final_segments`、`POST /video-analysis/analyze` 响应 `data.segments`、
> `GET /api/v1/segments?bvid=` 的 `final_segments` 字段暴露（同名 `segments` 字段的区别见第一节）。
> 文档日期：2026-09-29

## 一、正式产物与 `segments` 同名字段的区分

`runSegmentPipeline` 返回的 `segments` 数组，每一项都是契约对象，对外正式产物就是这批对象。
内部格式 `{ start, end, title, type, summary, confidence, evidence:{candidateCutTimes,reasons} }`
只用于流水线内部流转，以及在 debug 产物里以 `internalSegments` 字段保留，供调试回溯。

`VideoAnalyzer.analyzeVideo` 返回的 `analysis` 下同时存在两套片段字段，消费方必须区分：

- `analysis.final_segments`：**正式产物**，即上面的契约数组（来源是 `segmentPipeline.segments`）。
- `analysis.segments`：**历史字段**，大模型直接产出的数组（`start_time` / `end_time` 为 `"MM:SS"` 字符串、带 `highlight`），
  仅供后端落库时派生 `ad_segments`；**不得当作契约取数点**。

落库与读回链路：`server/routes/videoAnalysis.js` 写入 `content_analysis.segments = final_segments`
（`ad_segments` 才来自 `analysis.segments`）；`server/server.js` 的 `GET /api/v1/segments` 再把
`content_analysis.segments` 读回来、以 `final_segments` 字段返回；该接口里的另一个 `segments` 字段是历史
ad 片段派生结果，同样不是契约数组。

## 二、字段逐个说明（11 个正式字段 + 1 个溯源字段）

| 字段 | 类型 | 取值范围 | 可能为空 | 说明 |
|-|-|-|-|-|
| `segmentId` | string | `{bvid}_{page}_{start}_{end}` | 否 | 片段唯一标识，同视频内不重复；起点/终点固定 2 位小数 |
| `bvid` | string | BV 号 | 否 | 视频标识；输入缺失时用 `unknown`，仍保证 id 稳定 |
| `page` | number | 恒为 `1` | 否 | 分 P 号，当前**恒为 1**（见第五节限制） |
| `title` | string | 任意短标题 | 否 | 来自语义合并；模型未给标题时为 `Segment N` |
| `startTime` | number | `>= 0`，秒，2 位小数 | 否 | 片段起点，含在片段内 |
| `endTime` | number | `> startTime`，`<= duration` | 否 | 片段终点，不含在片段内（区间为半开 `[startTime, endTime)`） |
| `description` | string | 非空文本 | 否 | 片段讲了什么，取自内部 `summary`（含转录兜底/结构性兜底结果） |
| `evidence` | object | 见第四节 | 否 | 匹配依据，四个桶至少一个非空 |
| `previewTimestamp` | number | `startTime <= x <= endTime` | 否 | 预览时刻：优先取区间内**距区间中点最近**的候选切点时间，没有候选切点时取区间中点 |
| `confidence` | number | `0.2 / 0.5 / 0.8` | 否 | 由内部枚举映射的数值置信度，见第六节 |
| `source` | string | 恒为 `segment_pipeline` | 否 | 片段来源标识 |
| `reasons` | string[] | 非空字符串数组 | 否 | **契约之外的溯源字段**：边界来源、降级原因（如 `boundary_from_candidate_cut`、`validator_fallback`），用于回溯，不替代 `evidence`；来自大模型的、非内部产生的原因值一律带 `model_reason:` 前缀（如 `model_reason:validator_fallback`），可据此与内部原因值区分 |

## 三、时间语义

- 相邻片段首尾相接，不重叠；修复动作都会写进 `runSegmentPipeline().debug.warnings`。
- **1 秒容差说明**：`repairCoverage` 对**小于等于 `COVERAGE_TOLERANCE_SECONDS`（1 秒）**的重叠/空洞**有意不修复**——容差内的不连续视为浮点误差而非错误。因此上一条「首尾相接」是 1 秒容差内的表述，不是严格的零间隙保证。
- `[startTime, endTime)` 为半开区间：正好落在边界上的证据归入后一个片段。

### duration 与 duration_source

`VideoAnalyzer.analyzeVideo` 返回的 `analysis.duration_source` 标明时长的取得方式：

| 取值 | 含义 |
|-|-|
| `probe` | ffprobe 探测得到（容器 `format=duration` 或视频流 `duration`） |
| `decoded` | ffprobe 取不到时，ffmpeg 全片解码取最大 pts_time |
| `derived_from_keyframes` | 三级探测全失败，用最大关键帧时间戳作为时长的**下界**（不是探测到的真实时长） |
| `unknown` | 探测全失败且没有可获得的关键帧，时长未知 |

时长取不到（`duration` 为 `null` 或非正数）时，流水线不臆造区间：`segmentValidator` 走
`duration_missing_or_zero` 分支，返回 **0 个片段**（契约数组为空），并把该原因写进
`runSegmentPipeline().debug.warnings`。消费方必须能处理「分析成功但 `final_segments` 为空」的情况。

## 四、evidence 四桶放什么

| 桶 | 内容 | 元素类型 |
|-|-|-|
| `visual` | 片段起点或终点 **5 秒内**（`ADOPTED_TOLERANCE_SECONDS`）、`candidateCuts[].sources` 含 `visual` 的候选切点时间 | number（秒，2 位小数） |
| `keyword` | 同上，来源含 `keyword` 的候选切点时间 | number（秒，2 位小数） |
| `cut` | 同上，**不限来源**的候选切点时间（音频、文本、补点也在此桶） | number（秒，2 位小数） |
| `speech` | 该片段区间内的转录文本片段（复用 `transcriptSnippet`，超长截断） | string |

硬要求与降级：**四个桶不允许同时为空**。确实没有任何证据时（例如模型不可用、也没有任何检测器切点），
会把明确原因值写进 `cut` 桶，例如 `["fallback_merge", "model_client_unavailable"]`；
validator 侧在「没有匹配到候选切点」时会写入 `no_candidate_cut_matched`。严禁编造内容。

`speech` 桶与 `description` 的转录兜底都只使用**带时间戳**的转录行，缺失时间戳的行会被跳过，
此时 `runSegmentPipeline().debug.warnings` 会给出 `transcript_missing_timestamps`（全部缺失）或
`transcript_partially_missing_timestamps:<n>`（部分缺失，`<n>` 为缺失行数），便于解释「有转录但 `speech` 为空」的情况。

## 五、segmentId 规则与已知限制

规则：`{bvid}_{page}_{start}_{end}`，例如 `BV1test_1_0.00_45.26`。

- 不含随机数、时间戳、自增计数或 UUID。
- 同一份输入连跑两次，id 完全一致（有测试断言覆盖）。
- 同一视频内 id 不重复。
- **重复 id 的防御路径例外**：id 完全重复时（防御路径）会追加确定性后缀 `_2`（仍重复则 `_3`……）并告警 `duplicate_segment_id_suffixed:<原id>`，保证同视频内唯一；正常输出（各片段边界不同）走不到这条分支，上一条「不含自增计数」描述的就是正常路径。
- **已知限制（必须如实传递）**：语义合并走大模型，片段边界本身不保证跨次可复现；
  边界一变，`segmentId` 随之变化。因此 `segmentId` 适合做「同一份分析结果内的主键 / 去重键」，
  不适合跨次分析的稳定外部主键。以 `bvid + 时间区间` 做业务去重时，请容忍这一抖动。

## 六、confidence 映射表

由内部枚举映射，映射常量写在 `segmentContract.js` 顶部：

| 内部枚举 | 契约数值 |
|-|-|
| `high` | `0.8` |
| `medium` | `0.5` |
| `low` | `0.2` |

枚举非法或缺失时按 `low`（`0.2`）处理。注意区分：`runSegmentPipeline().confidence`
（顶层那个）仍是 `high/medium/low` 的整条流水线置信度，不是契约数值。

## 七、`page` 恒为 1 的限制

当前下载与分析链路没有分 P 概念（只处理 URL 指向的单个视频文件），因此 `page` 恒为 `1`。
若后续要支持分 P，需要先在下载/抽帧侧引入分 P，再改动契约模块中的 `PAGE` 常量——
这属于跨模块改动，需与下载链路负责人确认。

## 八、真实输出样例

下面这段是实际运行 `node server/scripts/testSegmentPipeline.js`（mock 输入、无模型客户端、走降级路径）
的输出原样复制，未手工改写：

```json
{
  "segmentId": "mock-bvid_1_0.00_45.26",
  "bvid": "mock-bvid",
  "page": 1,
  "title": "Segment 1",
  "startTime": 0,
  "endTime": 45.26,
  "description": "大家好，今天我们先介绍项目背景。 接下来我们看核心功能。",
  "evidence": {
    "visual": [45.26],
    "speech": ["大家好，今天我们先介绍项目背景。 接下来我们看核心功能。"],
    "keyword": [],
    "cut": [45.26]
  },
  "previewTimestamp": 45.26,
  "confidence": 0.8,
  "source": "segment_pipeline",
  "reasons": [
    "audio_change",
    "audio_pause",
    "boundary_from_candidate_cut",
    "model_client_unavailable",
    "source:audio",
    "source:text",
    "source:visual",
    "text_change",
    "text_topic_shift_hint",
    "visual_change"
  ]
}
```

同一次运行还产出了 `mock-bvid_1_45.26_120.82`（`evidence.cut = [45.26, 120.82]`，
`previewTimestamp = 45.26`）与 `mock-bvid_1_120.82_180.00`（`evidence.cut = [120.82]`，
`reasons = ["fallback_merge", "model_client_unavailable"]`）。

注意样例中的 `previewTimestamp` 等于片段终点：该片段区间内唯一的候选切点就在终点上，
按第二节规则取「距中点最近的候选切点」即得到终点值，满足 `startTime <= previewTimestamp <= endTime`。

## 九、职责边界（不在本模块内）

- **入库建表**：片段如何落库、索引与字段如何映射，由后端负责人（朱家佑）决定，本模块只保证字段稳定。
- **检索索引**：向量化与索引结构由检索负责人（李陈熙）决定；本模块负责提供稳定的
  `description`（文本）、`startTime/endTime`（时间码）、`bvid/page`（视频元数据）与 `evidence`（依据）。
- 本模块只做映射，不做 I/O，不写数据库、不写向量库。

## 十、复现命令

```powershell
cd D:\VisionMark\code
node server/services/segmentPipeline/segmentContract.test.js
node server/scripts/testSegmentPipeline.js
```

debug 产物（含内部原始数组 `internalSegments` 与正式数组 `finalSegments`）写在
`server/debug/segment-pipeline/{videoId}-{timestamp}.json`，也可通过
`GET /video-analysis/segments/:videoId/debug` 读取。
