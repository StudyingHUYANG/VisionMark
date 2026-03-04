import os
import sys
import subprocess
import urllib.request
import zipfile
import shutil
from pathlib import Path

# ========== 配置区域 ==========
PROJECT_DIR = Path(__file__).parent / "project_data"
# ==============================

class Colors:
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    END = '\033[0m'

def print_color(text, color=Colors.BLUE):
    print(f"{color}{text}{Colors.END}")

def check_node():
    """检查Node.js是否安装"""
    try:
        result = subprocess.run(["node", "-v"], capture_output=True, text=True, shell=True)
        if result.returncode == 0:
            print_color(f"✓ Node.js 已安装: {result.stdout.strip()}", Colors.GREEN)
            return True
    except:
        pass
    return False

def install_node():
    """自动下载安装Node.js（Windows静默安装）"""
    print_color("正在下载 Node.js LTS...", Colors.YELLOW)
    # 使用淘宝镜像加速下载
    node_url = "https://npmmirror.com/mirrors/node/v20.11.0/node-v20.11.0-x64.msi"
    msi_path = PROJECT_DIR / "node_installer.msi"
    
    try:
        urllib.request.urlretrieve(node_url, msi_path)
        print_color("下载完成，正在静默安装（可能需要几秒钟）...", Colors.YELLOW)
        # 静默安装
        subprocess.run(["msiexec", "/i", str(msi_path), "/qn", "/norestart"], check=True)
        print_color("✓ Node.js 安装完成", Colors.GREEN)
        os.remove(msi_path)
        # 刷新环境变量
        subprocess.run(["setx", "PATH", os.environ["PATH"]], shell=True)
        return True
    except Exception as e:
        print_color(f"自动安装失败: {e}", Colors.RED)
        print_color("请手动访问 nodejs.org 下载安装LTS版，然后重新运行此脚本", Colors.RED)
        return False

def create_directory_structure():
    """创建项目目录结构"""
    print_color("创建项目目录结构...", Colors.BLUE)
    
    dirs = [
        "extension/content",
        "extension/popup", 
        "extension/icons",
        "server/routes",
        "server/services",
        "server/database",
        "docs"
    ]
    
    for dir_path in dirs:
        (PROJECT_DIR / dir_path).mkdir(parents=True, exist_ok=True)
    
    print_color("✓ 目录创建完成", Colors.GREEN)

