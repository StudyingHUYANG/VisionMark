# step2_package_for_roommate.py - 打包给舍友
import os
import shutil
import zipfile

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
my_ip = "10.129.79.124"  # 你的IP

# 1. 确认配置正确
constants_path = os.path.join(base, "extension", "content", "constants.js")
with open(constants_path, 'r', encoding='utf-8') as f:
    content = f.read()
    if my_ip not in content:
        print("❌ 错误：constants.js里的IP不对")
        exit()
    else:
        print(f"✅ 确认：API地址已设置为 {my_ip}")

# 2. 清理开发文件（生成干净版本）
clean_dir = os.path.join(base, "FOR_ROOMMATE")
if os.path.exists(clean_dir):
    shutil.rmtree(clean_dir)

# 复制extension文件夹
shutil.copytree(os.path.join(base, "extension"), clean_dir)

# 删除开发文件
dev_files = ['fix_', 'setup.py', 'README', '.git', '__pycache__', '*.md']
for root, dirs, files in os.walk(clean_dir):
    for f in files:
        if any(f.startswith(x) or f.endswith(x) for x in ['.py', '.md', '.txt']):
            try:
                os.remove(os.path.join(root, f))
            except:
                pass

# 3. 创建安装指南（给舍友看）
guide = f'''B站视频分段评价插件 - 安装指南
========================================

你的室友IP地址：{my_ip}
（如果这个IP变了，需要重新配置）

【第一步：安装插件】
1. 解压这个文件夹（FOR_ROOMMATE）
2. 打开 Chrome 浏览器
3. 地址栏输入：chrome://extensions/ 并按回车
4. 右上角开启"开发者模式"（Developer mode）
5. 点击"加载已解压的扩展程序"（Load unpacked）
6. 选择解压后的 FOR_ROOMMATE 文件夹
7. 看到粉色图标出现在工具栏 = 安装成功

【第二步：验证连接】
1. 确保你和室友连同一个WiFi
2. 点击插件图标（粉色圆圈）
3. 输入账号：admin
   输入密码：admin
4. 点击"登录"
5. 应该看到：
   - 用户名：admin
   - 等级：PLATINUM
   - 积分：999
   （如果显示连接错误，说明室友的防火墙或IP不对）

【第三步：使用插件】
1. 打开任意B站视频（如 bilibili.com）
2. 在播放器下方会看到四个按钮：
   ⛳ 开始  |  🏁 结束  |  [类型▼]  |  ☁️ 提交
3. 使用方法：
   - 播放到广告开始处 → 点击"⛳开始"
   - 播放到广告结束处 → 点击"🏁结束"
   - 选择类型（商业内容/推广内容/植入/片头/中段）
   - 点击"☁️提交" → 提示"提交成功"
4. 刷新页面，再次播放该视频，到标记时间会**自动跳过**

【第四步：共享测试】
- 室友可以标注广告，你也能看到并跳过
- 你们共享同一个数据库（在你室友电脑上）

【注意事项】
⚠️ 室友的电脑必须一直开机且连WiFi
⚠️ 如果室友IP变了（重启路由器），需要重新配置
⚠️ 不要修改 FOR_ROOMMATE/extension/content/constants.js 文件
   （除非IP变了，才需要把里面的IP改成新的）

【故障排除】
如果登录显示"网络错误"：
1. 检查你和室友是否连同一个WiFi
2. 在浏览器访问：http://{my_ip}:3000/api/v1/health
   应该显示 {{"ok":true}}
   如果不显示，检查室友电脑的防火墙
3. 检查constants.js里的IP是否是当前室友的IP

祝使用愉快！有问题让室友重启后端（node server.js）
'''

with open(os.path.join(base, "舍友安装说明.txt"), 'w', encoding='utf-8') as f:
    f.write(guide)

# 4. 打包成zip
zip_path = os.path.join(base, "BiliAdSkipper_舍友版.zip")
if os.path.exists(zip_path):
    os.remove(zip_path)

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk(clean_dir):
        for file in files:
            file_path = os.path.join(root, file)
            arcname = os.path.relpath(file_path, clean_dir)
            zipf.write(file_path, arcname)

print(f"\n" + "="*50)
print("🎉 打包完成！")
print("="*50)
print(f"\n📦 发送给舍友的文件：")
print(f"   1. {zip_path}")
print(f"   2. 舍友安装说明.txt")
print(f"\n📮 发送方式：")
print(f"   - 微信/QQ/飞书直接发zip文件")
print(f"   - 或者复制FOR_ROOMMATE文件夹到U盘")
print(f"\n⚠️  重要提醒：")
print(f"   你的电脑必须：")
print(f"   1. 运行 node server.js（保持黑窗口开着）")
print(f"   2. 连接同一个WiFi")
print(f"   3. IP地址 {my_ip} 不能变（变了要重新打包）")
print(f"\n🧪 下一步：让舍友按说明安装，然后测试")
input("\n按回车退出...")