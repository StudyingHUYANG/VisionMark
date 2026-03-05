@echo off
setlocal

echo ========================================================
echo       AI 视频分析环境一键安装脚本 (VisionMark)
echo ========================================================
echo.

:: 1. 检查 Node.js
echo [1/4] 检查 Node.js 环境...
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)
    pause
    exit /b 1
)
node -v
echo Node.js 已就绪。
echo.

:: 2. 检查 Python
echo [2/4] 检查 Python 环境...
where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] 未检测到 Python，请先安装 Python 3.8+ (https://www.python.org/) 并确保添加到 PATH
    pause
    exit /b 1
)
python --version
echo Python 已就绪。
echo.

:: 3. 安装 Python 依赖 (yt-dlp)
echo [3/4] 安装 Python 依赖 (yt-dlp)...
python -m pip install yt-dlp -i https://pypi.tuna.tsinghua.edu.cn/simple
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] yt-dlp 安装可能失败，请检查网络或手动安装: pip install yt-dlp
) else (
    echo yt-dlp 安装成功。
)
echo.

:: 4. 安装服务端 Node.js 依赖
echo [4/4] 安装服务端依赖...
cd server
if not exist "package.json" (
    echo [ERROR] 找不到 server/package.json，请确保脚本在项目根目录下运行。
    pause
    exit /b 1
)

call npm install --registry=https://registry.npmmirror.com
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install 失败，请检查网络连接。
    pause
    exit /b 1
)
echo 服务端依赖安装成功。

:: 5. 检查 .env 配置
if exist ".env" goto EnvExists

echo.
echo [INFO] 正在初始化配置文件...
echo.
echo ========================================================
echo                 配置 API Key
echo ========================================================
echo.
echo 请输入通义千问 API Key (必填，兼容 OpenAI 格式):
set /p QWEN_KEY=

echo.
echo [可选] 请输入阿里云 OSS Access Key ID (直接回车跳过):
set /p OSS_ID=

echo [可选] 请输入阿里云 OSS Access Key Secret (直接回车跳过):
set /p OSS_SECRET=

echo [可选] 请输入阿里云 OSS Bucket Name (直接回车跳过):
set /p OSS_BUCKET=

echo [可选] 请输入阿里云 OSS Region (默认 oss-cn-beijing):
set /p OSS_REGION=

if "%OSS_REGION%"=="" set OSS_REGION=oss-cn-beijing

echo PORT=3000> .env
echo # 通义千问 API Key>> .env
echo QWEN_API_KEY=%QWEN_KEY%>> .env
echo # 阿里云 OSS 配置>> .env
echo OSS_ACCESS_KEY_ID=%OSS_ID%>> .env
echo OSS_ACCESS_KEY_SECRET=%OSS_SECRET%>> .env
echo OSS_BUCKET=%OSS_BUCKET%>> .env
echo OSS_REGION=%OSS_REGION%>> .env

echo.
echo 配置已保存至 server\.env
goto EnvDone

:EnvExists
echo [INFO] server\.env 已存在，跳过配置。
echo 如需修改 Key，请直接编辑 server\.env 文件。

:EnvDone

echo.
echo ========================================================
echo                所有环境安装完成！
echo ========================================================
echo.
echo 您现在可以通过运行 server 目录下的 start_server.bat (需自行创建) 或 npm start 来启动服务。
echo.
pause
