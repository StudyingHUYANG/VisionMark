@echo off
echo ========================================
echo VisionMark Chrome扩展重新加载工具
echo ========================================
echo.
echo 步骤1: 打开Chrome扩展管理页面
echo 正在打开: chrome://extensions/
start chrome://extensions/
echo.
echo 步骤2: 找到 "VisionMark" 扩展
echo 步骤3: 点击扩展卡片右上角的"重新加载"按钮
echo 步骤4: 刷新bilibili视频页面
echo.
echo 等待您完成上述步骤后，按任意键继续测试...
pause >nul

echo.
echo ========================================
echo 开始测试扩展功能
echo ========================================
echo.

echo 步骤5: 测试API连接
curl -s http://localhost:3000/api/v1/health | findstr "ok" >nul
if %errorlevel%==0 (
    echo ✅ 后端API连接正常
) else (
    echo ❌ 后端API连接失败
)

echo.
echo 步骤6: 打开测试页面
echo 正在打开: https://www.bilibili.com/video/BV1xx411c7mD
start https://www.bilibili.com/video/BV1xx411c7mD

echo.
echo ========================================
echo 测试完成！
echo ========================================
echo.
echo 如果扩展仍不工作，请：
echo 1. 检查Chrome控制台是否有错误信息
echo 2. 确认扩展已启用且权限正确
echo 3. 尝试刷新页面或重启Chrome
echo.
pause