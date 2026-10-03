# 视频链路数据生命周期

本文描述**本地磁盘产物与 OSS 上 ASR 音频临时对象的实际行为**：谁生成、存在哪、多大、什么时候被复用、什么时候失效、以及 `cleanup()` 覆盖到哪一步。

所有磁盘路径都相对于仓库根目录（OSS 对象名不是磁盘路径，见第 6 节）。默认工作目录见 `server/services/videoAnalyzer.js:209`（`downloadDir`，默认 `downloads/`），`downloads/` 已在 `.gitignore` 中忽略。

---

## 1. 产物清单

| 产物 | 路径 / 命名 | 大小量级 | 生成者 | 会被复用吗 |
|---|---|---|---|---|
| 视频本体 | `downloads/{bvid}.mp4` | 取决于清晰度与时长，代码里没有大小常量 | `downloadVideoHybrid` → `BilibiliDownloader`（yt-dlp 强制 remux 为 mp4） | 是 |
| 音频 | `downloads/{bvid}.wav` | 32000 字节/秒 ≈ 1.9MB/分钟 | `extractAudio`（ffmpeg，16kHz 单声道 s16le） | 是 |
| 历史音频 | `downloads/{bvid}.mp3` | 同上量级 | 早期版本的 `extractAudio` | 是（老缓存兼容） |
| ASR 压缩副本 | `downloads/{bvid}.asr.mp3` | 约 0.5MB/分钟（16kHz 单声道 64kbps） | `transcribeAudio.compressAudio`，仅在音频 > 100MB 时生成 | 是 |
| 关键帧 | `downloads/{bvid}_frames/frame_{序号}_{毫秒}.jpg` | 最多 30 张，宽 640 | `extractFrames` | **否**，每轮重抽 |
| 视觉探针帧 | `downloads/{bvid}_visual_frames/visual_{序号}.jpg` + `manifest.json` | 最多 900 张，宽 320 | `extractVisualProbeFrames` | 是（靠 manifest 指纹） |
| 临时 cookies | `downloads/temp/{bvid}_cookies.txt` | 文本，KB 级 | `analyzeVideo` 第 2 步 | 否，用完即删 |
| 下载中间产物 | `downloads/{bvid}.mp4.part` / `.durl-{n}.mp4` / `.concat.txt` / `.video.m4s` / `.audio.m4s` / `.f{n}.{mp4,m4a,webm}` | 单个片段最大可接近整片 | yt-dlp / Bilibili 下载器 | 否，异常中断才残留 |
| debug 产物 | `server/debug/segment-pipeline/{safeId}-{ISO时间戳}.json` | 含完整 AI 原始输出，**无上限** | `writeDebugArtifacts`（每次分段主流程写一个） | 否 |
| OSS 音频对象 | `audio/{bvid}/{上传文件名}`（对象存储，不在磁盘） | 与上传音频同量级（默认 wav，超过上限时为 `.asr.mp3` 压缩副本） | `transcribeWithDashScope` 上传（`server/services/asr/transcribeAudio.js`） | **否**，本次运行到达终态即删（见第 6 节） |

`safeId` = `sanitizeId(videoId)`：非 `[a-zA-Z0-9_-]` 的字符替换成 `_`，并截断到 80 字符（`server/services/segmentPipeline/debugArtifactWriter.js:6`）。

---

## 2. 各类产物的失效条件

**视频本体** —— `findUsableCache` → `validateVideoFile`：文件存在、体积 ≥ 1024 字节（`MIN_VIDEO_BYTES`，`server/services/bilibiliDownloader.js:630`）、且 ffprobe 能读出视频流。任一条不满足就删掉重下。**重新下载代价最高，是唯一值得保留的产物。**

**音频（wav/mp3）** —— 命中缓存的前提是三条校验全过（`validateAudioFile`）：
1. 体积 > 32768 字节（`MIN_AUDIO_BYTES`，`server/services/videoAnalyzer.js:83`）；
2. ffprobe 能读出音频流；
3. 音频时长与参考时长之差 ≤ `max(2 秒, 参考时长 × 2%)`（`AUDIO_DURATION_TOLERANCE_SECONDS`，`videoAnalyzer.js:85`）。

