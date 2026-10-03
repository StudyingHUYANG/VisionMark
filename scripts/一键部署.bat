@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ==========================================================================
REM VisionMark 一键部署脚本（位于 scripts\ 目录，仓库根目录用 %VM_ROOT% 表示）
REM
REM 用法:
REM   直接运行 / 双击          —— 检查环境、安装依赖、启动服务并做健康检查
REM   一键部署.bat clean       —— 只清理可再生缓存（不会删除视频本体 *.mp4）
REM
REM 说明:
REM   - 本脚本在 scripts\ 下，仓库根目录通过 "%~dp0.." 解析为 VM_ROOT；
REM     不要假设双击时的工作目录就是仓库根目录。
REM   - FFmpeg 不联网下载：项目自带 scripts\ffmpeg\ffmpeg.exe（本地 Whisper 用）
REM     与 scripts\ffmpeg\ffprobe.exe（视频流校验用），Node 侧用
REM     server\node_modules\@ffmpeg-installer\ffmpeg（安装 server 依赖后必然存在）。
REM   - 端口读取优先级与 server/config.js 一致：server\.env 的 PORT → 默认 8080，
REM     非法值回退 8080。
REM ==========================================================================

for %%I in ("%~dp0..") do set "VM_ROOT=%%~fI"

echo ========================================
echo       VisionMark 一键部署脚本
echo ========================================
echo.

REM 参数: clean 模式只清理缓存，不做安装/启动
if /i "%~1"=="clean" goto clean_cache

REM --------------------------------------------------------------------------
REM [1/8] 检查 Node.js
REM --------------------------------------------------------------------------
echo [1/8] 检查 Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 未检测到 Node.js
    echo 请访问 https://nodejs.org/ 下载并安装 Node.js（建议 20.19+ 或 22 LTS）
    pause
    exit /b 1
)
echo ✅ Node.js 已安装
node --version
echo.

REM --------------------------------------------------------------------------
REM [2/8] 检查 Python
REM --------------------------------------------------------------------------
echo [2/8] 检查 Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 未检测到 Python
    echo 请访问 https://www.python.org/ 下载并安装 Python（安装时勾选 Add python.exe to PATH）
    pause
    exit /b 1
)
echo ✅ Python 已安装
python --version
echo.

REM --------------------------------------------------------------------------
REM [3/8] 检查 FFmpeg / ffprobe（项目自带，不做联网下载）
REM --------------------------------------------------------------------------
echo [3/8] 检查 FFmpeg / ffprobe...
set "VM_FFMPEG_DIR=%~dp0ffmpeg"
if exist "%VM_FFMPEG_DIR%\ffmpeg.exe" (
    REM 本地 Whisper（openai-whisper）内部直接调用 ffmpeg 命令行；
    REM 把项目自带目录临时加入本次会话 PATH，子进程（node server.js）会继承
    set "PATH=%VM_FFMPEG_DIR%;%PATH%"
    echo ✅ 项目自带 ffmpeg: %VM_FFMPEG_DIR%\ffmpeg.exe
    echo    已把该目录加入本次会话 PATH（本地 Whisper 需要命令行 ffmpeg）
) else (
    where ffmpeg >nul 2>&1
    if errorlevel 1 (
        echo ⚠️  未找到 %VM_FFMPEG_DIR%\ffmpeg.exe，PATH 中也没有 ffmpeg
        echo    影响: 本地 Whisper 降级方案不可用；DashScope ASR、下载与视觉切点不受影响
    ) else (
        echo ✅ 使用 PATH 中已有的 ffmpeg（本地 Whisper 可用）
    )
)
if exist "%VM_FFMPEG_DIR%\ffprobe.exe" (
    echo ✅ 项目自带 ffprobe: %VM_FFMPEG_DIR%\ffprobe.exe
) else (
    where ffprobe >nul 2>&1
    if errorlevel 1 (
        echo ⚠️  未找到 ffprobe，下载后的视频流校验会降级为「仅体积校验」
    ) else (
        echo ✅ 使用 PATH 中已有的 ffprobe
    )
)
echo.

