# VisionMark 后端接口与运行说明

适用范围：朱家佑 W1-ZJY-01～03、W2-ZJY-01～03。现有搜索协议继续由检索模块维护。

## 启动

```powershell
npm install
npm --prefix server install
npm --prefix server start
Invoke-RestMethod http://127.0.0.1:8080/api/v1/health
```

环境变量优先于文件；其次为 `server/.env`，最后为仓库根 `.env`。从任意工作目录启动，默认数据库都指向 `server/database/app.db`。

配置示例见 `server/.env.backend.example`：

| 变量 | 默认/要求 |
| --- | --- |
| HOST | `127.0.0.1`，需要局域网访问时显式修改 |
| PORT | `8080`，整数；`0` 用于自动化测试随机端口 |
| DB_PATH | `./database/app.db`，相对 server 目录；可用绝对路径 |
| JWT_SECRET | production 环境必填且至少 32 字符；开发环境过短时回退本地随机密钥 |
| QWEN_API_KEY | 可选；也可以登录后保存个人模型配置 |
| CORS_ORIGIN | 默认 `*`，不启用跨源 Cookie 凭据；可填写逗号分隔源列表 |

开发环境未提供 JWT_SECRET 或配置不足 32 字符时，在数据库同目录自动生成 `.jwt-secret`，重启继续使用。首次从旧硬编码密钥版本升级后需重新登录。不要提交密钥文件。新库不自动创建 admin/admin；通过注册接口创建用户。现有用户、标注和模型配置保留。

健康检查只验证服务和数据库，不承诺外部模型或视频源可用。配置错误以 `CONFIG_*` 定位，端口占用以 `PORT_IN_USE` 定位。进程支持 SIGINT/SIGTERM 关闭；未完成任务在下次启动时标记中断。

## 鉴权与错误

除健康检查、注册和登录外，下面接口都要求：

```http
Authorization: Bearer <登录返回的 token>
```

`POST /api/v1/auth/register`：`{"username":"your-name","password":"your-password"}`，密码至少 8 字符、最多 72 字节，用户名最多 64 字符。成功 201，重名 409。

`POST /api/v1/auth/login`：相同字段，成功返回 token、username、points、tier。token 有效期 7 天。`GET /api/v1/auth/me` 返回当前用户。

非检索接口错误统一返回，`error` 保持字符串以兼容插件：

```json
{
  "success": false,
  "code": "MODEL_NOT_CONFIGURED",
  "error": "请先配置模型 API Key",
  "message": "请先配置模型 API Key",
  "requestId": "服务生成的唯一请求编号"
}
```

响应头 `X-Request-ID` 与响应体一致。日志只输出可定位编号和分类码，不输出原始异常对象、Bearer、Cookie、密钥和密码；底层日志经过脱敏器。请求体上限 256 KiB。

| HTTP | 常见 code |
| --- | --- |
| 400 | INVALID_JSON、INVALID_PARAMETER、INVALID_BVID、INVALID_SEGMENT、INVALID_MODEL_URL |
| 401 | AUTH_REQUIRED、TOKEN_INVALID、TOKEN_EXPIRED、LOGIN_FAILED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND、TASK_NOT_FOUND、ANNOTATION_NOT_FOUND、FRAME_NOT_FOUND |
| 409 | USERNAME_EXISTS、VIDEO_BUSY、TASK_RUNNING、INDEX_BUSY |
| 413 | PAYLOAD_TOO_LARGE |
| 422 | MODEL_NOT_CONFIGURED |
| 502 | MODEL_AUTH_FAILED、UPSTREAM_TIMEOUT、UPSTREAM_RATE_LIMITED、UPSTREAM_UNAVAILABLE、VIDEO_ACCESS_RESTRICTED、ANALYSIS_FAILED |

底层错误缺少结构化状态码时归为 ANALYSIS_FAILED；不向用户透传服务商报错、请求配置或堆栈。

## 模型配置

- `GET /api/v1/model-config`：返回 configured、effectiveSource、hasCustomConfig、data；仅返回 hasApiKey，不返回密钥。
- `POST /api/v1/model-config`：provider（当前仅 qwen）、apiKey、baseUrl、modelName、isEnabled（布尔值）。新建必须提供密钥；更新省略 apiKey 保留旧值。
- `POST /api/v1/model-config/test`：同上，支持 useDefaultKey；使用默认/已保存密钥时限定原配置地址。请求超时 15 秒，不自动重试，返回统一错误码。

baseUrl 必须为 HTTP(S)，不允许 URL 用户凭据、查询串或片段。关闭个人配置后可使用系统默认配置；两者均无有效 Key 时分析返回 422，尚不创建下载任务。

## 分析任务

所有 `/video-analysis/...` 路径也支持 `/api/v1/video-analysis/...` 前缀。

