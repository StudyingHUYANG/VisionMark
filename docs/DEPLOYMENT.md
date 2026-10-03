# VisionMark 部署指南（新电脑 20 分钟启动）

适用 Windows 10/11 + Chrome。下文命令除特别说明外，**都在仓库根目录**（克隆后的 VisionMark 目录）或 `server\` 目录执行。

一键脚本：`scripts\一键部署.bat`（双击即可；它按本文第 2–5 节顺序执行，并在第 8 节提供 `clean` 清理模式）。

---

## 1. 前置要求

| 组件 | 版本要求 | 依据 / 校验 |
|---|---|---|
| Node.js | 20.19+ 或 22.12+（推荐 22 LTS） | 根 `package.json` 的 `vite@^7.3.1` 要求 `^20.19.0 \|\| >=22.12.0`（见根 `package-lock.json`）；`server/package.json` 的 `better-sqlite3@12` engines 为 `20.x/22.x/23.x/24.x/25.x`。校验：`node --version` |
| Python | 3.9+；启用可选 Whisper 时建议 3.10/3.11 | pip 会按解释器版本选择兼容的 numpy/Pillow。校验：`python --version` |
| Chrome | 支持 Manifest V3 | 加载 `extension/manifest.json` |
| 磁盘 | 约 1 GB（不含 Whisper） | `server/node_modules` 数百 MB；仓库已自带 `scripts\ffmpeg` 二进制约 300 MB，无需另外下载 |

Python 命令请确保在 PATH 中（安装 Python 时勾选 "Add python.exe to PATH"）；服务端调用的是 `python3` 或 `python`（`server/services/visualCutDetector.js:133-139`），ASR 默认用 `python`（`server/services/asr/index.js:39`）。

## 2. 安装依赖

### 2.1 根目录：扩展构建工具（Vite / Vue）

```bat
npm install
```

可选：改过扩展源码后重新构建，产物 `extension/dist` 被 `extension/manifest.json` 直接引用（仓库已提交一份）：

```bat
npm run build
```

### 2.2 server\：后端依赖

```bat
cd server
npm install
```

会安装 `@ffmpeg-installer/ffmpeg`（`server/package.json`），它是服务端实际使用的 ffmpeg：`require('@ffmpeg-installer/ffmpeg').path`（`server/services/videoAnalyzer.js:4`、`bilibiliDownloader.js:17`），实际文件在 `server\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe`。

### 2.3 Python 必需依赖（约 1 分钟）

```bat
cd <仓库根>
python -m pip install -r requirements.txt
```

- `yt-dlp`：`server/services/videoAnalyzer.js:414` 通过 `python -m yt_dlp` 调用（B 站下载回退链路）。
- `numpy` + `Pillow`：`server/services/visual_cut_metrics.py:7-8` 用于视觉切点指标计算。

校验：

```bat
python -c "import yt_dlp, numpy, PIL; print('ok')"
```

缺失影响：视觉切点检测会打印「Python视觉候选切点检测失败，尝试 ffmpeg scene fallback」并降级（`server/services/videoAnalyzer.js:1852`）；yt-dlp 回退链路直接不可用。

### 2.4 可选：本地 Whisper 语音识别（默认不装）

```bat
python -m pip install openai-whisper
```

- 谁在用：`scripts/whisper_transcribe.py`（`import whisper`），由 `server/services/asr/whisperFallback.js` 调用。
- 什么时候才需要：仅当 DashScope ASR 不可用（例如未配置 OSS / Key）时的兜底（`server/services/asr/index.js`）。
- 代价（会与「20 分钟启动」冲突，故默认不装）：`openai-whisper` 会连带安装 `torch`，Windows 上通常数 GB（CPU 版数百 MB 起，CUDA 版 2–3 GB+）；首次转写还要下载模型权重（base ≈150 MB，small ≈470 MB，large ≈3 GB）。
- Whisper 内部直接调用 `ffmpeg` 命令行：把项目自带的 `scripts\ffmpeg` 加入 PATH 即可（`scripts\一键部署.bat` 会自动加）。

不装的后果：DashScope 失败时日志出现「Whisper 不可用（未安装 openai-whisper 或 Python 不可用）」，转写为空，但不影响服务启动及其它链路。

## 3. 环境变量（server\.env）

```bat
copy server\.env.example server\.env
```

`.env` 已被 `.gitignore` 忽略（`.gitignore:15`），**不要提交真实密钥**。逐项说明（变量名均可在 `server/.env.example` 与代码中找到）：

| 变量 | 用途 | 不配置的后果 |
|---|---|---|
| `PORT` | 服务端口，取值 1–65535，默认 8080；非法值告警后回退 8080（`server/config.js:26-53,73`，`server/server.js:569`） | 使用 8080。空值等同未配置 |
| `NODE_ENV` | 模板保留字段 | 当前代码中没有 `process.env.NODE_ENV` 读取点，配置与否无行为差异 |
| `QWEN_API_KEY` | 文本 / 视觉 / ASR(paraformer-v2) 模型调用的 DashScope Key（`server/services/modelConfigService.js:5`） | 回退到代码内置的默认 Key（不建议依赖，可能失效）；也可登录后在页面里配置用户级 Key（`user_api_configs` 表，`modelConfigService.js:55-77`） |
| `DASHSCOPE_API_KEY` | 语义搜索与帧向量提取（`server/services/embeddingService.js:12,27`） | 跳过帧向量提取，日志提示「未配置环境变量 DASHSCOPE_API_KEY，跳过语义搜索功能」（`videoAnalyzer.js:1708-1711`）；语义搜索接口不可用 |
| `OSS_REGION` | 阿里云 OSS 区域，默认 `oss-cn-beijing`（`server/utils/oss.js:12`） | 见下方「不配 OSS」说明 |
| `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | OSS 上传配置，三者同时存在才会创建 OSS 客户端（`server/utils/oss.js:3-16`） | 见下方「不配 OSS」说明 |
| `JWT_SECRET` | 登录 / WebSocket token 校验（`server/config.js:82`） | 使用内置默认密钥并打印醒目告警（`config.js:64-69`）；生产必须更换 |

