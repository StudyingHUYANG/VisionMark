@echo off
echo ========================================
echo VisionMark Diagnosis Script
echo ========================================
echo.

echo [1/4] Checking backend server...
powershell -Command "try { $response = Invoke-WebRequest -Uri 'http://localhost:3000/api/v1/health' -Method GET -UseBasicParsing -TimeoutSec 5; if ($response.StatusCode -eq 200) { Write-Host 'OK: Backend server is running' -ForegroundColor Green } else { Write-Host 'ERROR: Backend server responded abnormally' -ForegroundColor Red } } catch { Write-Host 'ERROR: Backend server not running or not responding' -ForegroundColor Red }"
echo.

echo [2/4] Opening Chrome extensions page...
echo Please manually open Chrome and go to: chrome://extensions/
echo Or run this command in Chrome address bar: chrome://extensions/
echo.

echo [3/4] Opening test page...
echo Please manually open this file in Chrome: %CD%\test_extension.html
echo Or copy this path to Chrome: file:///%CD%/test_extension.html
echo.

echo [4/4] Opening test video...
echo Please manually open this URL in Chrome: https://www.bilibili.com/video/BV1xx411c7mD
echo.

echo ========================================
echo MANUAL STEPS REQUIRED:
echo ========================================
echo.
echo 1. Open Chrome browser manually
echo 2. Go to chrome://extensions/ in Chrome
echo 3. Find VisionMark extension and click 'Reload'
echo 4. Open test_extension.html in Chrome
echo 5. Open https://www.bilibili.com/video/BV1xx411c7mD in Chrome
echo 6. Press F12 on bilibili page to check console
echo.
echo If you still have problems, tell me the specific error messages!
echo.
pause