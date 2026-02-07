@echo off
chcp 65001 >nul
echo ===================================
echo   B站广告跳过插件 - 开发环境启动器
echo ===================================
echo.

:: 检查端口占用
netstat -an | find "3000" | find "LISTENING" >nul
if %errorlevel% == 0 (
    echo [警告] 端口3000已被占用，可能已有服务在运行
    echo.
)

:: 启动后端服务
echo [1/2] 正在启动后端服务...
cd /d "%~dp0server"
start "后端服务" cmd /k "npm start"

timeout /t 3 >nul

:: 打开Chrome扩展页面
echo [2/2] 请手动加载插件：
echo     1. 访问 chrome://extensions/
echo     2. 开启"开发者模式"
echo     3. 点击"加载已解压的扩展程序"
echo     4. 选择文件夹: %~dp0extension
echo.
echo 按任意键打开Chrome扩展页面...
pause >nul

start chrome "chrome://extensions/"