**不配 OSS 会怎样**：DashScope 在线 ASR 需要先把音频上传到 OSS，未配置时该路径直接不可用——报「OSS 未配置，无法上传音频文件」（`server/services/asr/transcribeAudio.js:196-198`），随后降级本地 Whisper（需按 2.4 安装）。**本地音频抽取与音频切点仍然工作**；视频下载、视觉切点、关键词切点等链路不受影响。

## 4. 启动（必须从 server\ 目录）

```bat
cd server
node server.js
```

**为什么必须 `cd server`**：`server/server.js:2` 的 `require('dotenv').config()` 按**当前工作目录**查找 `.env`。从仓库根执行 `node server/server.js` 不会加载任何环境变量（PORT/JWT/OSS/QWEN 全部缺失），表现为端口始终 8080、打印 JWT 默认密钥告警、OSS 未配置等。`server/package.json` 的 `npm start` 等价于 `node server.js`，同样要在 `server\` 下执行。

- 默认地址：<http://localhost:8080>（改端口见第 3 节 `PORT`）
- 健康检查：<http://localhost:8080/api/v1/health> → `{"ok":true}`（路由定义在 `server/server.js:328`）
- 启动日志会打印 `[Server] http://localhost:<PORT>` 与测试账号 `admin/admin`（`server/server.js:569-572`）
- 停止：Ctrl+C

## 5. 启动后自检

| 检查项 | 命令 | 期望 |
|---|---|---|
| 端口监听 | `netstat -ano \| findstr :8080` | 出现 `LISTENING` |
| 健康检查 | 浏览器打开 `http://localhost:8080/api/v1/health` | `{"ok":true}` |
| Node 侧 ffmpeg | `cd server` 后 `node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"` | 输出 `server\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe` |
| ffprobe | `scripts\ffmpeg\ffprobe.exe -version` | 打印版本号 |
| Python 必需依赖 | `python -c "import yt_dlp, numpy, PIL; print('ok')"` | `ok` |
| 可选 Whisper | `python -c "import whisper; print(whisper.__version__)"` | 未安装时 ImportError，属预期 |

ffprobe 的解析顺序：`@ffmpeg-installer` 同目录的 `ffprobe.exe`（随包不存在则跳过）→ 仓库 `scripts/ffmpeg/ffprobe.exe` → PATH（`server/services/videoAnalyzer.js:63-71`、`server/services/bilibiliDownloader.js:612-621`）。

缓存目录（分析一次视频后出现）：

