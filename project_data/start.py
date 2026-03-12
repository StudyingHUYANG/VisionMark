import subprocess
import os
import sys
import time
import socket

def check_port(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', port)) == 0

def main():
    project_dir = os.path.dirname(os.path.abspath(__file__))
    server_dir = os.path.join(project_dir, "server")
    
    print("🚀 B站广告跳过插件 - 智能启动器")
    print("=" * 40)
    
    # 检查后端是否已运行
    if check_port(3000):
        print("✓ 后端服务已在运行 (端口3000)")
    else:
        print("⚙️  启动后端服务...")
        subprocess.Popen(
            ["npm", "start"],
            cwd=server_dir,
            shell=True
        )
        print("⏳ 等待服务启动...")
        time.sleep(3)
        
        if check_port(3000):
            print("✓ 后端启动成功")
        else:
            print("✗ 后端启动失败，请检查错误")
            return
    
    print()
    print("📋 接下来请手动操作：")
    print("   1. 打开 Chrome 浏览器")
    print("   2. 访问 chrome://extensions/")
    print("   3. 开启右上角'开发者模式'")
    print(f"   4. 点击'加载已解压的扩展程序'")
    print(f"   5. 选择文件夹: {project_dir}\\extension")
    print()
    print("⌨️  在B站视频页面按 Alt+A 可以标注广告")
    print("=" * 40)
    
    # 可选：自动打开Chrome
    input("按回车键打开Chrome扩展页面...")
    subprocess.run(["start", "chrome", "chrome://extensions/"], shell=True)

if __name__ == "__main__":
    main()
