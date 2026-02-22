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
      // 手动跳过功能
      this.skipMode = 'auto';
      this.skipButton = null;
      // 新增日志控制变量
      this.noSegmentLogPrinted = false;
      this.coolDownLogPrinted = false;
      this.matchProcessLogPrinted = false;
      this.noAdMatchLogPrinted = false;

      // 存储当前视频的标注ID（用于删除）
      this.currentSegmentIds = [];


    }

    init() {
      console.log("[AdSkipper] 初始化...");
      this.player.init().then(ok => {
        if (!ok) return;

        // 检查登录状态
        chrome.storage.local.get(['adskipper_token'], (storage) => {
          const token = storage.adskipper_token;
          console.log("[AdSkipper] 登录状态:", token ? "已登录" : "未登录");
        });

        // 加载跳过模式设置
        chrome.storage.local.get(['skip_mode'], (storage) => {
          this.skipMode = storage.skip_mode || 'auto';
          console.log("[AdSkipper] 跳过模式:", this.skipMode);
        });

        // 监听跳过模式变化
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.skip_mode) {
            this.skipMode = changes.skip_mode.newValue || 'auto';
            console.log("[AdSkipper] 跳过模式已更新:", this.skipMode);
            // 如果切换到自动模式，立即隐藏按钮
            if (this.skipMode === 'auto') {
              this.hideSkipButton();
            }
          }
        });

        this.player.onTimeUpdate = (t) => this.checkSkip(t);
        this.startInjectionObserver();

        const bvid = this.player.currentBvid;
        if (bvid) {
          this.loadSegments(bvid).then(() => {
            window.adSkipper = this;
          });
        }
      });

      // Global click listener for closing popover
      document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('adskipper-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          this.togglePopover(false);
        }
      });

      // ESC key listener
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.togglePopover(false);
      });
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
        // 保存标注ID用于删除
        this.currentSegmentIds = this.segments.map(seg => seg.id).filter(id => id);
        console.log("[AdSkipper] 加载", this.segments.length, "个广告段，ID列表:", this.currentSegmentIds);
      } catch(e) {
        console.error("加载失败:", e);
      }
    }

    // 替换后的 checkSkip 方法
    checkSkip(currentTime) {




      // 单条播放时间日志（不刷屏，页面右上角显示）
      const logElementId = 'ad-skipper-play-time';
      let logElement = document.getElementById(logElementId);

      if (!logElement) {
        logElement = document.createElement('div');
        logElement.id = logElementId;
        logElement.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,0.8);color:#fff;padding:8px 12px;border-radius:4px;font-size:14px;z-index:999999;';
        document.body.appendChild(logElement);
      }
      const modeText = this.skipMode === 'auto' ? '[自动]' : '[手动]';
      logElement.textContent = `${modeText} 时间: ${currentTime.toFixed(2)}s | 广告段: ${this.segments.length}`;

      if (!this.segments.length || Date.now() - this.lastSkipTime < 500) {
        if (!this.segments.length && !this.noSegmentLogPrinted) {
          console.log("[AdSkipper] 跳过判断：无广告段数据（后续不再重复提示）");
          this.noSegmentLogPrinted = true;
        } else if (Date.now() - this.lastSkipTime < 500 && !this.coolDownLogPrinted) {
          console.log(`[AdSkipper] 跳过判断：500ms冷却期内（上次跳过：${this.lastSkipTime}，当前：${Date.now()}）`);
          this.coolDownLogPrinted = true;
        }
        return;
      }

      this.noSegmentLogPrinted = false;
      this.coolDownLogPrinted = false;

      if (!this.matchProcessLogPrinted) {
        console.log(`[AdSkipper] 正在匹配广告段（共${this.segments.length}个）...`);
        this.segments.forEach((ad, idx) => {
          console.log(`[AdSkipper] 广告段${idx + 1}：${ad.start_time.toFixed(2)}s - ${ad.end_time.toFixed(2)}s（类型：${ad.ad_type || 'hard_ad'}）`);
        });
        this.matchProcessLogPrinted = true;
      }



      if (!this.segments.length || Date.now() - this.lastSkipTime < 500) return;



      const ad = this.segments.find(s =>
        currentTime >= s.start_time && currentTime < s.end_time - 0.5
      );

      if (ad) {
        console.log(`[AdSkipper] 匹配到广告段：${ad.start_time.toFixed(2)}s - ${ad.end_time.toFixed(2)}s，执行跳过`);
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
        this.matchProcessLogPrinted = false;
        this.noAdMatchLogPrinted = false;
      } else {
        // 离开广告段，隐藏按钮
        this.hideSkipButton();
        if (!this.noAdMatchLogPrinted) {
          console.log("[AdSkipper] 未匹配到需要跳过的广告段（后续不再重复提示）");
          this.noAdMatchLogPrinted = true;
        }
      }
    }

    startInjectionObserver() {
      const observer = new MutationObserver(() => {
        // Idempotency check
        if (document.getElementById('adskipper-wrapper')) return;

        // Try to find target
        const target = document.querySelector('.bpx-player-control-bottom-right') ||
                       document.querySelector('.bpx-player-control-bottom') ||
                       document.querySelector('.bilibili-player-video-control');

        if (target) {
          this.injectControlPanel(target);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // Initial check
      const target = document.querySelector('.bpx-player-control-bottom-right') ||
                     document.querySelector('.bpx-player-control-bottom') ||
                     document.querySelector('.bilibili-player-video-control');
      if (target && !document.getElementById('adskipper-wrapper')) {
        this.injectControlPanel(target);
      }
    }

    injectControlPanel(target) {
      const self = this;
      console.log("[AdSkipper] 注入控制面板到:", target.className);

      // 1. Inject Styles for Responsiveness
      if (!document.getElementById('adskipper-css')) {
        const style = document.createElement('style');
        style.id = 'adskipper-css';
        style.textContent = `
          .adskipper-toggle-text { display: block; font-size: 13px; font-weight: 500; }
          .is-compact #adskipper-toggle { padding: 0 6px !important; justify-content: center; }
          #adskipper-toggle:hover { filter: brightness(1.1); }
          /* 确认对话框样式 */
          #adskipper-confirm-dialog {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(20, 20, 20, 0.98);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 20px;
            z-index: 999999;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
            color: #fff;
            min-width: 300px;
          }
          #adskipper-confirm-dialog h3 {
            margin: 0 0 15px 0;
            font-size: 16px;
            color: #FB7299;
          }
          #adskipper-confirm-dialog .btn-group {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 20px;
          }
          #adskipper-confirm-dialog button {
            padding: 6px 16px;
            border-radius: 4px;
            border: none;
            cursor: pointer;
            font-size: 14px;
          }
          #adskipper-confirm-ok {
            background: #FB7299;
            color: white;
          }
          #adskipper-confirm-cancel {
            background: #555;
            color: white;
          }
        `;
        document.head.appendChild(style);
      }

      // 2. Wrapper
      const wrapper = document.createElement('div');
      wrapper.id = 'adskipper-wrapper';
      wrapper.style.cssText = 'position:relative;display:inline-flex;vertical-align:middle;height:100%;align-items:center;margin-right:12px;z-index:100;';

      // 3. Toggle Button
      const toggleBtn = document.createElement('div');
      toggleBtn.id = 'adskipper-toggle';
      toggleBtn.title = '广告标注控制';
      toggleBtn.setAttribute('aria-label', '广告标注控制');
      toggleBtn.style.cssText = `
        cursor: pointer;
        background-color: #FB7299;
        color: #FFFFFF;
        border-radius: 6px;
        padding: 4px 10px;
        transition: all 0.2s;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: auto;
        min-height: 24px;
      `;
      toggleBtn.innerHTML = `<span class="adskipper-toggle-text">广告控制</span>`;

      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        self.togglePopover();
      };

      // 4. Popover Panel
      const popover = document.createElement('div');
      popover.id = 'adskipper-popover';
      popover.style.cssText = `
        display: none;
        position: absolute;
        bottom: 140%;
        left: 0;
        margin-bottom: 0px;
        z-index: 2147483647;
        background: rgba(20, 20, 20, 0.95);
        backdrop-filter: blur(10px);
        padding: 10px;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        border: 1px solid rgba(255,255,255,0.1);
        width: max-content;
        flex-direction: column;
        gap: 8px;
        transform-origin: bottom left;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      `;
      popover.onclick = (e) => e.stopPropagation();

      // --- Button Logic ---

      // Helper: Create Row
      const createRow = () => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';
        return row;
      };

      // Helper: Create Button
      function createBtn(id, icon, label, title, onClick) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.innerHTML = `<span style="font-size:1.2em;">${icon}</span> <span style="font-size:0.9em;">${label}</span>`;
        btn.title = title;
        btn.style.cssText = `
          flex: 1;
          height: 32px;
          background: #333;
          border: 1px solid #555;
          color: #fff;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.2s;
          padding: 0 8px;
          white-space: nowrap;
        `;
        btn.onmouseenter = () => { if(!btn.disabled) { btn.style.background = '#444'; } };
        btn.onmouseleave = () => {
          if (btn.dataset.active === 'true') {
            btn.style.background = '#FB7299';
            btn.style.borderColor = '#FB7299';
          } else {
            btn.style.background = '#333';
          }
        };
        btn.onclick = onClick;
        return btn;
      }

      // Row 1: Start / End
      const row1 = createRow();

      const btnStart = createBtn('adskipper-btn-start', '⛳', '开始', '标记广告开始', () => {
        const current = self.player.getState().currentTime;
        self.pendingStart = current;
        btnStart.dataset.active = 'true';
        btnStart.style.background = '#FB7299';
        btnStart.style.borderColor = '#FB7299';
        self.updateButtonStates();
        self.showToast("开始: " + current.toFixed(1) + "s", "info");
        btnStart.animate([{opacity:1},{opacity:0.5},{opacity:1}], {duration:300});
      });

      const btnEnd = createBtn('adskipper-btn-end', '🏁', '结束', '标记广告结束', () => {
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
      btnEnd.style.opacity = '0.5';
      btnEnd.style.cursor = 'not-allowed';

      row1.appendChild(btnStart);
      row1.appendChild(btnEnd);

      // Row 2: Type Selector
      const row2 = createRow();
      const selectType = document.createElement('select');
      selectType.id = 'adskipper-type';
      selectType.style.cssText = 'width:100%;height:32px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:0 6px;font-size:0.9em;outline:none;cursor:pointer;';
      const types = [
        {val: 'hard_ad', text: '硬广 (Hard Ad)'},
        {val: 'soft_ad', text: '软广 (Soft Ad)'},
        {val: 'product_placement', text: '植入 (Placement)'},
        {val: 'intro_ad', text: '片头 (Intro)'},
        {val: 'mid_ad', text: '中段 (Mid)'}
      ];
      types.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.val;
        opt.textContent = t.text;
        selectType.appendChild(opt);
      });
      selectType.onchange = (e) => { self.pendingType = e.target.value; };
      row2.appendChild(selectType);

      // Row 3: Submit + Delete
      const row3 = createRow();
      const btnSubmit = createBtn('adskipper-btn-submit', '☁️', '提交标注', '提交到服务器', async () => {
        if (!self.pendingStart || !self.pendingEnd) return;

        const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
        if (!storage.adskipper_token) {
          self.showToast("✗ 请先登录插件", "error");
          return;
        }

        btnSubmit.innerHTML = '⏳ 提交中...';
        try {
          await self.submitAnnotation(self.pendingStart, self.pendingEnd, self.pendingType);
          self.showToast("✓ 成功 +10分", "success");

          // Reset
          self.pendingStart = null;
          self.pendingEnd = null;
          self.updateButtonStates();

          btnStart.dataset.active = 'false';
          btnEnd.dataset.active = 'false';
          [btnStart, btnEnd].forEach(btn => {
            btn.style.background = '#333';
            btn.style.borderColor = '#555';
          });

          btnSubmit.innerHTML = '<span style="font-size:1.2em;">☁️</span> <span style="font-size:0.9em;">提交标注</span>';

          // Close popover on success
          self.togglePopover(false);

        } catch(err) {
          self.showToast("✗ " + err.message, "error");
          btnSubmit.innerHTML = '<span style="font-size:1.2em;">☁️</span> <span style="font-size:0.9em;">提交标注</span>';
        }
      });
      btnSubmit.disabled = true;
      btnSubmit.style.opacity = '0.5';
      btnSubmit.style.cursor = 'not-allowed';

      // 添加删除按钮
      const btnDelete = createBtn('adskipper-btn-delete', '🗑️', '删除最近', '删除最近添加的标注', async () => {
        // 检查是否有可删除的标注
        if (!self.currentSegmentIds.length) {
          self.showToast("✗ 暂无可删除的标注", "error");
          return;
        }

        // 显示确认对话框
        const confirmResult = await self.showConfirmDialog(
          "确认删除",
          `是否确定删除最近添加的标注？\n（ID: ${self.currentSegmentIds[self.currentSegmentIds.length - 1]}）`
        );
        
        if (!confirmResult) return;

        btnDelete.innerHTML = '⏳ 删除中...';
        btnDelete.disabled = true;
        btnDelete.style.opacity = '0.5';

        try {
          // 删除最后一个标注
          const lastSegmentId = self.currentSegmentIds[self.currentSegmentIds.length - 1];
          await self.deleteAnnotation(lastSegmentId);
          self.showToast("✓ 删除成功", "success");
          
          // 刷新标注数据
          await self.loadSegments(self.player.currentBvid);
          
          // 重置按钮状态
          btnDelete.innerHTML = '<span style="font-size:1.2em;">🗑️</span> <span style="font-size:0.9em;">删除最近</span>';
          btnDelete.disabled = false;
          btnDelete.style.opacity = '1';
          
          // 关闭弹窗
          self.togglePopover(false);
        } catch (err) {
          self.showToast("✗ " + err.message, "error");
          btnDelete.innerHTML = '<span style="font-size:1.2em;">🗑️</span> <span style="font-size:0.9em;">删除最近</span>';
          btnDelete.disabled = false;
          btnDelete.style.opacity = '1';
        }
      });

      // 禁用删除按钮（如果没有标注）
      if (!self.currentSegmentIds.length) {
        btnDelete.disabled = true;
        btnDelete.style.opacity = '0.5';
        btnDelete.style.cursor = 'not-allowed';
      }

      row3.appendChild(btnSubmit);
      row3.appendChild(btnDelete);

      // Preview Text
      const previewRow = createRow();
      previewRow.style.justifyContent = 'center';
      const preview = document.createElement('span');
      preview.id = 'adskipper-preview';
      preview.style.cssText = 'color:#FB7299;font-size:0.85em;min-height:1.2em;';
      previewRow.appendChild(preview);

      // Assemble Popover
      popover.appendChild(row1);
      popover.appendChild(row2);
      popover.appendChild(row3);
      popover.appendChild(previewRow);

      // Assemble Wrapper
      wrapper.appendChild(toggleBtn);
      wrapper.appendChild(popover);

      // Inject
      if (target.firstChild) {
        target.insertBefore(wrapper, target.firstChild);
      } else {
        target.appendChild(wrapper);
      }

      // ResizeObserver
      const playerContainer = document.querySelector('.bpx-player-container') || document.querySelector('#bilibili-player');
      if (playerContainer) {
        const ro = new ResizeObserver(entries => {
          for (let entry of entries) {
            if (entry.contentRect.width < 600) {
              wrapper.classList.add('is-compact');
            } else {
              wrapper.classList.remove('is-compact');
            }
          }
        });
        ro.observe(playerContainer);
      }

      // Preview update loop
      if (this.previewInterval) clearInterval(this.previewInterval);
      this.previewInterval = setInterval(() => {
        const p = document.getElementById('adskipper-preview');
        if (!p) return;
        if (self.pendingStart && self.pendingEnd) {
          const dur = (self.pendingEnd - self.pendingStart).toFixed(1);
          p.textContent = '⏱️ 已选 ' + dur + '秒';
        } else if (self.pendingStart) {
          p.textContent = '从 ' + self.pendingStart.toFixed(1) + 's...';
        } else {
          p.textContent = '';
        }
      }, 200);
    }

    // 显示确认对话框
    showConfirmDialog(title, message) {
      return new Promise((resolve) => {
        // 移除已存在的对话框
        const oldDialog = document.getElementById('adskipper-confirm-dialog');
        if (oldDialog) oldDialog.remove();

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.id = 'adskipper-confirm-dialog';
        dialog.innerHTML = `
          <h3>${title}</h3>
          <p>${message}</p>
          <div class="btn-group">
            <button id="adskipper-confirm-cancel">取消</button>
            <button id="adskipper-confirm-ok">确认</button>
          </div>
        `;
        document.body.appendChild(dialog);

        // 绑定事件
        document.getElementById('adskipper-confirm-ok').onclick = () => {
          dialog.remove();
          resolve(true);
        };
        document.getElementById('adskipper-confirm-cancel').onclick = () => {
          dialog.remove();
          resolve(false);
        };

        // 点击外部关闭
        const clickOutsideHandler = (e) => {
          if (!dialog.contains(e.target)) {
            dialog.remove();
            resolve(false);
            document.removeEventListener('click', clickOutsideHandler);
          }
        };
        setTimeout(() => {
          document.addEventListener('click', clickOutsideHandler);
        }, 0);
      });
    }

    // 调用删除API
    async deleteAnnotation(segmentId) {
      const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
      const token = storage.adskipper_token;

      if (!token) {
        throw new Error("请先登录插件");
      }

      const headers = {
        "Content-Type": "application/json",
        "Authorization": 'Bearer ' + token
      };

      console.log("[AdSkipper] 准备删除标注 ID:", segmentId);

      const res = await fetch(`${API_BASE}/segments/${segmentId}`, {
        method: "DELETE",
        headers: headers
      });

      if (!res.ok) {
        let errorMsg = "删除失败";
        try {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
        } catch (e) {
          console.error("[AdSkipper] 删除响应解析失败:", res.status, res.statusText);
        }
        throw new Error(errorMsg);
      }

      return await res.json();
    }

    togglePopover(forceState) {
      const popover = document.getElementById('adskipper-popover');
      if (!popover) return;

      const newState = forceState !== undefined ? forceState : (popover.style.display === 'none');

      if (newState) {
        popover.style.display = 'flex';
        // Simple animation
        popover.animate([
          { opacity: 0, transform: 'scale(0.9) translateY(10px)' },
          { opacity: 1, transform: 'scale(1) translateY(0)' }
        ], { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
      } else {
        popover.style.display = 'none';
      }
    }

    updateButtonStates() {
      const btnEnd = document.getElementById('adskipper-btn-end');
      const btnSubmit = document.getElementById('adskipper-btn-submit');
      const preview = document.getElementById('adskipper-preview');
      const btnDelete = document.getElementById('adskipper-btn-delete');
      
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
      // 更新删除按钮状态
      if (btnDelete) {
        if (this.currentSegmentIds.length) {
          btnDelete.disabled = false;
          btnDelete.style.opacity = '1';
          btnDelete.style.cursor = 'pointer';
        } else {
          btnDelete.disabled = true;
          btnDelete.style.opacity = '0.5';
          btnDelete.style.cursor = 'not-allowed';
        }
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

    showSkipButton(ad) {
      // 1. 双重重复防护：实例级别检查
      if (this.skipButton) return;
      // 2. 双重重复防护：DOM 级别检查
      if (document.getElementById('adskipper-skip-btn')) return;

      const self = this;

      // 3. 精准挂载容器选择 - 优先使用视频画面容器，避免控制栏
      // 优先级：.bpx-player-video-wrap > .bpx-player-video-area > fallback
      let playerContainer = document.querySelector('.bpx-player-video-wrap') ||
                            document.querySelector('.bpx-player-video-area') ||
                            document.querySelector('.bpx-player-container') ||
                            document.querySelector('#bilibili-player');

      if (!playerContainer) {
        console.log("[AdSkipper] 未找到播放窗口容器");
        return;
      }

      // 4. 确保父容器有相对定位（子绝父相）
      if (getComputedStyle(playerContainer).position === 'static') {
        playerContainer.style.position = 'relative';
      }

      const btn = document.createElement('div');
      btn.id = 'adskipper-skip-btn';
      btn.textContent = '跳过广告';
      // 5. 响应式 CSS 定位：使用像素值 + !important 确保严格定位在视频画面右下角
      // 默认 bottom: 60px，在全屏模式下通过 CSS 覆盖为 100px
      btn.style.cssText = `
        position: absolute !important;
        right: 20px !important;
        bottom: 60px !important;
        background: #FB7299;
        color: #fff;
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        z-index: 99999 !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        transition: all 0.2s;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: skipBtnPop 0.3s ease-out;
        pointer-events: auto;
      `;

      // 6. 添加动画样式
      if (!document.getElementById('adskipper-skip-anim')) {
        const style = document.createElement('style');
        style.id = 'adskipper-skip-anim';
        style.textContent = `
          @keyframes skipBtnPop {
            0% { transform: scale(0.5); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
          }
        `;
        document.head.appendChild(style);
      }

      // 7. 监听全屏状态变化，动态调整按钮位置
      this._fullscreenObserver = new MutationObserver(() => {
        const btn = this.skipButton;
        if (!btn) return;

        // 检测全屏状态
        const isFullscreen = document.querySelector('.bpx-state-fullscreen, .mode-fullscreen, [data-screen="full"], .bilibili-player-fullscreen');
        const isWebFullscreen = document.querySelector('.bpx-state-web-fullscreen, .mode-web-fullscreen, [data-screen="web-full"]');

        if (isFullscreen) {
          btn.style.bottom = '120px';
          btn.style.right = '30px';
        } else if (isWebFullscreen) {
          btn.style.bottom = '120px';
          btn.style.right = '25px';
        } else {
          // 正常模式
          btn.style.bottom = '60px';
          btn.style.right = '20px';
        }
      });

      // 监听播放器容器的 class 变化（全屏状态通过 class 改变）
      const playerContainerForObserver = document.querySelector('.bpx-player-container') ||
                                         document.querySelector('#bilibili-player') ||
                                         playerContainer;
      if (playerContainerForObserver) {
        this._fullscreenObserver.observe(playerContainerForObserver, {
          attributes: true,
          attributeFilter: ['class', 'data-screen']
        });
      }

      btn.onmouseenter = () => { btn.style.transform = 'scale(1.05)'; };
      btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };
      btn.onclick = () => {
        self.player.skipTo(ad.end_time);
        self.lastSkipTime = Date.now();
        self.showToast("已跳过 " + (ad.end_time - ad.start_time).toFixed(1) + " 秒广告", "success");
        self.hideSkipButton();
      };

      playerContainer.appendChild(btn);
      this.skipButton = btn;
      console.log("[AdSkipper] 显示手动跳过按钮 - 挂载到:", playerContainer.className || playerContainer.id);
    }

    hideSkipButton() {
      if (this.skipButton) {
        this.skipButton.remove();
        this.skipButton = null;
        console.log("[AdSkipper] 隐藏手动跳过按钮");
      }
    }
  }

  new AdSkipperCore().init();
})();