REM --------------------------------------------------------------------------
REM [4/8] 安装根目录依赖（扩展构建工具: Vite / Vue）
REM --------------------------------------------------------------------------
echo [4/8] 安装构建工具（Vite, Vue 等）...
cd /d "%VM_ROOT%"
if not exist node_modules (
    call npm install
    if errorlevel 1 (
        echo ❌ 构建工具安装失败
        pause
        exit /b 1
    )
) else (
    echo ✅ 构建工具已安装
)
echo.

REM --------------------------------------------------------------------------
REM [5/8] 安装服务器依赖，并校验 Node 侧 ffmpeg
REM --------------------------------------------------------------------------
echo [5/8] 安装服务器依赖...
cd /d "%VM_ROOT%\server"
if not exist node_modules (
    call npm install
    if errorlevel 1 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo ✅ 依赖已安装
)
REM 服务端代码通过 require('@ffmpeg-installer/ffmpeg').path 取 ffmpeg，必须真实可访问
node -e "const fs=require('fs');const p=require('@ffmpeg-installer/ffmpeg').path;fs.accessSync(p);console.log('✅ Node 侧 ffmpeg: '+p)"
if errorlevel 1 (
    echo ❌ @ffmpeg-installer/ffmpeg 不可用（server 依赖不完整）
    echo    处理: 删除 server\node_modules 目录后重新运行本脚本
    pause
    exit /b 1
)
echo.

REM --------------------------------------------------------------------------
REM [6/8] 安装 Python 依赖（必需 / 可选分开校验）
REM --------------------------------------------------------------------------
echo [6/8] 安装 Python 依赖...
if not exist "%VM_ROOT%\requirements.txt" (
    echo ❌ 未找到 requirements.txt，无法安装 Python 依赖
    pause
    exit /b 1
)
echo 正在安装必需依赖（yt-dlp / numpy / Pillow）...
python -m pip install -r "%VM_ROOT%\requirements.txt"
if errorlevel 1 (
    echo ⚠️  整体安装失败，尝试逐个安装必需包...
    python -m pip install yt-dlp numpy Pillow
    if errorlevel 1 (
        echo ❌ 必需 Python 依赖安装失败
        pause
        exit /b 1
    )
)

REM 必需依赖逐个 import 校验，不通过绝不打印成功
python -c "import yt_dlp, numpy, PIL" >nul 2>&1
if errorlevel 1 (
    echo ❌ 必需 Python 依赖校验失败（yt-dlp / numpy / Pillow 未全部可用）
    echo    请手动执行: python -m pip install yt-dlp numpy Pillow
    echo    影响: 视频下载回退链路与视觉切点指标计算无法工作
    pause
    exit /b 1
)
echo ✅ 必需 Python 依赖已就绪（yt-dlp / numpy / Pillow）

REM 可选依赖只提示，不阻断启动
python -c "import whisper" >nul 2>&1
if errorlevel 1 (
    echo ℹ️  可选: 未安装 openai-whisper，本地 Whisper 兜底不可用（不影响启动与其它链路）
    echo    需要时执行: python -m pip install openai-whisper
    echo    注意: 会连带安装数 GB 的 torch，首次转写还要下载模型权重
) else (
    echo ✅ 可选: openai-whisper 已安装，本地 Whisper 兜底可用
)
echo.

REM --------------------------------------------------------------------------
REM [7/8] 检查环境变量文件与端口
REM --------------------------------------------------------------------------
echo [7/8] 检查环境变量与端口...
if not exist "%VM_ROOT%\server\.env" (
    echo ❌ 缺少 server\.env
    echo    请执行: copy "%VM_ROOT%\server\.env.example" "%VM_ROOT%\server\.env"
    echo    然后按需填写 API Key / OSS 配置（不填也能启动，详见 docs\DEPLOYMENT.md）
    pause
    exit /b 1
)
echo ✅ 环境变量文件已存在: %VM_ROOT%\server\.env