def write_file(path, content):
    """写入文件"""
    full_path = PROJECT_DIR / path
    with open(full_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  生成: {path}")

def generate_extension_files():
    """生成浏览器插件文件"""
    print_color("生成浏览器插件代码...", Colors.BLUE)
    
    # manifest.json
    manifest = '''{
  "manifest_version": 3,
  "name": "B站广告跳过 - 众测版",
  "version": "1.0.0",
  "description": "社区驱动的B站广告自动跳过插件",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["https://www.bilibili.com/*", "http://localhost:8080/*"],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["https://www.bilibili.com/video/*"],
      "exclude_matches": ["https://live.bilibili.com/*"],
      "js": ["content/constants.js", "content/player.js", "content/annotator.js", "content/main.js"],
      "run_at": "document_idle"
    }
  ]
}'''
    write_file("extension/manifest.json", manifest)
    
    # constants.js
    constants = '''// 配置文件 - 本地开发环境
const API_BASE = 'http://localhost:8080/api/v1';
const CONFIG = {
  CHECK_INTERVAL: 200,
  CONFIDENCE_THRESHOLD: 0.7,
  MIN_VOTES: 3,
  SELECTORS: {
    video: ['bpx-player-video-wrap video', '#bilibiliPlayer video', '.bilibili-player-video video'],
    title: 'h1.video-title'
  },
  WILSON_Z: 1.96
};

const AD_TYPES = {
  HARD_AD: 'hard_ad',
  SOFT_AD: 'soft_ad',
  PRODUCT_PLACEMENT: 'product_placement',
  INTRO_AD: 'intro_ad',
  MID_AD: 'mid_ad'
};

const STORAGE_KEYS = {
  SEGMENTS_CACHE: 'ad_segments_cache',
  USER_TOKEN: 'user_token'
};
'''
    write_file("extension/content/constants.js", constants)
    
    # player.js
    player = '''class BilibiliPlayerController {
  constructor() {
    this.video = null;
    this.currentBvid = null;
    this.currentCid = null;
    this.onTimeUpdate = null;
    this.onCidChange = null;
  }

  async init() {
    return new Promise((resolve) => {
      this.tryFindVideo(resolve);
    });
  }

  tryFindVideo(callback, attempts = 0) {
    for (let selector of CONFIG.SELECTORS.video) {
      this.video = document.querySelector(selector);
      if (this.video) break;
    }

    if (this.video) {
      console.log('[AdSkipper] 找到视频元素');
      this.extractVideoId();
      this.setupListeners();
      callback(true);
    } else if (attempts < 20) {
      setTimeout(() => this.tryFindVideo(callback, attempts + 1), 500);
    } else {
      console.error('[AdSkipper] 未找到视频');
      callback(false);
    }
  }

  extractVideoId() {
    const bvidMatch = window.location.pathname.match(/BV\\w+/);
    this.currentBvid = bvidMatch ? bvidMatch[0] : null;
    
    try {
      if (window.__INITIAL_STATE__?.videoData?.cid) {
        this.currentCid = window.__INITIAL_STATE__.videoData.cid;
      } else {
        // 从弹幕接口推断
        const scripts = document.querySelectorAll('script');
        for (let s of scripts) {
          const m = s.textContent.match(/"cid":(\\d+)/);
          if (m) { this.currentCid = parseInt(m[1]); break; }
        }
      }
      
      if (this.currentCid && this.onCidChange) {
        this.onCidChange(this.currentBvid, this.currentCid);
      }
    } catch(e) {}
  }

  setupListeners() {
    if (!this.video) return;
    
    setInterval(() => {
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.video.currentTime);
      }
    }, CONFIG.CHECK_INTERVAL);

    // 监听URL变化(B站是单页应用)
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => this.extractVideoId(), 1000);
      }
    }).observe(document, {subtree: true, childList: true});
  }

  skipTo(time) {
    if (!this.video) return false;
    try {
      this.video.currentTime = time;
      return true;
    } catch(e) { return false; }
  }

  getState() {
    return {
      currentTime: this.video?.currentTime,
      bvid: this.currentBvid,
      cid: this.currentCid
    };
  }
}
'''
    write_file("extension/content/player.js", player)
    
    # main.js (核心逻辑，完整版)
    main = '''(function() {
  if (window.adSkipper) return;
  
  class AdSkipperCore {
    constructor() {
      this.player = new BilibiliPlayerController();
      this.segments = [];
      this.lastSkipTime = 0;
      this.cache = new Map();
    }

    async init() {
      console.log('[AdSkipper] 初始化...');
      const ok = await this.player.init();
      if (!ok) return;
      
      this.player.onCidChange = (bvid, cid) => this.loadSegments(bvid, cid);
      this.player.onTimeUpdate = (t) => this.checkSkip(t);
      
      if (this.player.currentBvid) {
        await this.loadSegments(this.player.currentBvid, this.player.currentCid);
      }
      
      window.adSkipper = this;
      this.showToast('广告跳过插件已加载（测试版）', 'info');
    }

    async loadSegments(bvid, cid) {
      if (!bvid || !cid) return;
      const key = `${bvid}-${cid}`;
      
      // 本地缓存
      const cached = localStorage.getItem(`seg_${key}`);
      if (cached) {
        this.segments = JSON.parse(cached);
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/segments?bvid=${bvid}&cid=${cid}`);
        const data = await res.json();
        this.segments = data.segments || [];
        localStorage.setItem(`seg_${key}`, JSON.stringify(this.segments));
        console.log(`[AdSkipper] 加载 ${this.segments.length} 个广告段`);
      } catch(e) {
        console.error('加载失败:', e);
        this.segments = [];
      }
    }

    checkSkip(currentTime) {
      if (!this.segments.length || Date.now() - this.lastSkipTime < 500) return;
      
      const ad = this.segments.find(s => 
        currentTime >= s.start_time && 
        currentTime < s.end_time - 0.5
      );
      
      if (ad) {
        this.player.skipTo(ad.end_time);
        this.lastSkipTime = Date.now();
        const dur = (ad.end_time - ad.start_time).toFixed(1);
        this.showToast(`已跳过 ${dur} 秒广告`, 'success');
        this.reportSkip(ad.id);
      }
    }

    async submitAnnotation(start, end, type) {
      const state = this.player.getState();
      const body = {
        bvid: state.bvid,
        cid: state.cid,
        start_time: start,
        end_time: end,
        ad_type: type
      };
      
      const res = await fetch(`${API_BASE}/segments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      
      if (!res.ok) throw new Error('提交失败');
      
      // 刷新缓存
      localStorage.removeItem(`seg_${state.bvid}-${state.cid}`);
      await this.loadSegments(state.bvid, state.cid);
      return await res.json();
    }

    reportSkip(id) {
      fetch(`${API_BASE}/segments/${id}/skip`, {method: 'POST'}).catch(()=>{});
    }

    showToast(msg, type='info') {
      const t = document.createElement('div');
      t.style.cssText = \`position:fixed;top:80px;left:50%;transform:translateX(-50%);
        background:\${type==='success'?'#67c23a':'#333'};color:#fff;padding:10px 20px;
        border-radius:4px;z-index:99999;font-size:14px;transition:opacity 0.3s;\`;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 8080);
    }
  }

  new AdSkipperCore().init();
})();'''
    write_file("extension/content/main.js", main)
    
    # annotator.js
    annotator = '''class AnnotationUI {
  constructor(core) {
    this.core = core;
    this.init();
  }
  
  init() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        this.toggle();
      }
    });
  }
  
  toggle() {
    const existing = document.getElementById('adskipper-ui');
    if (existing) { existing.remove(); return; }
    
    const state = this.core.player.getState();
    if (!state.bvid) return alert('未识别到视频');
    
    const div = document.createElement('div');
    div.id = 'adskipper-ui';
    div.innerHTML = \`
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:rgba(30,30,40,0.95);border:1px solid #444;padding:20px;
                  border-radius:8px;z-index:99999;color:#fff;width:300px;font-family:sans-serif;">
        <h3 style="margin:0 0 15px 0;color:#FB7299">标记广告时段</h3>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#aaa">开始: </label>
          <input type="number" id="as-start" value="\${state.currentTime.toFixed(1)}" step="0.1" 
                 style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#aaa">结束: </label>
          <input type="number" id="as-end" value="\${(state.currentTime+30).toFixed(1)}" step="0.1"
                 style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
        </div>
        <div style="margin-bottom:15px">
          <label style="font-size:12px;color:#aaa">类型: </label>
          <select id="as-type" style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
            <option value="hard_ad">硬广</option>
            <option value="soft_ad">暗广/软广</option>
            <option value="intro_ad">片头广告</option>
          </select>
        </div>
        <button id="as-submit" style="width:100%;background:#FB7299;border:none;color:#fff;padding:10px;border-radius:4px;cursor:pointer">提交 (+10分)</button>
        <button onclick="this.parentElement.parentElement.remove()" style="width:100%;margin-top:8px;background:#444;border:none;color:#fff;padding:8px;border-radius:4px;cursor:pointer">取消</button>
        <div id="as-status" style="margin-top:10px;font-size:12px;text-align:center;color:#aaa"></div>
      </div>
    \`;
    document.body.appendChild(div);
    
    div.querySelector('#as-submit').onclick = async () => {
      const s = parseFloat(div.querySelector('#as-start').value);
      const e = parseFloat(div.querySelector('#as-end').value);
      const t = div.querySelector('#as-type').value;
      const status = div.querySelector('#as-status');
      
      if (e <= s) { status.textContent = '结束时间必须大于开始'; status.style.color='#ff6b6b'; return; }
      
      status.textContent = '提交中...';
      try {
        await this.core.submitAnnotation(s, e, t);
        status.textContent = '✓ 提交成功！';
        status.style.color = '#67c23a';
        setTimeout(() => div.remove(), 1000);
      } catch(err) {
        status.textContent = '✗ ' + err.message;
        status.style.color = '#ff6b6b';
      }
    };
  }
}

setTimeout(() => {
  if (window.adSkipper) new AnnotationUI(window.adSkipper);
}, 2000);'''
    write_file("extension/content/annotator.js", annotator)
    
    # popup.html (简单版)
    popup = '''<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { width: 300px; padding: 15px; font-family: sans-serif; background: #1e1e2e; color: #fff; }
    h1 { font-size: 16px; color: #FB7299; margin: 0 0 10px 0; }
    .stat { display: flex; justify-content: space-between; margin: 8px 0; font-size: 14px; }
    .btn { width: 100%; background: #FB7299; color: #fff; border: none; padding: 10px; border-radius: 4px; cursor: pointer; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>🚫 B站广告跳过</h1>
  <div class="stat"><span>用户等级:</span> <span id="tier" style="color:#ffd700">Gold</span></div>
  <div class="stat"><span>今日剩余:</span> <span id="limit">∞</span></div>
  <div class="stat"><span>我的积分:</span> <span id="points">1,250</span></div>
  <button class="btn" onclick="alert('在视频页面按 Alt+A 标注广告')">如何标注?</button>
  <script>
    // 简单演示数据，实际应从API获取
    fetch('http://localhost:8080/api/v1/user/stats')
      .then(r => r.json())
      .then(d => {
        document.getElementById('tier').textContent = d.tier || 'Bronze';
        document.getElementById('points').textContent = d.points || 0;
      })
      .catch(() => {});
  </script>
</body>
</html>'''
    write_file("extension/popup/popup.html", popup)
    
    # 创建简单的图标占位文件（避免报错）
    (PROJECT_DIR / "extension/icons/icon16.png").touch()
    (PROJECT_DIR / "extension/icons/icon48.png").touch()
    
    print_color("✓ 插件代码生成完成", Colors.GREEN)

def generate_server_files():
    """生成后端代码（使用SQLite，无需安装PostgreSQL）"""
    print_color("生成后端服务代码（SQLite零配置版）...", Colors.BLUE)
    
    # package.json
    pkg = '''{
  "name": "bilibili-ad-skipper-server",
  "version": "1.0.0",
  "description": "广告跳过众包服务",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}'''
    write_file("server/package.json", pkg)
    
    # .env 配置文件
    env = '''PORT=8080
NODE_ENV=development
# 如需切换到PostgreSQL，取消下面注释并注释掉SQLite配置
# DATABASE_URL=postgresql://postgres:123456@localhost:5432/bilibili_ad_skipper
'''
    write_file("server/.env", env)
    
    # server.js (使用SQLite，但保留PG兼容接口)
    server = '''require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 初始化SQLite数据库（单文件，零配置）
const dbPath = path.join(__dirname, 'database', 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 初始化表结构
function initDB() {
  // 视频表
  db.exec(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    page INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bvid, cid, page)
  )`);
  
  // 广告段表
  db.exec(`CREATE TABLE IF NOT EXISTS ad_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    ad_type TEXT CHECK(ad_type IN ('hard_ad','soft_ad','product_placement','intro_ad','mid_ad')),
    confidence_score REAL DEFAULT 0.8,
    upvotes INTEGER DEFAULT 3,
    downvotes INTEGER DEFAULT 0,
    contributor_id INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id)
  )`);
  
  // 用户表
  db.exec(`CREATE TABLE IF NOT EXISTS user_points (
    user_id INTEGER PRIMARY KEY,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'gold',
    daily_upload_count INTEGER DEFAULT 0,
    last_upload_date DATE DEFAULT CURRENT_DATE
  )`);
  
  // 插入测试用户
  const stmt = db.prepare('INSERT OR IGNORE INTO user_points (user_id, total_points, tier) VALUES (1, 999, "platinum")');
  stmt.run();
  
  console.log('[DB] SQLite数据库初始化完成:', dbPath);
}

initDB();

// Wilson Score计算
function wilsonScore(up, down) {
  const z = 1.96;
  const n = up + down;
  if (n === 0) return 0.5;
  const p = up / n;
  return (p + z*z/(2*n) - z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n);
}

// 中间件：模拟当前用户（实际应使用JWT）
app.use((req, res, next) => {
  req.userId = 1;
  req.userTier = 'platinum'; // 测试时给最高权限
  next();
});

// 获取广告段
app.get('/api/v1/segments', (req, res) => {
  try {
    const { bvid, cid } = req.query;
    const stmt = db.prepare(`SELECT s.* FROM ad_segments s 
      JOIN videos v ON s.video_id = v.id 
      WHERE v.bvid = ? AND v.cid = ? AND s.is_active = 1`);
    const rows = stmt.all(bvid, cid);
    res.json({ segments: rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 创建标注
app.post('/api/v1/segments', (req, res) => {
  try {
    const { bvid, cid, start_time, end_time, ad_type } = req.body;
    
    const insertVideo = db.prepare('INSERT OR IGNORE INTO videos (bvid, cid) VALUES (?, ?)');
    insertVideo.run(bvid, cid);
    
    const video = db.prepare('SELECT id FROM videos WHERE bvid = ? AND cid = ?').get(bvid, cid);
    
    const insertSeg = db.prepare(`INSERT INTO ad_segments 
      (video_id, start_time, end_time, ad_type, contributor_id, is_active, confidence_score, upvotes) 
      VALUES (?, ?, ?, ?, ?, 1, 0.8, 3)`);
    
    const result = insertSeg.run(video.id, start_time, end_time, ad_type, req.userId);
    
    // 更新用户积分
    db.prepare('UPDATE user_points SET total_points = total_points + 10 WHERE user_id = ?').run(req.userId);
    
    res.status(201).json({ 
      id: result.lastInsertRowid,
      message: '标注已创建',
      points_earned: 10
    });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// 投票
app.post('/api/v1/segments/:id/vote', (req, res) => {
  try {
    const { type } = req.body;
    const field = type === 'up' ? 'upvotes' : 'downvotes';
    db.prepare(`UPDATE ad_segments SET ${field} = ${field} + 1 WHERE id = ?`).run(req.params.id);
    
    // 重新计算置信度
    const seg = db.prepare('SELECT upvotes, downvotes FROM ad_segments WHERE id = ?').get(req.params.id);
    const conf = wilsonScore(seg.upvotes, seg.downvotes);
    db.prepare('UPDATE ad_segments SET confidence_score = ? WHERE id = ?').run(conf, req.params.id);
    
    res.json({ confidence: conf });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// 获取用户统计
app.get('/api/v1/user/stats', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM user_points WHERE user_id = ?').get(req.userId);
    res.json(user || { tier: 'bronze', points: 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 上报跳过事件
app.post('/api/v1/segments/:id/skip', (req, res) => {
  res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[Server] 服务运行在 http://localhost:${PORT}`);
  console.log('[Server] 按 Ctrl+C 停止服务');
});
'''
    write_file("server/server.js", server)
    
    print_color("✓ 后端代码生成完成（使用SQLite，无需配置）", Colors.GREEN)

def install_dependencies():
    """安装Node依赖"""
    print_color("安装后端依赖（可能需要几分钟）...", Colors.YELLOW)
    try:
        os.chdir(PROJECT_DIR / "server")
        subprocess.run(["npm", "install"], check=True, shell=True)
        print_color("✓ 依赖安装完成", Colors.GREEN)
    except subprocess.CalledProcessError as e:
        print_color(f"安装失败: {e}", Colors.RED)
        print_color("请检查网络连接，或手动进入 server 目录运行 npm install", Colors.RED)

def create_launcher():
    """创建一键启动脚本"""
    print_color("创建一键启动脚本...", Colors.BLUE)
    
    # Windows批处理启动脚本
    bat = '''@echo off
chcp 65001 >nul
echo ===================================
echo   B站广告跳过插件 - 开发环境启动器
echo ===================================
echo.

:: 检查端口占用
netstat -an | find "8080" | find "LISTENING" >nul
if %errorlevel% == 0 (
    echo [警告] 端口8080已被占用，可能已有服务在运行
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
'''
    write_file("start.bat", bat)
    
    # Python启动器（更智能）
    py_launcher = '''import subprocess
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
    if check_port(8080):
        print("✓ 后端服务已在运行 (端口8080)")
    else:
        print("⚙️  启动后端服务...")
        subprocess.Popen(
            ["npm", "start"],
            cwd=server_dir,
            shell=True
        )
        print("⏳ 等待服务启动...")
        time.sleep(3)
        
        if check_port(8080):
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
    print(f"   5. 选择文件夹: {project_dir}\\\\extension")
    print()
    print("⌨️  在B站视频页面按 Alt+A 可以标注广告")
    print("=" * 40)
    
    # 可选：自动打开Chrome
    input("按回车键打开Chrome扩展页面...")
    subprocess.run(["start", "chrome", "chrome://extensions/"], shell=True)

if __name__ == "__main__":
    main()
'''
    write_file("start.py", py_launcher)
    
    print_color("✓ 启动脚本创建完成", Colors.GREEN)

def create_readme():
    """创建说明文档"""
    readme = '''# Bilibili Ad Skipper - 开发环境

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
- ✅ 创建所有代码文件`
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
'''
    write_file("README.md", readme)

def main():
    print_color("=" * 50, Colors.BLUE)
    print_color("B站广告跳过插件 - 全自动部署脚本", Colors.BLUE)
    print_color("=" * 50, Colors.BLUE)
    print()
    
    # 创建目录
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    os.chdir(PROJECT_DIR)
    
    # 检查Node
    if not check_node():
        if not install_node():
            return
    
    print()
    
    # 生成文件
    create_directory_structure()
    generate_extension_files()
    generate_server_files()
    
    # 安装依赖
    install_dependencies()
    
    # 创建启动器
    create_launcher()
    create_readme()
    
    print()
    print_color("=" * 50, Colors.GREEN)
    print_color("🎉 环境部署完成！", Colors.GREEN)
    print_color("=" * 50, Colors.GREEN)
    print()
    print("接下来请执行：")
    print(f"1. 双击运行: {PROJECT_DIR}\\\\start.bat")
    print("2. 在Chrome中加载 extension 文件夹")
    print()
    print("遇到问题？检查:")
    print(f"- 后端是否运行: http://localhost:8080")
    print(f"- 数据库位置: {PROJECT_DIR}\\\\server\\\\database\\\\app.db")

if __name__ == "__main__":
    main()