不合格的缓存直接删掉重提；提取失败或超时的半成品也会被删除，避免一次失败永久污染后续分析。参考时长优先取**音轨**时长，取不到才退回容器时长（容器可能有纯画面尾巴）。

**ASR 压缩副本** —— 仅当源音频 > 100MB（`MAX_UPLOAD_BYTES`，`server/services/asr/transcribeAudio.js:34`）才生成。复用条件：文件存在、体积 > 0、**mtime 不早于源音频**。源音频重提（mtime 变新）后，旧副本自动失效。

**视觉探针帧** —— manifest 与当前请求逐项比对（`extractVisualProbeFrames`）：
`sample_fps`（默认 1）、`scale_width`（默认 320）、`max_frames`（默认 900）、`source_video` 绝对路径、`source_size`、`source_mtime_ms`，以及时长已知时的 `duration`。任何一项对不上就重新抽帧。**老 manifest 没有 `source_size`/`source_mtime_ms`，一律视为不匹配**——同名不同内容的视频（重下、换清晰度）绝不能复用旧帧。

**关键帧** —— 没有跨轮缓存：`extractFrames` 每次先删掉目录里的 `.jpg/.png` 再重抽。时间戳优先取关键帧（ffprobe `-skip_frame nokey`），少于 2 个且时长已知时退回每 5 秒均匀采样；时长未知且关键帧不足时直接抛错，不假造时间戳。

**临时 cookies** —— `analyzeVideo` 的 `finally` 里删除，成功失败都会执行；进程被强杀时可能残留。

**下载中间产物** —— 每次实际下载前由 `cleanupStaleArtifacts(bvid)`（`server/services/bilibiliDownloader.js:1360`）清掉上一轮的残留，调用点在 `videoAnalyzer.js:540` 与 `bilibiliDownloader.js:1453`。**这是当前唯一会自动执行的清理。**

---

## 3. cleanup()

```
analyzer.cleanup(bvid)                          // 全清
analyzer.cleanup(bvid, { keepVideo: true })     // 保留视频本体（重下代价高）
analyzer.cleanup(bvid, { keepDebug: true })     // 保留 debug 产物
analyzer.cleanup(bvid, { keepVideo: true, keepDebug: true })
```

**归属判据**（`belongsToBvid`，`videoAnalyzer.js:97`）：文件名属于该 bvid，当且仅当 `name === bvid + 后缀`（后缀为 `.mp4`/`.mp3`/`.m4a`/`.wav`）或 `name.startsWith(bvid + '.')` 或 `name.startsWith(bvid + '_')`。

判据必须落在分隔符边界上：老实现用的是裸 `startsWith(bvid)`，`cleanup('BV1aa')` 会把 `BV1aab.mp4`、`BV1aab.asr.mp3` 这些**另一个视频**的文件一起删掉。

**覆盖范围**：

| 目标 | 说明 |
|---|---|
| `downloads/{bvid}.*` 文件 | 视频本体、wav、老 mp3、`.asr.mp3` 压缩副本、下载中间产物（`.mp4.part`、`.durl-{n}.mp4`、`.concat.txt`、`.video.m4s` 等） |
| `downloads/{bvid}_frames/` | 关键帧目录 |
| `downloads/{bvid}_visual_frames/` | 视觉探针帧目录（含 manifest.json） |
| `downloads/temp/{bvid}_cookies.txt` | 异常中断残留的临时 cookies |
| debug 产物 | 经 `removeArtifactsFor(bvid)`，只删 `${safeId}-*.json` |

目录本身不会被当作文件删除（`cleanup` 的文件扫描跳过目录项），`temp/` 目录不会整体删除。

