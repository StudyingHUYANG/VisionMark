(function() {
  if (window.adSkipper) return;

  class AdSkipperCore {
    constructor() {
      this.player = new BilibiliPlayerController();
      this.segments = [];
      this.lastSkipTime = 0;
      this.pendingStart = null;
      this.pendingEnd = null;
      this.pendingType = 'hard_ad';
      this.skipMode = 'auto';  // 跳过模式: 'auto' | 'manual'
      this.skipButton = null;  // 悬浮跳过按钮
    }

    async init() {
      console.log("[AdSkipper] 初始化...");
      const ok = await this.player.init();
      if (!ok) return;

      // 检查登录状态
      const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token', 'skip_mode'], r));
      const token = storage.adskipper_token;
      console.log("[AdSkipper] 登录状态:", token ? "已登录" : "未登录");

      // 读取跳过模式设置
      this.skipMode = storage.skip_mode || 'auto';
      console.log("[AdSkipper] 跳过模式:", this.skipMode);

      // 监听设置变化
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.skip_mode) {
          this.skipMode = changes.skip_mode.newValue;
          console.log("[AdSkipper] 跳过模式已更新:", this.skipMode);
        }
      });

      this.player.onTimeUpdate = (t) => this.checkSkip(t);
      this.injectControlPanel();

      const bvid = this.player.currentBvid;
      if (bvid) {
        await this.loadSegments(bvid);
        window.adSkipper = this;
      }
    }

    getPage() {
      const p = new URLSearchParams(window.location.search).get('p');
      return p ? parseInt(p) : 1;
    }

    async loadSegments(bvid) {
      try {
        const url = API_BASE + "/segments?bvid=" + bvid + "&page=" + this.getPage();
        const res = await fetch(url);
        const data = await res.json();
        this.segments = data.segments || [];
        console.log("[AdSkipper] 加载", this.segments.length, "个广告段");
      } catch(e) {
        console.error("加载失败:", e);
      }
    }

    checkSkip(currentTime) {
      if (!this.segments.length || Date.now() - this.lastSkipTime < 500) return;

      const ad = this.segments.find(s =>
        currentTime >= s.start_time && currentTime < s.end_time - 0.5
      );

      if (ad) {
        if (this.skipMode === 'auto') {
          // 自动跳过模式
          this.player.skipTo(ad.end_time);
          this.lastSkipTime = Date.now();
          this.showToast("已跳过 " + (ad.end_time - ad.start_time).toFixed(1) + " 秒广告", "success");
        } else {
          // 手动模式：显示跳过按钮
          if (!this.skipButton) {
            this.showSkipButton(ad);
          }
        }
      } else {
        // 离开广告段，隐藏按钮
        this.hideSkipButton();
      }
    }

    injectControlPanel() {
      const self = this;

      const tryInject = () => {
        // 找到控制栏底部区域
        let target = document.querySelector('.bpx-player-control-bottom');
        if (!target) target = document.querySelector('.bilibili-player-video-control');

        if (!target) {
          setTimeout(tryInject, 1000);
          return;
        }

        // 检查是否已注入
        if (document.getElementById('adskipper-container')) return;

        // 创建外层容器（独立区域，避免挤兑原有按钮）
        const container = document.createElement('div');
        container.id = 'adskipper-container';
        // 关键样式：flex布局，最小宽度限制，横向滚动
        container.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;padding:0.3em 0;background:rgba(0,0,0,0.8);border-top:1px solid rgba(255,255,255,0.1);font-size:clamp(12px,1.5vh,16px);gap:0.5em;overflow-x:auto;white-space:nowrap;';

        // 内层面板
        const panel = document.createElement('div');
        panel.id = 'adskipper-panel';
        panel.style.cssText = 'display:flex;align-items:center;gap:0.5em;';

        // 辅助函数：创建图标按钮（节省空间）
        function createIconBtn(id, icon, label, title, onClick) {
          const btn = document.createElement('button');
          btn.id = id;
          // 图标+短文字，垂直排列节省宽度
          btn.innerHTML = '<span style="font-size:1.2em;line-height:1;">' + icon + '</span><span style="font-size:0.75em;opacity:0.9;">' + label + '</span>';
          btn.title = title;
          // 固定最小宽度，防止挤压
          btn.style.cssText = 'min-width:3.5em;height:2.8em;background:#333;border:1px solid #555;color:#fff;border-radius:0.4em;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.2em;line-height:1;transition:all 0.2s;flex-shrink:0;';

          btn.onmouseenter = () => { if(!btn.disabled) { btn.style.background = '#444'; btn.style.transform = 'scale(1.05)'; } };
          btn.onmouseleave = () => {
            if (btn.dataset.active === 'true') {
              btn.style.background = '#FB7299';
              btn.style.borderColor = '#FB7299';
            } else {
              btn.style.background = '#333';
              btn.style.transform = 'scale(1)';
            }
          };
          btn.onclick = onClick;
          return btn;
        }

        // 按钮1：开始
        const btnStart = createIconBtn('adskipper-btn-start', '⛳', '开始', '标记广告开始', () => {
          const current = self.player.getState().currentTime;
          self.pendingStart = current;
          btnStart.dataset.active = 'true';
          btnStart.style.background = '#FB7299';
          btnStart.style.borderColor = '#FB7299';
          self.updateButtonStates();
          self.showToast("开始: " + current.toFixed(1) + "s", "info");
          // 视觉反馈：闪烁
          btnStart.animate([{opacity:1},{opacity:0.5},{opacity:1}], {duration:300});
        });

        // 按钮2：结束
        const btnEnd = createIconBtn('adskipper-btn-end', '🏁', '结束', '标记广告结束', () => {
          const current = self.player.getState().currentTime;
          if (self.pendingStart && current <= self.pendingStart) {
            self.showToast("结束必须大于开始", "error");
            return;
          }
          self.pendingEnd = current;
          btnEnd.dataset.active = 'true';
          btnEnd.style.background = '#FB7299';
          self.updateButtonStates();
          self.showToast("结束: " + current.toFixed(1) + "s", "info");
          btnEnd.animate([{opacity:1},{opacity:0.5},{opacity:1}], {duration:300});
        });
        btnEnd.disabled = true;
        btnEnd.style.opacity = '0.4';
        btnEnd.style.cursor = 'not-allowed';

        // 按钮3：类型（下拉菜单，紧凑版）
        const typeWrapper = document.createElement('div');
        typeWrapper.style.cssText = 'position:relative;flex-shrink:0;';

        const selectType = document.createElement('select');
        selectType.id = 'adskipper-type';
        selectType.title = '选择广告类型';
        // 使用padding而不是固定宽度，自适应
        selectType.style.cssText = 'height:2.8em;background:#333;color:#fff;border:1px solid #555;border-radius:0.4em;padding:0 0.5em;font-size:0.9em;cursor:pointer;outline:none;min-width:4em;';
        const types = [
          {val: 'hard_ad', text: '硬广'},
          {val: 'soft_ad', text: '软广'},
          {val: 'product_placement', text: '植入'},
          {val: 'intro_ad', text: '片头'},
          {val: 'mid_ad', text: '中段'}
        ];
        types.forEach((t, i) => {
          const opt = document.createElement('option');
          opt.value = t.val;
          // 如果是第一个，添加Emoji前缀提示
          opt.textContent = (i === 0 ? '⚠️ ' : '') + t.text;
          selectType.appendChild(opt);
        });
        selectType.onchange = (e) => { self.pendingType = e.target.value; };

        typeWrapper.appendChild(selectType);

        // 按钮4：提交
        const btnSubmit = createIconBtn('adskipper-btn-submit', '☁️', '提交', '提交标注', async () => {
          if (!self.pendingStart || !self.pendingEnd) return;

          // 检查是否已登录
          const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
          if (!storage.adskipper_token) {
            self.showToast("✗ 请先登录插件", "error");
            return;
          }

          btnSubmit.innerHTML = '<span style="font-size:1.2em;">⏳</span><span style="font-size:0.75em;">...</span>';
          try {
            await self.submitAnnotation(self.pendingStart, self.pendingEnd, self.pendingType);
            self.showToast("✓ 成功 +10分", "success");
            // 重置
            self.pendingStart = null;
            self.pendingEnd = null;
            self.updateButtonStates();
            btnStart.dataset.active = 'false';
            btnEnd.dataset.active = 'false';
            [btnStart, btnEnd, btnSubmit].forEach(btn => {
              btn.style.background = '#333';
              btn.style.borderColor = '#555';
            });
            btnSubmit.innerHTML = '<span style="font-size:1.2em;">☁️</span><span style="font-size:0.75em;">提交</span>';
            btnEnd.disabled = true;
            btnEnd.style.opacity = '0.4';
            btnEnd.style.cursor = 'not-allowed';
            btnSubmit.disabled = true;
            btnSubmit.style.opacity = '0.4';
            btnSubmit.style.cursor = 'not-allowed';
          } catch(err) {
            self.showToast("✗ " + err.message, "error");
            btnSubmit.innerHTML = '<span style="font-size:1.2em;">☁️</span><span style="font-size:0.75em;">提交</span>';
          }
        });
        btnSubmit.disabled = true;
        btnSubmit.style.opacity = '0.4';
        btnSubmit.style.cursor = 'not-allowed';

        // 添加可选的预览文本（显示已选时间段）
        const preview = document.createElement('span');
        preview.id = 'adskipper-preview';
        preview.style.cssText = 'color:#FB7299;font-size:0.85em;margin-left:0.5em;min-width:8em;display:inline-block;flex-shrink:0;';
        preview.textContent = '';

        panel.appendChild(btnStart);
        panel.appendChild(btnEnd);
        panel.appendChild(typeWrapper);
        panel.appendChild(btnSubmit);
        panel.appendChild(preview);

        container.appendChild(panel);

        // 插入到控制栏底部（新的一行，不挤压原有按钮）
        target.appendChild(container);
        console.log("[AdSkipper] 独立控制栏UI已注入");

        // 监听状态变化，更新预览
        setInterval(() => {
          const p = document.getElementById('adskipper-preview');
          if (!p) return;
          if (self.pendingStart && self.pendingEnd) {
            const dur = (self.pendingEnd - self.pendingStart).toFixed(1);
            p.textContent = '⏱️ ' + dur + '秒';
          } else if (self.pendingStart) {
            p.textContent = '从 ' + self.pendingStart.toFixed(1) + 's...';
          } else {
            p.textContent = '';
          }
        }, 200);
      };

      tryInject();
    }

    updateButtonStates() {
      const btnEnd = document.getElementById('adskipper-btn-end');
      const btnSubmit = document.getElementById('adskipper-btn-submit');
      const preview = document.getElementById('adskipper-preview');

      if (btnEnd && this.pendingStart) {
        btnEnd.disabled = false;
        btnEnd.style.opacity = '1';
        btnEnd.style.cursor = 'pointer';
      }
      if (btnSubmit && this.pendingStart && this.pendingEnd) {
        btnSubmit.disabled = false;
        btnSubmit.style.opacity = '1';
        btnSubmit.style.cursor = 'pointer';
      }
    }

    async submitAnnotation(start, end, type) {
      const state = this.player.getState();
      const body = {
        bvid: state.bvid,
        cid: state.cid,
        page: this.getPage(),
        start_time: parseFloat(start.toFixed(3)),
        end_time: parseFloat(end.toFixed(3)),
        ad_type: type
      };

      console.log("[AdSkipper] 准备提交:", body);

      // Get token
      const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
      const token = storage.adskipper_token;

      console.log("[AdSkipper] Token状态:", token ? "存在" : "不存在");

      const headers = {"Content-Type": "application/json"};
      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
        console.log("[AdSkipper] Authorization Header:", 'Bearer ' + token.substring(0, 20) + '...');
      } else {
        console.warn("[AdSkipper] 警告: Token不存在，请求可能会失败");
      }

      console.log("[AdSkipper] 请求头:", headers);

      const res = await fetch(API_BASE + "/segments", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        let errorMsg = "提交失败";
        try {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
          console.error("[AdSkipper] 服务器错误:", data);
        } catch(e) {
          console.error("[AdSkipper] 响应解析失败:", res.status, res.statusText);
        }
        throw new Error(errorMsg);
      }

      await this.loadSegments(state.bvid);
      return await res.json();
    }

    showToast(msg, type) {
      const old = document.getElementById('adskipper-toast');
      if (old) old.remove();

      const t = document.createElement("div");
      t.id = 'adskipper-toast';
      t.textContent = msg;
      const color = type === 'success' ? '#67c23a' : (type === 'error' ? '#ff6b6b' : '#333');
      t.style.cssText = "position:fixed;top:15%;left:50%;transform:translateX(-50%);background:" +
        color + ";color:#fff;padding:0.8em 1.5em;border-radius:0.5em;z-index:999999;font-size:clamp(14px, 2vw, 18px);box-shadow:0 4px 12px rgba(0,0,0,0.4);";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    // 显示悬浮跳过按钮
    showSkipButton(ad) {
      // 找到播放器容器
      const container = document.querySelector('.bpx-player-video-wrap') ||
                        document.querySelector('.bilibili-player-video') ||
                        document.querySelector('#bilibili-player');

      if (!container) {
        console.warn("[AdSkipper] 找不到播放器容器");
        return;
      }

      this.skipButton = document.createElement('button');
      this.skipButton.id = 'adskipper-skip-btn';
      this.skipButton.innerHTML = '跳过广告 ⏭️';
      this.skipButton.style.cssText = `
        position: absolute;
        bottom: 60px;
        right: 20px;
        padding: 12px 24px;
        background: rgba(251, 114, 153, 0.95);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transition: all 0.2s;
      `;

      // 悬停效果
      this.skipButton.onmouseenter = () => {
        this.skipButton.style.transform = 'scale(1.05)';
        this.skipButton.style.background = 'rgba(251, 114, 153, 1)';
      };
      this.skipButton.onmouseleave = () => {
        this.skipButton.style.transform = 'scale(1)';
        this.skipButton.style.background = 'rgba(251, 114, 153, 0.95)';
      };

      // 点击跳过
      this.skipButton.onclick = () => {
        this.player.skipTo(ad.end_time);
        this.hideSkipButton();
        this.lastSkipTime = Date.now();
        this.showToast("已跳过广告", "success");
      };

      // 确保容器有定位
      const computedStyle = window.getComputedStyle(container);
      if (computedStyle.position === 'static') {
        container.style.position = 'relative';
      }

      container.appendChild(this.skipButton);
      console.log("[AdSkipper] 跳过按钮已显示");
    }

    // 隐藏悬浮跳过按钮
    hideSkipButton() {
      if (this.skipButton) {
        this.skipButton.remove();
        this.skipButton = null;
        console.log("[AdSkipper] 跳过按钮已隐藏");
      }
    }
  }

  new AdSkipperCore().init();
})();
