@echo off
echo ========================================
echo VisionMark 完整诊断脚本
echo ========================================
echo.

echo [1/6] 检查后端服务器状态...
powershell -Command "try { $response = Invoke-WebRequest -Uri 'http://localhost:3000/api/v1/health' -Method GET -UseBasicParsing -TimeoutSec 5; if ($response.StatusCode -eq 200) { Write-Host '✅ 后端服务器运行正常' -ForegroundColor Green } else { Write-Host '❌ 后端服务器响应异常' -ForegroundColor Red } } catch { Write-Host '❌ 后端服务器未运行或无响应' -ForegroundColor Red }"
echo.

echo [2/6] 检查Chrome扩展管理页面...
echo 正在打开: chrome://extensions/
start chrome://extensions/
timeout /t 2 /nobreak >nul
echo.

echo [3/6] 检查扩展文件是否正确...
if exist "extension\manifest.json" (
    echo ✅ manifest.json 存在
) else (
    echo ❌ manifest.json 不存在
)

if exist "extension\content\main.js" (
    echo ✅ main.js 存在
) else (
    echo ❌ main.js 不存在
)
echo.

echo [4/6] 验证API路径配置...
powershell -Command "try { $content = Get-Content 'extension\content\main.js' -Raw; if ($content -match 'VIDEO_ANALYSIS_BASE.*localhost:3000/api/v1') { Write-Host '✅ VIDEO_ANALYSIS_BASE 路径正确' -ForegroundColor Green } else { Write-Host '❌ VIDEO_ANALYSIS_BASE 路径错误' -ForegroundColor Red } } catch { Write-Host '❌ 无法读取main.js文件' -ForegroundColor Red }"
echo.

echo [5/6] 打开测试页面...
echo 正在打开扩展测试页面...
start test_extension.html
echo.

echo [6/6] 打开bilibili测试视频...
echo 正在打开测试视频页面...
start https://www.bilibili.com/video/BV1xx411c7mD
echo.

echo ========================================
echo 诊断完成！请按以下步骤操作：
echo ========================================
echo.
echo 步骤1: 在Chrome扩展管理页面，找到VisionMark扩展
echo 步骤2: 点击扩展右上角的"重新加载"按钮
echo 步骤3: 刷新bilibili视频页面
echo 步骤4: 查看测试页面中的扩展状态
echo 步骤5: 在bilibili页面按F12查看控制台
echo.
echo 如果仍有问题，请告诉我具体错误信息！
echo.
pause