**返回值**：`{ removed: string[], failed: string[], debugArtifacts: number }`。`removed`/`failed` 是绝对路径数组，`debugArtifacts` 是实际删掉的 debug 产物数量（`keepDebug` 时为 0）。单个文件删除失败只记日志、进 `failed`，不影响其它文件，也不向外抛错。

**谁在调用**（全仓 grep 核实，不含 `node_modules`；`*cleanupDir` / `cleanupFiles` / `cleanupStaleArtifacts` 是各自模块的局部工具函数，不是这里说的 `VideoAnalyzer.cleanup()`）：

| 调用点 | 形式 | 说明 |
|---|---|---|
| `scripts/一键部署.bat` 的 `clean` 模式 | 内联 `node -e` 脚本，扫描 `downloads/` 下每个已缓存 bvid，逐个调 `cleanup(id, { keepVideo: true })` | 正式运维入口（`docs/DEPLOYMENT.md` 第 8 节），需要操作者显式执行，不会自动触发 |
| `server/services/videoAnalyzer.cleanup.test.js` | 单测直接调用 | 覆盖全清、`keepVideo`、`keepDebug` 以及前缀不误伤等分支 |

**生产服务进程（`server.js`、`server/routes/**`）里仍然没有任何自动调用**，也没有定时任务：`analyzeVideo` 成功路径**不会**自动清理（那会破坏上面这些缓存复用）。换句话说，`cleanup()` 现在有真实的显式调用点（bat 的 clean 模式与单测），但"跑一次分析就把缓存清掉"这类自动化依然不存在。手动入口见 `docs/DEPLOYMENT.md` 第 8 节的 `node -e` 命令。

---

## 4. 没有自动清理的部分

- **debug 产物没有自动清理**。`writeDebugArtifacts` 每次分段主流程写一个文件，目前不存在任何定期清理或数量上限，只能靠 `removeArtifactsFor(videoId)` / `cleanup(bvid)` 显式删除。`server/debug/` 已在 `.gitignore:43` 忽略，不会被提交，但会一直占磁盘。
- **`downloads/` 下的产物同样没有自动过期机制**。除了下载中间产物（每次下载前清）和临时 cookies（每轮 finally 清），其余都要靠 `cleanup()` 手动清。
- **OSS 上的历史音频对象没有自动清理**。本次改动之前的版本上传后从不删除，会一直累积并持续计费；`pruneAudioObjects` 提供了显式清理入口，但没有任何定时任务调用它（见第 6 节）。

本文不描述任何定期清理计划——目前没有这样的实现。

---

## 5. 常量对照

| 常量 | 值 | 位置 |
|---|---|---|
| `MIN_AUDIO_BYTES` | 32768（32KB） | `videoAnalyzer.js:83` |
| `AUDIO_DURATION_TOLERANCE_SECONDS` | 2 | `videoAnalyzer.js:85` |
| `MAX_FRAMES`（关键帧上限） | 30 | `videoAnalyzer.js:840` |
| 关键帧宽度 | 640 | `videoAnalyzer.js:859`（`scale=640:-1`） |
| `maxFrames`（视觉探针帧上限） | 900 | `videoAnalyzer.js:913` |
| `sampleFps` | 1 | `videoAnalyzer.js:908` |
| `scaleWidth` | 320 | `videoAnalyzer.js:916` |
| 均匀采样间隔 | 5 秒 | `videoAnalyzer.js:830` |
| `MIN_VIDEO_BYTES` | 1024 | `bilibiliDownloader.js:630` |
| `MAX_UPLOAD_BYTES`（ASR 上传上限） | 100MB | `transcribeAudio.js:34` |
| 压缩副本码率 / 采样率 | 64kbps / 16kHz | `transcribeAudio.js:36-37` |
| debug id 截断长度 | 80 | `debugArtifactWriter.js:7` |
| `AUDIO_OBJECT_PREFIX`（OSS 音频对象前缀） | `audio/` | `server/utils/oss.js` |
| `DEFAULT_AUDIO_RETENTION_DAYS`（`pruneAudioObjects` 默认保留期） | 7 天 | `server/utils/oss.js` |
| `LIST_PAGE_SIZE`（OSS 列举每页条数） | 1000 | `server/utils/oss.js` |

