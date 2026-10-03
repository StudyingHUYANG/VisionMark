# 媒体链路基线（W1-ZHX-02 / W1-ZHX-03）

把「跑一遍视频链路，看日志里对不对」变成可重复执行、可逐次比对、能判 FAIL 的入口。

- **W1-ZHX-02**（稳定抽帧、音频提取、ASR、视觉候选切点）→ 脚本记录每个环节的实测值，`--compare` 对确定性项做回归判定。
- **W1-ZHX-03**（候选切点融合、边界校验、语义合并、证据输出）→ 脚本对 `final_segments` 逐条跑不变量，任一条不过即判 FAIL。

---

## 1. 怎么跑

```powershell
cd D:\VisionMark\code

# 跑清单里所有 enabled 的条目（产出 JSON + Markdown 摘要）
node server/scripts/baselineMediaPipeline.js

# 换清单 / 只跑指定几项
node server/scripts/baselineMediaPipeline.js --list server/scripts/baseline-videos.json
node server/scripts/baselineMediaPipeline.js --only local-1,bv-1

# 对比两次运行
node server/scripts/baselineMediaPipeline.js --compare server/debug/baseline/A.json server/debug/baseline/B.json

# 默认离线；确需真实大模型/下载路径时才显式打开（会调用真实付费接口，见下）
node server/scripts/baselineMediaPipeline.js --allow-network
```

退出码：跑批时**任一视频不变量不过或整段流程报错 → 非 0**；对比时**确定性项有不一致 → 非 0**。

**默认完全离线，不会外呼**：脚本启动时在进程内安装出网守卫（拦 `http` / `https` / `net` / `dns` / 全局 `fetch`），默认阻断一切外部网络，并把出网尝试计数写进摘要与 JSON 的 `network` 块。`source: "bvid"` 的条目在离线模式下直接跳过（下载由 yt-dlp 子进程发起，进程内守卫管不到），跳过原因写在摘要里。

**为什么必须默认离线**：服务层 `server/services/modelConfigService.js` 内置了一个 DashScope 兜底 key，即使用户没配置 key，`analyzeVideo` 与分段语义合并也会拿它真实外呼付费接口（实测默认清单一轮会发出 6 次请求）。所以"不需要大模型 API key"不等于"不会外呼"——默认模式下由守卫兜底：**不需要你配置 key，也不会拿内置 key 外呼**。此时没有 key/网络就走降级路径，降级原因如实写进基线（见 §7）。真实 ffmpeg/ffprobe 会被调用，单个视频约几十秒。

要验证真实大模型（及下载）路径，必须显式打开开关；打开后摘要会醒目提示"本次会调用真实付费接口（DashScope 等）"，并给出进程内出网尝试计数（`http`/`https`/`fetch`，不含 yt-dlp 等子进程）：

```powershell
node server/scripts/baselineMediaPipeline.js --allow-network
# 或
$env:BASELINE_ALLOW_NETWORK = "1"; node server/scripts/baselineMediaPipeline.js
```

**视频清单**：`server/scripts/baseline-videos.json`，当前是 3 个占位项（1 个本地文件 + 2 个公开 BV 号），文件头的 `_comment` 写明「正式基线需要团队确认的 5 个视频，待替换」。两个 BV 占位项默认 `"enabled": false`——跑它们会触发真实下载（可能撞 B 站风控），团队确认后再打开。`source: "file"` 的项跳过下载直接分析本地文件，其余环节全部真实执行。

**跳过项会被列出来**：跑批摘要（stdout 的 Markdown 和 JSON 的 `skipped[]`）里有独立一段「本轮跳过的条目」，逐条给 id 和原因（`enabled=false` / `--only 未选中`）。不会静默少跑。

**`source: "file"` 的 bvid 解析规则**（按优先级）：

| 优先级 | 来源 | 例子 |
|---|---|---|
| a | 清单项显式给的 `bvid` 字段 | `"bvid": "BV1TiuZ6TEQw"` |
| b | **文件名**里匹配 `/BV[0-9A-Za-z]{10}/` | `downloads/BV1TiuZ6TEQw.mp4` → `BV1TiuZ6TEQw` |
| c | 兜底 `local-<entryId>` | `local-1` |

**兜底形态一眼看得出不是 BV 号**。为什么不能用 `BV{entryId}` 这类假号：代码里没有任何地方校验 bvid 格式，假 BV 会静默流进 `segmentId`、debug 产物，将来还可能被抄进文档或库。解析结果记在基线的 `bvid` + `bvidSource`（`explicit` / `filename` / `fallback`）里，能看出这次用的是哪条路径。