- `downloads\`（仓库根）：视频、音频、抽帧等缓存（`server/services/videoAnalyzer.js:210`）
- `downloads\temp\`：临时 cookies（正常用完即删）
- `server\debug\segment-pipeline\`：分段流水线 debug 产物（`server/services/segmentPipeline/debugArtifactWriter.js:4`，每次分析写一份，不自动清理）

## 6. 加载 Chrome 扩展

1. Chrome 打开 `chrome://extensions`，开启「开发者模式」；
2. 点「加载已解压的扩展程序」，选择仓库的 `extension` 目录（`extension/manifest.json` 所在处）；
3. 打开任意 B 站视频页（`https://www.bilibili.com/video/...`），扩展按 `manifest.json` 的 content_scripts 自动注入。

**改端口注意**：`extension/manifest.json` 的 `host_permissions` 只包含 `http://localhost:8080/*`、`http://127.0.0.1:8080/*`、`http://localhost:3000/*`、`http://127.0.0.1:3000/*`。若把 `PORT` 改成其它值，需要同步修改 `extension/manifest.json` 并在 `chrome://extensions` 重新加载扩展。

## 7. 常见故障

下载失败的对外文案由 `server/services/bilibiliDownloader.js` 统一生成（`ERROR_CODES` / `ERROR_REASONS` / `DEFAULT_MESSAGES` / `buildUserFacingMessage`）。常见几类：

| 现象（日志/接口消息） | 含义与处理 |
|---|---|
| `B 站触发风控（412），Cookie 与匿名下载均失败，请稍后重试或更换网络/IP`（`RISK_CONTROL_412`） | 触发 B 站风控。稍后重试、更换网络/IP；扩展会带上浏览器 Cookie，可尝试重新登录 B 站 |
| `视频已删除、私密、审核中或当前账号无权限访问`（`VIDEO_INACCESSIBLE`） | 视频不可访问，换视频；重试无意义（致命错误，不重试） |
| `视频地址或 BV 号不合法`（`INVALID_INPUT`） | 检查输入 URL/BV 号 |
| `视频下载失败（<reason>）。失败阶段：<stage>；已尝试：<strategy(cookie)→...>`（`DOWNLOAD_FAILED`） | 具体 `reason` 见 `ERROR_REASONS`，例如 `HTTP_412`、`WBI_RISK_CONTROL`、`COOKIE_INVALID_OR_EXPIRED`、`NO_PLAYABLE_STREAM`、`STREAM_INTERRUPTED`、`SIZE_MISMATCH`、`FILE_EMPTY`、`NO_VIDEO_STREAM`、`FFMPEG_FAILED`、`NETWORK_ERROR`。按 reason/stage 定位：`yt_dlp` 阶段多为风控/Cookie，`download`/`merge` 阶段多为网络或磁盘问题 |
| `❌ 端口 X 已被占用`（一键脚本）或启动即退出 | `netstat -ano \| findstr :X` 找 PID，`taskkill /F /PID <PID>`；或改 `server\.env` 的 `PORT`（注意第 6 节的 manifest 限制） |
| 视觉切点日志出现「Python视觉候选切点检测失败，尝试 ffmpeg scene fallback」 | 缺 numpy/Pillow 或 python 不可用，按 2.3 安装 |
| 转写日志「Whisper 不可用（未安装 openai-whisper 或 Python 不可用）」且 DashScope 失败 | 未装 Whisper（2.4），或 OSS 未配置导致 DashScope 不可用（第 3 节） |
| 从仓库根 `node server/server.js` 启动后配置全部不生效 | 必须 `cd server` 再 `node server.js`（第 4 节） |
| 日志提示 ffprobe 探测失败/跳过 | `scripts\ffmpeg\ffprobe.exe` 缺失且 PATH 无 ffprobe，视频流校验降级为「仅体积校验」 |

## 8. 缓存清理

- 显式清理入口：`scripts\一键部署.bat clean`（**不会**默认执行，也不会删除 `downloads\*.mp4` 视频本体）。它删除 debug 产物、临时 cookies、下载中间残留，并对每个已缓存 bvid 调用现有 `VideoAnalyzer.cleanup(bvid, { keepVideo: true })` 清理音频与抽帧缓存。
- 手动命令（仓库没有批量清理 API，逐 bvid 的 `cleanup()` 是唯一现成能力）：

```bat
cd server
REM 保视频、清其它缓存
node -e "new (require('./services/videoAnalyzer'))().cleanup('BV1GJ411x7h7', { keepVideo: true })"
REM 不保视频、全清该 bvid
node -e "new (require('./services/videoAnalyzer'))().cleanup('BV1GJ411x7h7')"
REM debug 产物目录可整目录删除，后续分析会按需重建
rmdir /s /q server\debug\segment-pipeline
```

清理行为与产物清单详见 `docs/DATA_LIFECYCLE.md`。
