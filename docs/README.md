# Bilibili Ad Skipper - 开发环境

## 项目结构
ChromeExtention/
├── setup.py          # 环境安装脚本（已运行）
├── start.bat         # Windows一键启动
├── start.py          # Python智能启动器
├── extension/        # 浏览器插件代码
│   ├── manifest.json
│   └── content/      # 核心JS文件
└── server/           # 后端服务
├── server.js     # Express服务
└── database/     # SQLite数据库文件
复制

## 使用步骤

### 第一次安装（已完成）
运行了 `setup.py`，已自动完成：
- ✅ 创建所有代码文件
- ✅ 安装Node依赖
- ✅ 初始化SQLite数据库

### 日常开发启动
双击运行 `start.bat` 或 `start.py`，然后：
1. 在Chrome中加载 `extension` 文件夹
2. 打开任意B站视频（如 https://www.bilibili.com/video/BV1GJ411x7h7）
3. 按 **Alt+A** 测试标注功能

## 切换到PostgreSQL（可选）
如果你需要完整的PostgreSQL支持：
1. 安装PostgreSQL并创建数据库
2. 修改 `server/.env` 文件，取消 `DATABASE_URL` 注释
3. 修改 `server/server.js`，将 `better-sqlite3` 替换为 `pg`
4. 重新运行 `npm install pg`

## 技术栈
- 前端：Chrome Extension Manifest V3
- 后端：Node.js + Express
- 数据库：SQLite3（零配置）/ PostgreSQL（生产环境）