`source: "bvid"` 的项不受该规则影响：bvid 就是 `value`。

---

## 2. 产出在哪

| 产出 | 位置 |
|---|---|
| 完整记录（供 `--compare` 读） | `server/debug/baseline/{YYYYMMDD-HHmmss}-baseline.json` |
| Markdown 摘要（可直接贴进验收文档） | stdout |

`server/debug/` 已在 `.gitignore` 里忽略，所以基线**不会被提交**。要把某次结果留档或发给别人，得手动把 JSON 复制出去。

---

## 3. 覆盖范围（本轮填不满）

**本轮全部为本地文件，未覆盖下载链路**——`source: "file"` 的项会跳过 `downloadVideoHybrid`，
所以下载降级、Cookie 切换、风控错误分类这些都不在基线内；`download` 相关字段为 `{skipped: true}`
（`path` / `elapsedMs` / `cachedBeforeRun` 为 `null`）属预期，**不代表该项通过**。
这段话同时写进跑批摘要和 JSON 的 `coverage` 字段。

另外，默认离线模式下 `source: "bvid"` 的条目会被直接跳过（原因写进摘要的「本轮跳过的条目」），所以离线跑批天然只能覆盖本地文件项；要覆盖下载链路必须显式 `--allow-network`。

对照 W1-ZHX-02 的覆盖矩阵：

| 环节 | 谁能覆盖 | 本轮 |
|---|---|---|
| 下载（降级 / Cookie 切换 / 风控错误分类） | 只有 `source: "bvid"` 的项 | ✗ **空** |
| 抽帧 | file / bvid 都可以 | ✓ |
| 音频提取 | 同上 | ✓（复用已有 wav 缓存） |
| ASR | 同上 | ✓（`provider=none`，走降级） |
| 视觉候选切点 | 同上 | ✓（缺 numpy，回退 `ffmpeg_scene`） |

**验收口径**：正式基线必须把清单里的 5 个视频全部置 `enabled: true`（并把占位项替换成团队确认的素材）；
上面这张 5 格矩阵不写满，就不算完成 W1-ZHX-02 的验收。当前只填了 4 格，下载那格是空的。

## 4. 每个字段的含义

单条视频记录（`videos[]`）：

| 字段 | 含义 | 数据来源 |
|---|---|---|
| `bvid` / `bvidSource` | 本次分析实际使用的 bvid，以及它是怎么来的（`explicit` / `filename` / `fallback` / `value`） | 脚本解析（见 §1） |
| `status` | `ok` / `fail`（不变量不过）/ `error`（流程报错） | 脚本判定 |
| `errors[]` | 报错，带 `code`/`reason`/`stage`（下载类错误有） | `analyzeVideo` 抛出的错误 |
| `elapsedMs` / `stageTimings[]` | 总耗时；各阶段进度回调覆盖的时间窗（不是精确 CPU 时间） | 进度回调 |
| `download` | `cachedBeforeRun`（**运行前**目标文件是否已存在）、`path`、`sizeBytes`、`elapsedMs`；`source=file` 时记 `skipped` + 原因 | 脚本探测 |
| `duration.value` / `.durationSource` | 时长与其来源：`probe`（ffprobe）/ `decoded`（解码末帧）/ `derived_from_keyframes`（探测失败后用最大关键帧时间戳兜底）/ `unknown` | `analysis.duration(_source)` |
| `frames` | `count`（抽帧数）、`failedCount`（失败帧数）、`keyframeTimestampCount`、`keyframeTimestamps[]` | `extractFrames` 返回值（观测）+ 磁盘帧目录 |
| `visualProbe` | `frameCount` / `sampleFps` / `scaleWidth` / `maxFrames` / `effectiveFps` / `cached` / `durationSource` | `extractVisualProbeFrames` 返回值（观测） |
| `visualCuts` | `count`、`method`（`metrics_fusion` / `ffmpeg_scene` / `unavailable`）、`durationSource`、`fallbackFrom`、`fallbackReason`、`times[]` | `analysis.visual_cuts` + `visual_cut_stats` |
| `audio` | 路径、体积、时长与来源、`reusedLegacyMp3`、`postRunVerdict`（跑完后用 `validateAudioFile` **复检**的结论，不是运行中那次判定的原值） | `probeAudioDuration` / `validateAudioFile` |
| `audioCuts` / `keywordCuts` | `count` + `times[]` | `audioCuts` 只能从本轮 debug 产物的 `evidence.audioCuts` 读（`analyzeVideo` 不透出该字段），拿不到就写 null + 原因 |
| `candidateCuts` | 融合后的候选切点数量、被采用的条数 | `analysis.candidateCuts` |
| `asr` | `provider`、`segmentCount`、`degradations[]`、`error`、`elapsedMs`、`transcriptText` | ASR 模块调用（观测） |
| `segmentPipeline` | `mode`、`confidence`、`usedAI`、**`fallbackReason`**、`artifactPath`、`warnings[]` | `analysis.segmentPipeline` |
| `segments` | `count`、`ids[]`、`boundaries[]`、`invariantFailures[]` | `analysis.final_segments` + 不变量检查 |