| 方法/路径 | 行为 |
| --- | --- |
| POST /video-analysis/tasks | 创建异步任务，202 返回 data.taskId 与状态；推荐新客户端使用 |
| GET /video-analysis/tasks/:taskId | 查询自己的任务；完成后 data.result 包含完整分析结果 |
| POST /video-analysis/analyze | 兼容插件，保持连接直到分析完成，返回 success、taskId、reused、data |
| GET /video-analysis/status/:bvid | 查询自己的最新任务状态；无记录返回 idle |
| GET /video-analysis/vector-progress?bvid=... | 查询自己最近任务的持久化索引进度 |
| POST /video-analysis/batch | `{"videos":[{"bvid":"BV1234567890"}]}`，1～5 个，逐项分析、落库并返回独立成功/失败信息 |

创建任务体：

```json
{"bvid":"BV1234567890","bilibili_cookies":"可选的 yt-dlp Cookie 文本"}
```

BV 号须满足 `BV` + 10 位字母数字；Cookie 最多 32768 字符，只传给分析器，不写入任务/统计表。

状态字段：taskId、bvid、status、stage、percent、message、errorCode、startedAt、updatedAt、finishedAt、durationMs。status 为 running/completed/failed；未创建时查询为 idle。stage 沿用 prepare/download/frames/visual/audio/speech/model/finalize 等分析阶段。进度百分比单调且限制在 0～100，状态是判定失败的依据。

同一用户、同一 BV 的运行中请求复用任务和执行 Promise，不再次调用模型。另一用户请求同一运行中视频返回 409 VIDEO_BUSY，因为下载缓存和索引当前按 BV 共享。分析结束但索引仍在构建时返回 INDEX_BUSY，防止共享索引写入冲突。

结果、annotations 和 completed 状态在同一事务提交；单项或批量走相同路径。中途失败不会写入半成品标注。已完成结果重启后仍可读取。未完成任务重启后成为 failed / SERVER_RESTARTED，可重新提交；不自动恢复下载进程或再次发起付费模型调用。部署为单服务进程使用同一数据库，不支持多进程 worker 同时运行恢复逻辑。

## 片段、素材与兼容接口

- `GET /api/v1/segments?bvid=...` 保留 segments、ai_title、ai_summary、knowledge_points、hot_words、visual_cuts、keyword_cuts、candidateCuts、segmentPipeline、final_segments、material_extraction、material_clips。
- `POST /api/v1/segments`：bvid、可选 cid、start_time、end_time、ad_type。时间必须为有限数字且 `0 <= start_time < end_time`，ad_type 为 soft_ad/hard_ad；标注和积分在同一事务写入。
- `DELETE /api/v1/segments/:id`：只允许创建者删除，查权限与删除使用同一 annotations 表。
- `GET /api/v1/segments/user`：当前用户片段。
- `POST /api/v1/segments/batch`：`{"bvids":["BV1234567890"]}`，最多 50 个，结果按 BV 分组。
- `GET /api/v1/video-view?bvid=...`：保留旧插件视图。
- `GET /video-analysis/material-frames/:bvid/:runId/:fileName`：鉴权、路径校验、私有缓存。
- `GET /video-analysis/segments/:bvid/debug`：仅允许查询自己发起过分析的视频，不返回本机文件路径。
- `POST /video-analysis/extract-keyframes`：明确返回 501 NOT_IMPLEMENTED，避免旧占位代码假报成功；关键帧仍由完整分析流水线提取。

数据边界：本项目现有视频、annotations、向量索引属于登录用户可访问的共享视频资料库；本次隔离任务、实时进度、个人配置及技术统计，未改造为私有视频多租户系统。

## WebSocket

```text
ws://127.0.0.1:8080/?token=<JWT>&bvid=BV1234567890
```

连接验证 JWT 和用户；无效或过期关闭 4001。仅推送“同一用户 + 已订阅 BV”的消息。不携带 bvid 的旧连接不接收进度，可继续 HTTP 轮询。也可发送 `{"type":"subscribe","bvid":"BV1234567890"}` 切换订阅，订阅时立即重放持久化状态。非法消息关闭 4000。每 30 秒心跳检查并检查 token 过期。

```json
{"type":"progress","data":{"taskId":"...","bvid":"BV1234567890","status":"running","stage":"download","percent":25,"message":"正在下载"}}
```

插件已配套携带 BV、核对消息 BV、读取失败状态，并避免旧连接关闭事件清空新连接。

## 技术观测

`GET /api/v1/stats/technical?hours=24`，hours 为 1～720 的整数，返回当前用户的：

- tasks：状态计数、平均/最大总耗时（毫秒）。
- stages：已结束阶段计数、平均/最大耗时；运行中的当前阶段尚未计入。
- failures：任务失败分类计数。
- models：模型、操作、成功/失败、错误码、次数及平均/最大耗时。
- requests：路由模板、方法、HTTP 状态、请求次数、平均/最大延迟。
- queryLatency：从 requests 中提取搜索接口请求耗时，包括失败请求。