---

## 6. OSS 侧：ASR 音频对象

DashScope 异步转写不能直接读本地文件，`transcribeWithDashScope` 必须先把音频传到 OSS，再把公网 URL 交给任务（`server/services/asr/transcribeAudio.js`）。第 1–5 节的本地文件与这里的 OSS 对象是**两套独立的生命周期**：`cleanup(bvid)` 只删磁盘产物，不会删任何 OSS 对象；反过来手删 OSS 对象也不影响本地缓存。

### 6.1 命名规则与上传

- 对象名：`audio/{bvid}/{上传文件名}`，由 `buildAudioObjectName(bvid, fileName)`（`server/utils/oss.js`）集中生成，上传与删除共用同一函数；`bvid` 缺失时兜底为 `audio/unknown/...`。
- 上传文件：默认是 `downloads/{bvid}.wav`；超过 100MB 上限时是压缩副本 `downloads/{bvid}.asr.mp3`，对象名随之上传文件名变化。
- 上传时机：每次调用 `transcribeWithDashScope` 通过前置检查后立即上传，不做跨轮复用，**每次分析都会重新上传一份**。
- 依赖 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_BUCKET`（以及可选的 `OSS_REGION`）环境变量；未配置时 ASR 直接报“OSS 未配置”。

### 6.2 删除时机

上传成功后，`transcribeWithDashScope` 用 `try/finally` 兜住后续所有出口，**本次运行到达终态即删**：

| 出口 | 本次上传的对象 |
|---|---|
| 转写成功（SUCCEEDED，结果已取回） | 删除 |
| 任务 FAILED / 未知状态 | 删除 |
| 提交任务失败（网络错误、拿不到 task_id） | 删除 |
| 我们自己轮询超时、放弃等待 | 删除 |

删除走 `deleteOssObject(objectName)`，传入的是本次生成的**精确对象名**；主流程里任何情况下都不按前缀批量删。删除失败（SDK 抛错、OSS 未配置）只 `console.warn` 并返回 `false`，不影响已经拿到的转写结果。

**时序上的取舍**：任务到达终态后远端不再需要该文件；但如果我们自己超时放弃，远端的转写任务可能仍在运行，此时删掉对象会让它后续下载失败。这是可接受的——我们这边已经放弃等待，而对象留在 OSS 上会永久计费（该取舍也写在 `transcribeAudio.js` 文件顶部注释里）。

### 6.3 历史遗留对象与显式清理

本次改动之前上传的记录**不会被自动清理**（旧版本上传后从不删除），需要用下面的显式入口手动处理。这些函数只在你调用时执行，仓库里没有任何定时任务会调用它们：

```js
const { pruneAudioObjects, removeAudioObjectsFor } = require('./server/utils/oss');

// 1) 批量清理：删除 audio/ 前缀下、lastModified 早于 7 天前的对象
//    返回 { scanned, removed, failed }；未过期的对象不会被动
const stats = await pruneAudioObjects({ olderThanDays: 7 });

// 2) 只清理某一个 bvid 的全部音频对象，返回成功删除的数量
const removed = await removeAudioObjectsFor('BV1xxxxxxxxx');
```

- 保留期由 `olderThanDays` 控制，默认 7 天（`DEFAULT_AUDIO_RETENTION_DAYS`）；只比较对象的 `lastModified`，不看对象名里可能出现的日期；`lastModified` 拿不到的对象不删并计入 `failed`。
- `list` 分页列举：每页最多 1000 条（`LIST_PAGE_SIZE`），用 `marker` 翻页直到翻完；单个对象删除失败只计入 `failed`，不影响其它对象。
- 这些函数使用 `process.env` 上的 OSS 配置（与主服务同一套变量），建议在服务同环境的机器上执行；不要在示例或脚本里写死密钥。
