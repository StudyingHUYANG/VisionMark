@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo       VisionMark 一键部署脚本
echo ========================================
echo.

REM 检查 Node.js
echo [1/7] 检查 Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 未检测到 Node.js
    echo 请访问 https://nodejs.org/ 下载并安装 Node.js
    pause
    exit /b 1
)
echo ✅ Node.js 已安装
node --version
echo.

REM 检查 Python
echo [2/7] 检查 Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 未检测到 Python
    echo 请访问 https://www.python.org/ 下载并安装 Python
    pause
    exit /b 1
)
echo ✅ Python 已安装
python --version
echo.

REM 检查 FFmpeg
echo [3/7] 检查 FFmpeg...
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo ⚠️  未检测到 FFmpeg，将自动下载...
    powershell -Command "& {Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'ffmpeg.zip'; Expand-Archive -Path 'ffmpeg.zip' -DestinationPath '.'; Move-Item -Path 'ffmpeg-*-essentials_build\bin' -Destination 'ffmpeg' -Force; Remove-Item -Path 'ffmpeg.zip' -Recurse -Force; Remove-Item -Path 'ffmpeg-*-essentials_build' -Recurse -Force}"
    if errorlevel 1 (
        echo ❌ FFmpeg 下载失败
        echo 请手动下载 FFmpeg: https://www.gyan.dev/ffmpeg/builds/
        pause
        exit /b 1
    )
)
echo ✅ FFmpeg 已安装
echo.

REM 安装服务器依赖
echo [4/7] 安装服务器依赖...
cd /d "%~dp0server"
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
echo.

REM 安装 Python 依赖（AI分析需要）
echo [5/7] 安装 Python 依赖（AI分析所需）...
echo 检查 requirements.txt...
if exist "%~dp0requirements.txt" (
    echo 正在安装 Python 依赖包...
    echo 包含: yt-dlp, requests, oss2, numpy, Pillow
    pip install -r "%~dp0requirements.txt"
    if errorlevel 1 (
        echo ⚠️  部分依赖安装失败，尝试单独安装 yt-dlp...
        pip install yt-dlp requests
        if errorlevel 1 (
            echo ❌ Python 依赖安装失败
            pause
            exit /b 1
        )
    )
    echo ✅ Python 依赖安装完成
) else (
    echo 未找到 requirements.txt，手动安装核心依赖...
    pip install yt-dlp requests
    if errorlevel 1 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
    echo ✅ 核心依赖安装完成
)
echo.

REM 检查环境变量
echo [6/7] 检查环境变量...
if not exist .env (
    echo ❌ 缺少 .env 文件
    echo 请先配置 .env 文件（参考 .env.example）
    pause
    exit /b 1
)
echo ✅ 环境变量已配置
echo.

REM 启动服务
echo [7/7] 启动服务...
echo.
echo ========================================
echo       正在启动 VisionMark 服务
echo ========================================
echo.
echo 📡 后端服务器: http://localhost:8080
echo 🔧 扩展程序: 请加载 extension 文件夹到 Chrome
echo.
echo 按 Ctrl+C 停止服务
echo.

node server.js

pause