JSON 顶层还有三项：`skipped[]`（本轮跳过的条目 id / value / 原因）、`coverage`（本地文件项与下载项的条数、是否覆盖了下载链路）与 `network`（出网总账：`mode` 为 `offline` / `allow-network`，`realModelUsed`、`egressAttempts`（进程内 http/https/fetch 尝试次数）、`blockedConnections`、`blockedDnsLookups`、`actualEgress`（离线模式恒为 0；在线模式为 null，因为计数不含子进程）、`hosts`、`samples`）。每条视频记录里另有 `egressAttempts`，表示该视频跑动期间的出网尝试次数。

**关于「观测包装」**：`抽帧失败数`、`visualProbe.meta`、`ASR provider/degradations` 这几项 `analyzeVideo` 的返回值里没有。脚本对 `extractFrames` / `extractVisualProbeFrames` 实例方法和 `asr` 模块做了只读包装——**调用原实现、只记录返回值，不改入参也不改结果**。包装也拿不到的字段一律写 `null` 并带 `reason`/`*Reason`，不编造。

---

## 5. 不变量检查（W1-ZHX-03 的验收口径）

对 `final_segments` 逐条执行，任一条不过 → 该视频 `status = fail`，脚本退出码非 0：

1. `0 <= startTime < endTime <= duration`（duration 已知时；`endTime` 允许 `0.011` 的舍入余量，因为 `segmentContract` 用 `toFixed(2)`）
2. `title` 非空、`description` 非空
3. `evidence` 四桶（`visual` / `speech` / `keyword` / `cut`）至少一个非空
4. `segmentId` 同一次结果内唯一，形状 `{bvid}_{page}_{start}_{end}`、起止两位小数，且前缀与 `bvid` 一致
5. `page === 1`、`source === 'segment_pipeline'`
6. `previewTimestamp` 落在 `[startTime, endTime]` 内
7. `confidence ∈ {0.2, 0.5, 0.8}`
8. 相邻片段不重叠：`start[i] >= end[i-1] - 1`（`COVERAGE_TOLERANCE_SECONDS`）

第 8 条的容差常量在 `segmentValidator.js:20`，服务层**没有导出**它；基线跑批自身只读、不改动 `server/services/**`，所以脚本里复制了一份，改那边时记得同步。

---

## 6. `--compare` 的两类差异

依据：`docs/SEGMENT_PIPELINE_CONTRACT.md` 第五节——语义合并走大模型，**片段边界不保证跨次可复现，`segmentId` 随之变化**。

**(a) 确定性项 —— 不一致即回归，退出码非 0**

`duration.value`、`duration.durationSource`、`frames.count`、`frames.keyframeTimestampCount`、`visualProbe.frameCount`、`visualCuts.count`、`visualCuts.times[]`、`audioCuts.count`、`audioCuts.times[]`。

这些来自 ffprobe / ffmpeg / 视觉指标等纯计算环节，同一输入同一机器应当逐次一致。

**(b) 允许抖动项 —— 只报差异量级，不判失败**

`asr.transcriptText`（长度差）、`segments.boundaries + ids`（条数差、边界最大差秒数、id 差异个数）。

两类混在一起看，要么把模型抖动误判成回归，要么让真回归淹没在噪声里，所以必须分开报。

---

## 7. 已知无法保证可复现的部分