REM 端口优先级与 server/config.js 的 resolvePort 一致: server\.env 的 PORT → 默认 8080
set "VM_PORT=8080"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%VM_ROOT%\server\.env") do (
    set "VM_ENV_KEY=%%A"
    set "VM_ENV_VAL=%%B"
    set "VM_ENV_KEY=!VM_ENV_KEY: =!"
    set "VM_ENV_VAL=!VM_ENV_VAL: =!"
    if /i "!VM_ENV_KEY!"=="PORT" set "VM_PORT=!VM_ENV_VAL!"
)
set "VM_PORT_VALID=1"
if not defined VM_PORT set "VM_PORT_VALID=0"
echo(!VM_PORT!|findstr /r /c:"^[0-9][0-9]*$" >nul
if errorlevel 1 set "VM_PORT_VALID=0"
if "!VM_PORT_VALID!"=="1" (
    if !VM_PORT! LSS 1 set "VM_PORT_VALID=0"
    if !VM_PORT! GTR 65535 set "VM_PORT_VALID=0"
)
if "!VM_PORT_VALID!"=="0" (
    echo ⚠️  server\.env 中的 PORT 缺失或非法，已回退到 8080（与 config.js 行为一致）
    set "VM_PORT=8080"
)
echo ✅ 使用端口: !VM_PORT!

netstat -ano -p TCP | findstr /r /c:":!VM_PORT! .*LISTENING" >nul
if not errorlevel 1 (
    echo ❌ 端口 !VM_PORT! 已被占用，服务无法启动
    echo    查看占用进程: netstat -ano ^| findstr :!VM_PORT!
    echo    结束占用进程: taskkill /F /PID ^<上面的 PID^>
    echo    或修改 server\.env 里的 PORT 后重试
    echo    注意: 改成 8080 / 3000 以外的端口时，extension\manifest.json 的 host_permissions 也要同步修改
    pause
    exit /b 1
)
echo ✅ 端口 !VM_PORT! 空闲
echo.

REM --------------------------------------------------------------------------
REM [8/8] 启动服务 + 健康检查
REM --------------------------------------------------------------------------
echo [8/8] 启动服务...
echo.
echo ========================================
echo       正在启动 VisionMark 服务
echo ========================================
echo.
cd /d "%VM_ROOT%\server"
REM 独立窗口启动，方便查看日志；cmd /k 保证启动失败时错误信息不会一闪而过
start "VisionMark 服务" cmd /k "chcp 65001 >nul & node server.js"
echo 等待服务就绪（探测 http://localhost:!VM_PORT!/api/v1/health，最长 60 秒）...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); while((Get-Date) -lt $deadline){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:!VM_PORT!/api/v1/health' -TimeoutSec 5; if($r.StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
    echo ❌ 服务启动失败，或 60 秒内未通过健康检查
    echo    请查看标题为 "VisionMark 服务" 的窗口中的报错信息（常见原因见 docs\DEPLOYMENT.md）
    pause
    exit /b 1
)
echo ✅ 服务已就绪（健康检查通过）
echo.
echo 📡 后端服务器: http://localhost:!VM_PORT!
echo 🔧 扩展程序: Chrome 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择目录:
echo    %VM_ROOT%\extension
echo    加载后打开任意 B 站视频页面即可（扩展按 manifest.json 自动注入）
echo.
echo 服务运行在独立窗口「VisionMark 服务」中，关闭该窗口即停止服务。
echo 🧹 清理缓存: 运行 "%~nx0 clean"（只清可再生缓存，不删视频本体）
echo.
pause
exit /b 0