模型统计覆盖分析器创建的 Chat Completions 客户端（含视觉、文本与分段/素材解读）、ASR 提交和配置连接测试。一次 SDK 调用算一次，内部重试不拆分；ASR submit 只表示任务提交，不表示最终转写成功。独立 embedding/rerank 调用尚由检索模块负责，未冒充为已统计。

请求耗时按 UTC 小时聚合；查询窗口的首小时按整个桶计入。未认证请求不计入个人统计。只记录路由模板，不存搜索词、请求体或 token。旧 `/stats/overview`、`popular-videos`、`top-users` 继续提供共享汇总；`user/contributions` 仅可查看当前用户并验证分页。

## 数据库升级与自测

schema_migrations 记录每次成功迁移；每版本事务执行，失败回滚。v1 兼容现有 users/user_points/videos/annotations/user_api_configs，v2 新增 analysis_tasks、analysis_stages、model_calls、request_metrics 及索引。不删除旧记录。未知的更高版本拒绝启动。

数据库文件升级前应备份；SQLite 数据和 `.jwt-secret` 持久保留，不属于临时视频缓存。可停服后备份完整数据库目录。统计当前保留全部记录，查询接口限制时间窗；自动归档策略留作后续容量管理。

```powershell
npm run test:backend
npm test
npm run build
```

后端测试使用系统临时目录的新数据库、模拟分析器、本地 HTTP 模型服务、真实 HTTP/WebSocket 与独立 Node 进程验证；不修改用户正式 app.db，不调用付费模型或真实视频下载。测试完成清理临时目录。


## 2026-10-02 下载稳定性修复

- 首选 B 站下载器现在使用插件提交的 Netscape Cookie，过滤过期、非 API 域和非法值；账号 Cookie 仅发送给 B 站 API，不发送给视频 CDN。
- 普通网络瞬断最多重试一次，间隔 1 秒；412、429、登录/观看权限拒绝不自动反复请求，也不切换参数继续尝试访问限制。
- 仅普通下载失败或不支持的流格式才回退 yt-dlp；取消原先的 WBI 参数切换与跳过 TLS 证书检查。
- API 请求超时 15 秒，直连媒体下载总时限 5 分钟；yt-dlp 网络超时 30 秒、进程总时限 10 分钟。
- Python 优先使用 VISIONMARK_PYTHON，其次项目 .venv，最后系统 python。VISIONMARK_PYTHON 应填写 Python 可执行文件路径，不附带命令参数。
- 媒体先写 `.mp4.part`，流完整且长度检查通过后改名；失败清除本次临时文件，不把半成品当完整视频。该改动不自动校验/删除历史版本产生的非空缓存。
- 下载故障返回 VIDEO_ACCESS_RESTRICTED、VIDEO_LOGIN_REQUIRED、VIDEO_NOT_FOUND、DOWNLOAD_TIMEOUT、DOWNLOAD_DEPENDENCY_MISSING 或 DOWNLOAD_FAILED，以及 taskId。

使用时重启后端，在已登录且能够播放视频的 B 站页面刷新插件后重新分析。若仍返回 412，说明站点限制仍存在；这些改动不能保证解除风控，不建议连续点击重试。本次使用模拟 API/媒体流验证 Cookie 路由、限次重试、异常清理，尚未以用户登录 Cookie 验证该视频成功下载。


### 插件 Cookie 获取链路补修

此前 `content/utils.js` 在 content script 中直接访问 `chrome.cookies`，但该 API 不在网页内容脚本的可用接口中，导致已登录用户的请求也没有 Cookie。本次添加 `extension/background.js` service worker 和 manifest 注册，通过 `chrome.runtime.sendMessage` 获取登录信息，并使用发起视频标签页对应的 Cookie store（避免混用隐身/普通会话）。仅接受本扩展、B 站视频页顶层 frame 的请求，不接收页面 postMessage，不打印 Cookie 内容。

新旧分析入口共用获取逻辑；后台不可用或权限失败会在插件明确报错，不再静默转为匿名下载。未登录与后台读取失败分别处理。

**升级生效步骤**：在 Chrome 扩展管理页重新加载当前 `extension` 目录的 VisionMark（必要时重新允许 B 站网站访问），再刷新已登录的 B 站视频页。仅重启后端不能加载新的 service worker。分析时后端出现“已启用临时 cookies 进行下载”，表示请求中已收到 Cookie 文本；页面控制台“已获取登录凭据”表示检测到了 SESSDATA，但二者均不保证账号授权或站点风控一定通过。

验证：11 项插件测试通过（含 5 项后台通信/权限/会话/清单测试），扩展构建通过。测试使用浏览器 API 模拟，没有读取用户真实 Cookie；真实登录下载仍需重新加载扩展后验证。

Chrome 参考：[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)。
