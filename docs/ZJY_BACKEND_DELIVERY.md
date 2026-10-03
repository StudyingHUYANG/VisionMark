# 朱家佑第一周、第二周后端交付记录

日期：2026-09-26。来源：TEAM_ASSIGNMENT_5.md 中朱家佑的六项任务。代码已落到当前工作区，未创建 Git 提交或发布。

## 逐项交付

| 任务 | 完成内容 | 主要实现 |
| --- | --- | --- |
| W1-ZJY-01 服务启动、健康、登录和模型错误 | 固定环境文件与数据库路径；端口/密钥配置校验；真实数据库健康检查；统一 JWT；模型 Key 缺失、URL/布尔参数与连接失败诊断；端口占用正常报错 | server/server.js、config.js、middlewares/auth.js、routes/modelConfig.js |
| W1-ZJY-02 分析任务、持久化、去重和恢复 | 单项/批量共用执行路径；任务、阶段和结果落库；运行中相同请求合并；共享视频及索引写入互斥；进度可查询；结果事务保存 | services/analysisService.js、taskStore.js、routes/videoAnalysis.js、database/db.js |
| W1-ZJY-03 WebSocket 和错误结构 | JWT + 用户 + BV 三重隔离；订阅重放；心跳、到期处理；移除分析器全连接广播；统一非检索接口错误及 requestId | websocket.js、middlewares/errors.js、server.js、extension/content/main.js |
| W2-ZJY-01 数据初始化、迁移、重启恢复 | schema_migrations 版本化事务迁移；保留原有表数据；完成结果跨进程读取；中断任务明确 failed/SERVER_RESTARTED，可重试 | database/db.js、services/taskStore.js、routes/segments.js |
| W2-ZJY-02 技术观测 | 当前用户的任务状态、阶段耗时、总耗时、模型调用、搜索请求延迟和失败分类；SQLite 持久化；按小时聚合请求统计 | routes/stats.js、services/telemetry.js、database/db.js |
| W2-ZJY-03 鉴权、校验、错误码和脱敏 | 非检索业务统一 Bearer；片段时间/分页/BV/模型参数校验；修正删除权限和统计所用表；结构化错误；密钥/Cookie/密码/上游异常脱敏 | middlewares/*、routes/*、utils/safeLogger.js |

补充文件：`docs/BACKEND_API.md` 提供启动、鉴权、任务、WebSocket、统计、迁移及兼容说明；`server/.env.backend.example` 提供无密钥配置示例。

## 必要配套改动

1. `extension/content/main.js`：连接携带 BV；消息校验 BV 和终态；旧连接关闭不能覆盖新连接；不打印带 token 的 URL。未重做前端页面。
2. `server/services/videoAnalyzer.js`：移除广播；通过统一客户端包装采集模型调用；ASR 提交计数；设置模型调用超时。未改动检索排序或视频分段算法。
3. 根与 server 的 package.json：接通后端回归测试；根 `npm test` 原先为直接退出失败的占位脚本。
4. `extension/dist/main.js`：由 `npm run build` 自动生成，未手工编辑。
5. 保留用户原先的 docs/README.md 修改，以及已有未跟踪文档、数据库索引、缓存和调试文件。

## 自测证据

环境：Windows、Node.js v24.14.0、现有 npm 依赖。

| 检查 | 结果 |
| --- | --- |
| 新增后端集成测试 | 12 项，覆盖真实 HTTP/WebSocket、独立进程重启和本地模拟模型端点 |
| npm test | 插件 6 项 + 服务端 33 项，共 39 项通过 |
| npm run build | Vite 45 个模块构建通过，生成扩展资源 |
| JavaScript 语法与 git diff --check | 通过；Git 提示的 Windows 换行转换不是代码错误 |

后端测试具体覆盖：

- 新库健康检查、重复迁移、鉴权、无效 token、JSON/BV 错误格式。
- 无模型 Key 提前失败；配置 URL 校验；API 不泄露 Key；默认 Key 不发送到非默认地址。
- 重复请求只执行一次；跨用户冲突；任务 ID 不可越权查询；进度隔离。
- 分析结果事务持久化；批量结果落库；旧片段和 video-view 响应兼容。
- 片段时间校验、创建者删除权限、统计查询 annotations、分页校验。
- 分析失败分类、真实搜索路由请求计时、模型指标、日志脱敏。
- WebSocket 无认证拒绝、不同用户/视频不串线、无订阅连接不接收进度。
- 旧库数据保留、重复升级幂等、失败版本回滚。
- 本地 HTTP 模型成功与 401 错误、上游内容隐藏、模型调用统计。
- 索引构建期间拒绝重复任务；中断恢复后可以重试。
- 新 Node 进程读取完成结果、把 running 标记为中断。
- 端口被占用时输出 PORT_IN_USE，且失败启动不改写在运行任务；非法端口定位；开发 JWT 密钥跨进程保持一致。

新增测试使用独立临时数据库，未修改正式 app.db。分析器使用固定测试输出，模型连接测试使用本地 HTTP 服务，不消耗真实模型配额。现有音频测试使用本机已有音频；Whisper 不可用，验证到了 ASR 降级，不能据此声称真实 ASR 已验收。

## 联调边界与未做的团队验收

- 本次完成朱家佑六项后端实现与自测；5 个真实视频、10 个固定查询、Top-3 命中率、浏览器完整视频流程和干净电脑 20 分钟部署仍需按其他成员分工联调验收，本记录不冒充这些结果。
- 任务/个人配置/实时进度/技术统计按用户隔离；现有视频分析和检索结果保留共享资料库语义，不是私有视频多租户改造。
- 中断任务恢复为明确失败并允许手动重试，不从下载或模型调用中间继续执行；相同数据库仅运行一个后端服务进程。
- 模型统计覆盖分析 Chat Completions、ASR 提交和配置测试；独立 embedding/rerank 统计尚需检索模块扩展。请求统计没有 P95，当前提供次数、平均值和最大值。
- 升级后若以前使用硬编码 JWT 密钥，需要重新登录。新库不自动生成 admin/admin，已有账号保留。
- Cookie 生命周期、临时视频/帧清理、真实 ASR 安装、检索指标和团队发布包沿用对应负责人的工作范围。

## 本地使用

```powershell
npm --prefix server start
```

访问 `/api/v1/health` 验证启动。用原账号登录（新库先注册），在插件中保存有效模型配置，再分析视频。查询技术统计：`GET /api/v1/stats/technical?hours=24`，携带登录 token。完整接口示例和字段以 `docs/BACKEND_API.md` 为准。


## 对话后续修复汇总（2026-10-02）

- 兼容开发环境原有短 JWT_SECRET：回退到持久化随机密钥，生产环境保留强校验。
- 下载错误识别 HTTP 412 等分类，返回可操作信息和 taskId，不暴露原始凭据。
- 首选下载器使用合法且未过期的 B 站 Cookie；媒体请求不携带账号 Cookie。瞬断有限重试、访问限制停止重试、下载超时及 `.part` 完整落盘处理。
- yt-dlp 优先使用项目 Python 环境，可通过 VISIONMARK_PYTHON 显式指定；移除跳过证书校验及风控后的参数切换。
- 修复 content script 不能直接使用 chrome.cookies 的架构错误：新增 extension/background.js，以受限消息通道读取当前标签页 Cookie store，新增 manifest 后台注册。
- 新旧分析入口统一 Cookie 获取；后台不可用/权限错误明确报错，不静默匿名下载。
- 修复片段请求缺少 Authorization；搜索在未登录或 401 后停止轮询，登录后恢复；退出与卸载清理监听，未登录不下载素材预览。
- 新增 Cookie 通信、请求鉴权、JWT 兼容和下载异常测试，更新扩展构建产物与接口说明。

用户已反馈扩展后台连接问题不再出现；这不等同于已完成五视频/十查询或真实模型完整验收。

本次分支提交前复验：npm test 全部 56 项通过（插件 15 项、服务端 41 项），npm run build 通过。前文 39 项为最初交付时的历史记录。