- **语义合并导致的片段边界抖动**：这一段由大模型（默认离线或调用失败时是本地 fallback）决定，边界和 `segmentId` 跨次可能不同。契约第五节已显式声明。因此 `segmentId` 只适合做「同一份分析结果内的主键」，不要当跨次稳定主键用。
- **ASR 转录文本**：识别结果本身受音频与模型影响，不保证逐字一致。
- **默认离线（或大模型不可用）时**：`segmentPipeline.usedAI=false`，`description` 会退化成结构性兜底文本（`warnings` 里能看到 `segment_summary_filled_with_structural_text:*`）；此时边界反而比有 AI 时更稳定。
- **视觉候选切点**：`visual_cut_metrics.py` 依赖 numpy，本机没装时整条 python 路径失败、回退到 `ffmpeg scene`（`method=ffmpeg_scene`、`fallbackFrom=python_visual_metrics`）。两种方法的召回不同，**换机器/换环境跑出来的 `visualCuts` 不能直接对比**——比对时先看 `visualCuts.method` 是否一致。

---

## 8. 目前还没解决的问题

跑基线时实际遇到的。基线跑批自身不改动 `server/services/**`（当前工作区里服务层有 16 个文件、约 2400 行改动，来自其它并行任务，与基线跑批无关），所以这些问题只能在基线侧绕过并记录在案，修复属于服务层的独立工作：

1. **`analyzeVideo` 不透出中间产物信息**：抽帧失败数、`visualProbe.meta`、`audioCuts`、ASR `provider`/`degradations`、下载是否命中缓存，返回值里都没有。脚本只能靠观测包装 + 读 debug 产物 + 读磁盘来补，属于绕过而不是解决。理想情况是 `analyzeVideo` 直接返回一份 `stages` 明细。
2. **`COVERAGE_TOLERANCE_SECONDS` 未导出**，只能复制常量。
3. **`postRunVerdict` 是事后复检**：音频缓存校验的真实判定发生在 `extractAudio` 内部，不透出；基线里记的是跑完之后再调一次 `validateAudioFile` 的结果，两者在极端情况下可能不同。
4. **`download.cachedBeforeRun` 只是近似**：它表示「运行前 `downloads/{bvid}.mp4` 是否存在」，不等于「本轮真的命中了缓存」（`isUsableCache` 的判定结果没有透出）。
5. **本机无 numpy / 无 OSS 配置 / 无 Whisper，且默认离线（守卫阻断大模型外呼）**，所以当前基线覆盖的是**全降级路径**。要覆盖正常路径，需要在装了 numpy、配好 key/OSS 的环境上用 `--allow-network` 再跑一轮，两份基线分别留档。
6. **清单还是占位**：正式 5 个视频待团队确认后替换，两个 BV 占位项默认关闭。

---

## 9. 本机参考结果（2026-10-03，默认离线模式，全降级路径）

视频：`downloads/BV1TiuZ6TEQw.mp4`（本地文件，8.8MB，94.23s）

| 项 | 值 |
|---|---|
| bvid | `BV1TiuZ6TEQw`（`bvidSource=explicit`，与文件名推断结果一致） |
| segmentId 形态 | `BV1TiuZ6TEQw_1_0.00_25.15` …… `BV1TiuZ6TEQw_1_82.40_94.23` |
| duration | 94.233313（`probe`） |
| 抽帧 | 20 张，失败 0，关键帧时间戳 20 个 |
| 视觉探针帧 | 95 张（sampleFps=1、scaleWidth=320、maxFrames=900）；**第一次跑 `cached=false`（重抽），第二次 `cached=true`（命中缓存）** |
| visualCuts | 5 个，`method=ffmpeg_scene`（python 路径因缺 numpy 回退） |
| audioCuts / keywordCuts | 8 / 0（无转录，故无关键词切点） |
| audio | 复用已有的 `downloads/BV1TiuZ6TEQw.wav`（3014734 字节，校验通过） |
| ASR | `provider=none`，2 条降级，耗时 163ms |
| 分段 | 5 段，`usedAI=false`，`fallbackReason=ai_merge_failed:Connection error.`（默认离线：守卫阻断外呼后 SDK 报连接错误；旧版无守卫时这里记录的是真实请求返回的 401） |
| 出网 | 默认离线：6 次出网尝试（全部指向 `dashscope.aliyuncs.com`）被进程内守卫阻断，实际出网 0，摘要写明"本轮未使用真实大模型" |
| 不变量 | 5 段全部通过（0 处失败） |
| 覆盖 | 本地文件 1 项 / 下载项 0 项 —— **下载链路未覆盖** |
| 跳过 | `bv-1`、`bv-2`（`enabled=false`），摘要里有独立一段列出 |
| 整轮耗时 | 约 28s（相比无守卫时多了 SDK 对连接错误的重试退避） |

连跑两次 `--compare`：确定性项 0 处不一致，抖动项 0 处差异（全降级路径下边界也确实稳定）。