REM ==========================================================================
REM clean 模式: 清理可再生缓存，不删除 downloads 下的视频本体（*.mp4）
REM 注意: 仓库目前没有批量清理入口，这里只做两件事——
REM   1) 删除中间残留（*.part / *.m4s / *.concat.txt / *.durl-*.mp4 / *.f*.mp4）
REM      与 debug 产物目录，这些本来就是用完即弃的；
REM   2) 逐个 bvid 调用现有 VideoAnalyzer.cleanup(bvid, { keepVideo: true })，
REM      清理音频（wav/mp3/asr.mp3）与抽帧目录（_frames / _visual_frames）。
REM ==========================================================================
:clean_cache
echo ========================================
echo       VisionMark 缓存清理（clean 模式）
echo ========================================
echo.
echo 将清理以下可再生缓存（不会删除 downloads 下的视频本体 *.mp4）:
echo   - server\debug\segment-pipeline 调试产物
echo   - downloads\temp 下残留的 cookies
echo   - downloads 下的下载中间残留（*.part / *.m4s / *.concat.txt / *.durl-*.mp4 / *.f*.mp4）
echo   - 每个已缓存 bvid 的音频与抽帧目录（经 VideoAnalyzer.cleanup，保留视频本体）
echo.
echo 开始清理...
if exist "%VM_ROOT%\server\debug\segment-pipeline" (
    rmdir /s /q "%VM_ROOT%\server\debug\segment-pipeline"
    echo ✅ 已删除 server\debug\segment-pipeline
) else (
    echo ℹ️  server\debug\segment-pipeline 不存在，跳过
)
if exist "%VM_ROOT%\downloads\temp" (
    del /q "%VM_ROOT%\downloads\temp\*_cookies.txt" >nul 2>&1
    echo ✅ 已清理 downloads\temp\*_cookies.txt
) else (
    echo ℹ️  downloads\temp 不存在，跳过
)
for %%E in (part concat.txt video.m4s audio.m4s) do (
    del /q "%VM_ROOT%\downloads\*.%%E" >nul 2>&1
)
del /q "%VM_ROOT%\downloads\*.durl-*.mp4" >nul 2>&1
del /q "%VM_ROOT%\downloads\*.f*.mp4" >nul 2>&1
echo ✅ 已清理 downloads 下的下载中间残留

cd /d "%VM_ROOT%\server"
node -e "const fs=require('fs'),path=require('path');const dir=path.resolve(process.cwd(),'..','downloads');if(fs.existsSync(dir)===false){console.log('ℹ️  downloads 目录不存在，跳过');process.exit(0);}const ids=new Set();for(const f of fs.readdirSync(dir)){const m=/^(BV[0-9A-Za-z]+)[._]/.exec(f);if(m)ids.add(m[1]);}if(ids.size===0){console.log('ℹ️  downloads 下没有可清理的 bvid 缓存');process.exit(0);}const VideoAnalyzer=require('./services/videoAnalyzer');const analyzer=new VideoAnalyzer();let removed=0,failed=0;for(const id of ids){const r=analyzer.cleanup(id,{keepVideo:true});removed+=r.removed.length;failed+=r.failed.length;}console.log('✅ 已清理 '+ids.size+' 个 bvid 的缓存: 删除 '+removed+' 项, 失败 '+failed+' 项（视频本体已保留）');"
if errorlevel 1 (
    echo ⚠️  Node 清理步骤失败（可能是 server\node_modules 不完整）
    echo    可手动对单个视频执行（把 BV1GJ411x7h7 换成你的 BV 号）:
    echo    cd server ^&^& node -e "new (require('./services/videoAnalyzer'))().cleanup('BV1GJ411x7h7', { keepVideo: true })"
)
echo.
echo ℹ️  如需连视频本体一起删除（把 BV1GJ411x7h7 换成你的 BV 号）:
echo    cd server ^&^& node -e "new (require('./services/videoAnalyzer'))().cleanup('BV1GJ411x7h7')"
echo    说明: 仓库没有批量清理入口，逐 bvid 的 cleanup() 是目前唯一的清理能力。
echo.
pause
exit /b 0
