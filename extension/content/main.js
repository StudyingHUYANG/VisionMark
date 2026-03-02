import { createSidebar, sidebarState } from '../sidebar/index.js';

(function () {
  if (window.adSkipper) return;

  // 广告类型标签映射
  const typeLabels = {
    'hard_ad': '硬广',
    'soft_ad': '软广',
    'product_placement': '植入',
    'intro_ad': '片头',
    'mid_ad': '中段'
  };

  class AdSkipperCore {
    constructor() {
      this.player = new BilibiliPlayerController();
      this.segments = [];
      this.allSegments = [];
      this.aiSummary = '';
      this.lastSkipTime = 0;
      this.lastPopupSegmentKey = null;
      this.popupLockUntil = 0;
      this.pendingStart = null;
      this.pendingEnd = null;
      this.pendingType = 'hard_ad';
      // 手动跳过功能
      this.skipMode = 'auto';
      this.skipButton = null;
      // 日志控制变量
      this.noSegmentLogPrinted = false;
      this.coolDownLogPrinted = false;
      this.matchProcessLogPrinted = false;
      this.noAdMatchLogPrinted = false;

      // 存储当前视频的标注 ID（用于删除）
      this.currentSegmentIds = [];
      this.isLoadingSegments = false;


    }

    init() {
      console.log("[AdSkipper] 初始化...");
      this.player.init().then(ok => {
        if (!ok) return;

        // 检查登录状态
        chrome.storage.local.get(['adskipper_token'], (storage) => {
          const token = storage.adskipper_token;
          console.log('[AdSkipper] Login status:', token ? 'logged in' : 'not logged in');
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

        // ==========================
        // Vue 侧边栏初始化
        // ==========================
        this.initAiFloatingButton();

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

        const aiButton = document.getElementById('visionmark-ai-fab');
        const aiPanel = document.getElementById('adskipper-segment-panel');
        if (aiPanel && aiButton && !aiPanel.contains(e.target) && !aiButton.contains(e.target)) {
          aiPanel.remove();
        }
      });

      // ESC key listener
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.togglePopover(false);
          const aiPanel = document.getElementById('adskipper-segment-panel');
          if (aiPanel) aiPanel.remove();
        }
      });

      // Listen for messages from popup
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'showSegmentMarkers') {
          this.handleShowMarkers();
          sendResponse({ success: true });
        }
      });

      window.addEventListener('visionmark:seek', (event) => {
        const time = Number(event?.detail?.time);
        if (!Number.isFinite(time)) return;
        this.player.skipTo(Math.max(time, 0));
      });

      window.addEventListener('visionmark:refresh-ai', () => {
        if (this.player.currentBvid) {
          this.loadSegments(this.player.currentBvid);
        }
      });

      // 调试：将实例暴露到全局，便于控制台调试
      window.adSkipperDebug = this;
      console.log('[AdSkipper] 调试模式已启用，使用: adSkipperDebug.addSegmentMarkers() 手动添加标记');
    }

    initSidebar() {
      if (document.getElementById('vm-sidebar-root')) return;

      const root = document.createElement('div');
      root.id = 'vm-sidebar-root';
      document.body.appendChild(root);

      console.log("[AdSkipper Sidebar] 初始化侧边栏...");
      this.sidebarController = createSidebar(root);
    }

    initAiFloatingButton() {
      if (!document.getElementById('visionmark-ai-fab-style')) {
        const style = document.createElement('style');
        style.id = 'visionmark-ai-fab-style';
        style.textContent = `
          #visionmark-ai-fab {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 2147483647;
            min-width: 46px;
            height: 46px;
            border: none;
            border-radius: 999px;
            background: linear-gradient(135deg, #FB7299, #ff8e9f);
            color: #fff;
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.4px;
            cursor: pointer;
            box-shadow: 0 10px 28px rgba(251, 114, 153, 0.45);
            transition: transform 0.18s ease, box-shadow 0.18s ease;
            padding: 0 16px;
          }
          #visionmark-ai-fab:hover {
            transform: translateY(-2px);
            box-shadow: 0 14px 34px rgba(251, 114, 153, 0.55);
          }
        `;
        document.head.appendChild(style);
      }

      if (document.getElementById('visionmark-ai-fab')) return;

      const button = document.createElement('button');
      button.id = 'visionmark-ai-fab';
      button.type = 'button';
      button.textContent = 'AI';
      button.title = 'AI video summary';
      button.setAttribute('aria-label', 'AI video summary');
      button.onclick = (event) => {
        event.stopPropagation();
        this.handleShowMarkers();
      };

      document.body.appendChild(button);
    }

    getPage() {
      const p = new URLSearchParams(window.location.search).get('p');
      return p ? parseInt(p) : 1;
    }

    async getToken() {
      return new Promise((resolve) => {
        chrome.storage.local.get(['adskipper_token'], (storage) => {
          resolve(storage.adskipper_token);
        });
      });
    }

    async loadSegments(bvid) {
      if (!bvid || this.isLoadingSegments) return;
      this.isLoadingSegments = true;
      sidebarState.isLoading = true;
      sidebarState.loadError = null;

      try {
        const storage = await new Promise(r => chrome.storage.local.get(['skip_types'], r));
        const skipTypes = storage.skip_types || ['hard_ad', 'soft_ad', 'product_placement'];

        const url = API_BASE + "/segments?bvid=" + bvid + "&page=" + this.getPage();
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error("Failed to load segments: " + res.status);
        }

        const data = await res.json();
        const normalizedSegments = (data.segments || [])
          .map((segment, index) => this.normalizeSegment(segment, index))
          .filter(segment => Number.isFinite(segment.start_time) && Number.isFinite(segment.end_time) && segment.end_time > segment.start_time);

        this.allSegments = normalizedSegments;
        this.segments = normalizedSegments.filter(segment => {
          if (segment.action === 'popup') return true;
          if (segment.hasActionField) return true;
          return skipTypes.includes(segment.ad_type || 'hard_ad');
        });
        this.aiSummary = typeof data.ai_summary === 'string' ? data.ai_summary.trim() : '';
        this.currentSegmentIds = this.segments.map(seg => seg.id).filter(id => id);

        sidebarState.aiSummary = this.aiSummary || '暂无 AI 总结';
        sidebarState.segments = this.segments;
        sidebarState.activeSegmentKey = null;

        this.addSegmentMarkers();
      } catch (error) {
        console.error('[AdSkipper] Load segments failed:', error);
        this.segments = [];
        this.allSegments = [];
        this.currentSegmentIds = [];
        sidebarState.segments = [];
        sidebarState.aiSummary = sidebarState.aiSummary || 'AI 总结加载失败';
        sidebarState.loadError = error.message || 'load failed';
      } finally {
        this.isLoadingSegments = false;
        sidebarState.isLoading = false;
      }
    }

    normalizeSegment(segment, index) {
      const start = Number(segment.start ?? segment.start_time ?? 0);
      const end = Number(segment.end ?? segment.end_time ?? 0);
      const candidateAction = typeof segment.action === 'string' ? segment.action.toLowerCase() : '';
      const action = candidateAction === 'popup' || candidateAction === 'skip' ? candidateAction : 'skip';

      const rawContent = typeof segment.content === 'string' ? segment.content.trim() : null;
      const content = action === 'popup' ? (rawContent || null) : null;

      return {
        ...segment,
        id: segment.id ?? `${start}-${end}-${index}`,
        start,
        end,
        start_time: start,
        end_time: end,
        action,
        content,
        ad_type: segment.ad_type || (action === 'skip' ? 'hard_ad' : 'mid_ad'),
        hasActionField: typeof segment.action === 'string'
      };
    }

    getSegmentKey(segment, indexFallback = 0) {
      return String(segment.id ?? `${segment.start_time}-${segment.end_time}-${indexFallback}`);
    }

    showInsightPopup(segment) {
      const popupId = 'visionmark-insight-popup';
      const oldPopup = document.getElementById(popupId);
      if (oldPopup) oldPopup.remove();

      const popup = document.createElement('div');
      popup.id = popupId;
      popup.style.cssText = `
        position: fixed;
        right: 24px;
        bottom: 96px;
        width: min(360px, 78vw);
        max-height: 42vh;
        overflow-y: auto;
        background: rgba(16, 21, 34, 0.96);
        border: 1px solid rgba(71, 167, 255, 0.55);
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
        color: #eaf4ff;
        z-index: 999999;
        padding: 12px 14px;
        line-height: 1.55;
        font-size: 13px;
      `;

      const start = Number.isFinite(segment.start_time) ? segment.start_time.toFixed(1) : '-';
      const end = Number.isFinite(segment.end_time) ? segment.end_time.toFixed(1) : '-';
      const content = segment.content || '该片段暂无解读文案';

      popup.innerHTML = `
        <div style="font-size: 11px; letter-spacing: .4px; color: #74b7ff; margin-bottom: 6px;">
          AI HIGHLIGHT ${start}s - ${end}s
        </div>
        <div style="white-space: pre-wrap;">${content}</div>
      `;

      document.body.appendChild(popup);
      this.popupLockUntil = Date.now() + 3200;
    }

    hideInsightPopup() {
      const popup = document.getElementById('visionmark-insight-popup');
      if (popup) popup.remove();
      this.lastPopupSegmentKey = null;
      this.popupLockUntil = 0;
    }

    seekToSegmentStart(segment) {
      if (!segment) return;
      const targetTime = Number(segment.start_time);
      if (!Number.isFinite(targetTime)) return;
      this.player.skipTo(Math.max(0, targetTime));
    }

    seekToSegmentEnd(segment) {
      if (!segment) return;
      const targetTime = Number(segment.end_time);
      if (!Number.isFinite(targetTime)) return;
      this.player.skipTo(Math.max(0, targetTime));
    }

    getActiveSegment(currentTime) {
      return this.segments.find(segment => currentTime >= segment.start_time && currentTime < segment.end_time - 0.2);
    }

    handlePopupSegment(segment) {
      if (!segment || segment.action !== 'popup') return;

      const key = this.getSegmentKey(segment);
      if (this.lastPopupSegmentKey === key) return;
      if (Date.now() < this.popupLockUntil) return;

      this.lastPopupSegmentKey = key;
      this.showInsightPopup(segment);
      this.showToast('AI 知识点提醒', 'info');
    }

    handleSkipSegment(segment) {
      if (!segment || segment.action !== 'skip') return;

      if (this.skipMode === 'auto') {
        this.seekToSegmentEnd(segment);
        this.lastSkipTime = Date.now();
        this.showSkipNotification(segment);
        return;
      }

      if (!this.skipButton) {
        this.showSkipButton(segment);
      }
    }

    // 更新后的 checkSkip 方法
    checkSkip(currentTime) {
      sidebarState.currentTime = currentTime;
      if (this.player.currentBvid) {
        sidebarState.bvid = this.player.currentBvid;
      }
      if (this.player.currentCid) {
        sidebarState.cid = this.player.currentCid;
      }

      if (!this.segments.length) {
        sidebarState.activeSegmentKey = null;
        this.hideSkipButton();
        if (Date.now() > this.popupLockUntil) {
          this.hideInsightPopup();
        }
        return;
      }

      const activeSegment = this.getActiveSegment(currentTime);
      if (!activeSegment) {
        sidebarState.activeSegmentKey = null;
        this.hideSkipButton();
        if (Date.now() > this.popupLockUntil) {
          this.hideInsightPopup();
        }
        return;
      }

      sidebarState.activeSegmentKey = this.getSegmentKey(activeSegment);

      if (activeSegment.action === 'popup') {
        this.hideSkipButton();
        this.handlePopupSegment(activeSegment);
        return;
      }

      if (Date.now() > this.popupLockUntil) {
        this.hideInsightPopup();
      }

      if (Date.now() - this.lastSkipTime < 500) {
        return;
      }

      this.handleSkipSegment(activeSegment);
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

      if (!document.getElementById('adskipper-css')) {
        const style = document.createElement('style');
        style.id = 'adskipper-css';
        style.textContent = `
          .adskipper-toggle-text { display: block; font-size: 13px; font-weight: 500; }
          .is-compact #adskipper-toggle { padding: 0 6px !important; justify-content: center; }
          #adskipper-toggle:hover { filter: brightness(1.1); }
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

      const wrapper = document.createElement('div');
      wrapper.id = 'adskipper-wrapper';
      wrapper.style.cssText = 'position:relative;display:inline-flex;vertical-align:middle;height:100%;align-items:center;margin-right:12px;z-index:100;';

      const toggleBtn = document.createElement('div');
      toggleBtn.id = 'adskipper-toggle';
      toggleBtn.title = '广告控制';
      toggleBtn.setAttribute('aria-label', '广告控制');
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
      toggleBtn.innerHTML = '<span class="adskipper-toggle-text">广告控制</span>';
      toggleBtn.onclick = (event) => {
        event.stopPropagation();
        self.togglePopover();
      };

      const popover = document.createElement('div');
      popover.id = 'adskipper-popover';
      popover.style.cssText = `
        display: none;
        position: absolute;
        bottom: 140%;
        left: 0;
        margin-bottom: 0;
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
      popover.onclick = (event) => event.stopPropagation();

      const createRow = () => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';
        return row;
      };

      function createBtn(id, label, title, onClick) {
        const button = document.createElement('button');
        button.id = id;
        button.textContent = label;
        button.title = title;
        button.style.cssText = `
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
        button.onmouseenter = () => {
          if (!button.disabled) {
            button.style.background = '#444';
          }
        };
        button.onmouseleave = () => {
          if (button.dataset.active === 'true') {
            button.style.background = '#FB7299';
            button.style.borderColor = '#FB7299';
          } else {
            button.style.background = '#333';
          }
        };
        button.onclick = onClick;
        return button;
      }

      const row1 = createRow();
      const btnStart = createBtn('adskipper-btn-start', '开始', '标记开始时间', () => {
        const current = self.player.getState().currentTime;
        self.pendingStart = current;
        btnStart.dataset.active = 'true';
        btnStart.style.background = '#FB7299';
        btnStart.style.borderColor = '#FB7299';
        self.updateButtonStates();
        self.showToast('开始: ' + current.toFixed(1) + 's', 'info');
      });

      const btnEnd = createBtn('adskipper-btn-end', '结束', '标记结束时间', () => {
        const current = self.player.getState().currentTime;
        if (self.pendingStart !== null && current <= self.pendingStart) {
          self.showToast('结束时间必须大于开始时间', 'error');
          return;
        }
        self.pendingEnd = current;
        btnEnd.dataset.active = 'true';
        btnEnd.style.background = '#FB7299';
        btnEnd.style.borderColor = '#FB7299';
        self.updateButtonStates();
        self.showToast('结束: ' + current.toFixed(1) + 's', 'info');
      });
      btnEnd.disabled = true;
      btnEnd.style.opacity = '0.5';
      btnEnd.style.cursor = 'not-allowed';
      row1.appendChild(btnStart);
      row1.appendChild(btnEnd);

      const row2 = createRow();
      const selectType = document.createElement('select');
      selectType.id = 'adskipper-type';
      selectType.style.cssText = 'width:100%;height:32px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:0 6px;font-size:0.9em;outline:none;cursor:pointer;';
      const types = [
        { val: 'hard_ad', text: '硬广' },
        { val: 'soft_ad', text: '软广' },
        { val: 'product_placement', text: '植入' },
        { val: 'intro_ad', text: '片头' },
        { val: 'mid_ad', text: '中段' }
      ];
      types.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.val;
        option.textContent = item.text;
        selectType.appendChild(option);
      });
      selectType.onchange = (event) => {
        self.pendingType = event.target.value;
      };
      row2.appendChild(selectType);

      const row3 = createRow();
      const btnSubmit = createBtn('adskipper-btn-submit', '提交标注', '提交到服务器', async () => {
        if (self.pendingStart === null || self.pendingEnd === null) return;

        const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
        if (!storage.adskipper_token) {
          self.showToast('请先登录插件', 'error');
          return;
        }

        btnSubmit.textContent = '提交中...';
        try {
          await self.submitAnnotation(self.pendingStart, self.pendingEnd, self.pendingType);
          self.showToast('提交成功 +10分', 'success');

          self.pendingStart = null;
          self.pendingEnd = null;
          btnStart.dataset.active = 'false';
          btnEnd.dataset.active = 'false';
          btnStart.style.background = '#333';
          btnEnd.style.background = '#333';
          btnStart.style.borderColor = '#555';
          btnEnd.style.borderColor = '#555';
          self.updateButtonStates();
          btnSubmit.textContent = '提交标注';
          self.togglePopover(false);
        } catch (error) {
          self.showToast('提交失败: ' + error.message, 'error');
          btnSubmit.textContent = '提交标注';
        }
      });
      btnSubmit.disabled = true;
      btnSubmit.style.opacity = '0.5';
      btnSubmit.style.cursor = 'not-allowed';

      const btnDelete = createBtn('adskipper-btn-delete', '删除最近', '删除最近一条标注', async () => {
        if (!self.currentSegmentIds.length) {
          self.showToast('暂无可删除标注', 'error');
          return;
        }

        const targetId = self.currentSegmentIds[self.currentSegmentIds.length - 1];
        const confirmed = await self.showConfirmDialog('确认删除', `删除最近标注 ID: ${targetId} ?`);
        if (!confirmed) return;

        btnDelete.textContent = '删除中...';
        btnDelete.disabled = true;
        btnDelete.style.opacity = '0.5';

        try {
          await self.deleteAnnotation(targetId);
          await self.loadSegments(self.player.currentBvid);
          self.showToast('删除成功', 'success');
          self.togglePopover(false);
        } catch (error) {
          self.showToast('删除失败: ' + error.message, 'error');
        } finally {
          btnDelete.textContent = '删除最近';
          self.updateButtonStates();
        }
      });

      if (!self.currentSegmentIds.length) {
        btnDelete.disabled = true;
        btnDelete.style.opacity = '0.5';
        btnDelete.style.cursor = 'not-allowed';
      }

      row3.appendChild(btnSubmit);
      row3.appendChild(btnDelete);

      const previewRow = createRow();
      previewRow.style.justifyContent = 'center';
      const preview = document.createElement('span');
      preview.id = 'adskipper-preview';
      preview.style.cssText = 'color:#FB7299;font-size:0.85em;min-height:1.2em;';
      previewRow.appendChild(preview);

      popover.appendChild(row1);
      popover.appendChild(row2);
      popover.appendChild(row3);
      popover.appendChild(previewRow);
      wrapper.appendChild(toggleBtn);
      wrapper.appendChild(popover);

      if (target.firstChild) {
        target.insertBefore(wrapper, target.firstChild);
      } else {
        target.appendChild(wrapper);
      }

      const playerContainer = document.querySelector('.bpx-player-container') || document.querySelector('#bilibili-player');
      if (playerContainer) {
        const resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect.width < 600) {
              wrapper.classList.add('is-compact');
            } else {
              wrapper.classList.remove('is-compact');
            }
          }
        });
        resizeObserver.observe(playerContainer);
      }

      if (this.previewInterval) clearInterval(this.previewInterval);
      this.previewInterval = setInterval(() => {
        const previewElement = document.getElementById('adskipper-preview');
        if (!previewElement) return;

        if (self.pendingStart !== null && self.pendingEnd !== null) {
          const duration = (self.pendingEnd - self.pendingStart).toFixed(1);
          previewElement.textContent = `已选 ${duration}s`;
          return;
        }

        if (self.pendingStart !== null) {
          previewElement.textContent = `从 ${self.pendingStart.toFixed(1)}s 开始...`;
          return;
        }

        previewElement.textContent = '';
      }, 200);
    }

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

    // 调用删除 API
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

      console.log('[AdSkipper] Submit annotation:', body);
      const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
      const token = storage.adskipper_token;
      console.log('[AdSkipper] Token status:', token ? 'present' : 'missing');

      const headers = { "Content-Type": "application/json" };
      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
        console.log('[AdSkipper] Authorization Header:', 'Bearer ' + token.substring(0, 20) + '...');
      } else {
        console.warn('[AdSkipper] Warning: request sent without token');
      }

      console.log('[AdSkipper] Request headers:', headers);

      const res = await fetch(API_BASE + "/segments", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        let errorMsg = 'Submit failed';
        try {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
          console.error('[AdSkipper] Server error:', data);
        } catch (e) {
          console.error('[AdSkipper] Failed to parse response:', res.status, res.statusText);
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
      t.innerHTML = `<span>${msg}</span>`;

      const color = type === 'success' ? '#67c23a' : (type === 'error' ? '#ff6b6b' : '#FB7299');
      t.style.cssText = `
        position: fixed;
        top: 15%;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: ${color};
        color: #fff;
        padding: 0.8em 1.5em;
        border-radius: 0.5em;
        z-index: 999999;
        font-size: clamp(14px, 2vw, 18px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        opacity: 0;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      `;

      document.body.appendChild(t);

      // Animate in
      requestAnimationFrame(() => {
        t.style.opacity = '1';
        t.style.transform = 'translateX(-50%) translateY(0)';
      });

      // Animate out and remove
      setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => t.remove(), 300);
      }, 3000);
    }

    showSkipNotification(ad) {
      const duration = (ad.end_time - ad.start_time).toFixed(1);

      // Create notification container
      const container = document.createElement('div');
      container.style.cssText = `
        position: fixed;
        top: 10%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        text-align: center;
      `;

      // Toast message
      const toast = document.createElement('div');
      toast.style.cssText = `
        background: #67c23a;
        color: #fff;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: bold;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        animation: slideDown 0.4s ease-out;
      `;
      toast.innerHTML = `✓ Auto skipped ${duration}s`;

      // Progress bar
      const progress = document.createElement('div');
      progress.style.cssText = `
        width: 100%;
        height: 3px;
        background: rgba(255,255,255,0.3);
        margin-top: 8px;
        border-radius: 2px;
        overflow: hidden;
      `;

      const progressBar = document.createElement('div');
      progressBar.style.cssText = `
        height: 100%;
        background: #fff;
        width: 100%;
        animation: progress 2s linear forwards;
      `;

      progress.appendChild(progressBar);
      toast.appendChild(progress);
      container.appendChild(toast);
      document.body.appendChild(container);

      // Add animation keyframes
      if (!document.getElementById('toast-animations')) {
        const style = document.createElement('style');
        style.id = 'toast-animations';
        style.textContent = `
          @keyframes slideDown {
            0% { transform: translateY(-20px); opacity: 0; }
            100% { transform: translateY(0); opacity: 1; }
          }
          @keyframes progress {
            0% { width: 100%; }
            100% { width: 0%; }
          }
          @keyframes slideUp {
            0% { transform: translateY(0); opacity: 1; }
            100% { transform: translateY(-20px); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }

      // Auto remove
      setTimeout(() => {
        toast.style.animation = 'slideUp 0.3s ease-out forwards';
        setTimeout(() => container.remove(), 300);
      }, 2000);
    }

    showSkipButton(ad) {
      // 1. 双重重复防护：实例级别检查
      if (this.skipButton) return;
      // 2. 双重重复防护：DOM 级别检查
      if (document.getElementById('adskipper-skip-btn')) return;

      const self = this;

      // 3. 精准挂载容器选择，优先挂到视频画面容器，避免控制栏
      // 优先级：.bpx-player-video-wrap > .bpx-player-video-area > fallback
      let playerContainer = document.querySelector('.bpx-player-video-wrap') ||
        document.querySelector('.bpx-player-video-area') ||
        document.querySelector('.bpx-player-container') ||
        document.querySelector('#bilibili-player');

      if (!playerContainer) {
        console.log('[AdSkipper] Video container not found');
        return;
      }

      // 4. 确保父容器有相对定位（子绝父相）
      if (getComputedStyle(playerContainer).position === 'static') {
        playerContainer.style.position = 'relative';
      }

      const btn = document.createElement('div');
      btn.id = 'adskipper-skip-btn';
      btn.textContent = '跳过广告';
      // 5. 响应式 CSS 定位：使用像素值 + !important 确保位于视频右下角
      // 默认 bottom: 60px，在全屏模式下动态调整
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

      // 监听播放器容器的 class 变化（全屏状态通常通过 class 变化体现）
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
        self.showToast('Skipped ' + (ad.end_time - ad.start_time).toFixed(1) + 's', 'success');
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

    addSegmentMarkers() {
      const oldMarkers = document.querySelectorAll('.adskipper-progress-marker');
      oldMarkers.forEach(marker => marker.remove());

      if (!this.segments.length) {
        return;
      }

      const progressContainer = document.querySelector('.bpx-player-progress') ||
        document.querySelector('.bilibili-player-progress') ||
        document.querySelector('.bpx-player-progress-wrap');
      if (!progressContainer) {
        return;
      }

      const duration = this.player.getState().duration;
      if (!duration || duration <= 0) {
        return;
      }

      const progressSlide = progressContainer.querySelector('.bpx-player-progress-slide') ||
        progressContainer.querySelector('.bili-progress-slip') ||
        progressContainer.querySelector('.bpx-player-progress-buffer');
      if (!progressSlide) {
        return;
      }

      progressSlide.style.position = progressSlide.style.position || 'relative';

      this.segments.forEach((segment, index) => {
        const startPercent = (segment.start_time / duration) * 100;
        const endPercent = (segment.end_time / duration) * 100;
        const width = Math.max(endPercent - startPercent, 0.8);

        const marker = document.createElement('div');
        marker.className = 'adskipper-progress-marker';
        marker.setAttribute('data-segment-id', this.getSegmentKey(segment, index));

        const markerColor = segment.action === 'popup'
          ? 'rgba(71, 167, 255, 0.88)'
          : 'rgba(251, 114, 153, 0.82)';

        marker.style.cssText = `
          position: absolute;
          left: ${startPercent}%;
          top: 0;
          bottom: 0;
          width: ${width}%;
          background: ${markerColor} !important;
          pointer-events: none;
          z-index: 999 !important;
          height: 100% !important;
        `;

        const titleContent = segment.action === 'popup' && segment.content
          ? ` | ${segment.content.slice(0, 36)}`
          : '';
        marker.title = `${segment.start_time.toFixed(1)}s - ${segment.end_time.toFixed(1)}s | ${segment.action}${titleContent}`;

        progressSlide.appendChild(marker);
      });
    }

    handleShowMarkers() {
      const safeSegments = Array.isArray(this.segments) ? this.segments : [];
      if (!safeSegments.length) {
        this.showToast('No segments found for this video', 'info');
      }

      const existingPanel = document.getElementById('adskipper-segment-panel');
      if (existingPanel) {
        existingPanel.remove();
        return;
      }

      const panel = document.createElement('div');
      panel.id = 'adskipper-segment-panel';
      panel.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: min(420px, 88vw);
        max-height: 64vh;
        background: #131d30;
        border-radius: 12px;
        box-shadow: 0 10px 36px rgba(0,0,0,0.52);
        border: 1px solid rgba(99, 169, 255, 0.35);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        font-family: "Segoe UI", "PingFang SC", sans-serif;
      `;

      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: rgba(65, 146, 255, 0.10);
      `;
      header.innerHTML = `
        <span style="color: #9fd2ff; font-weight: 700; font-size: 15px;">AI 片段列表 (${safeSegments.length})</span>
        <button id="adskipper-close-panel" style="background:none;border:none;color:#b8cee6;font-size:20px;cursor:pointer;">×</button>
      `;

      const summaryBlock = document.createElement('div');
      summaryBlock.style.cssText = `
        margin: 10px 10px 0;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(255,255,255,0.06);
        color: #cfe1ff;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        max-height: 120px;
        overflow-y: auto;
      `;
      summaryBlock.textContent = this.aiSummary || '暂无 AI 总结';

      const list = document.createElement('div');
      list.id = 'adskipper-segment-list';
      list.style.cssText = 'overflow-y:auto;flex:1;padding:10px;display:flex;flex-direction:column;gap:8px;';

      safeSegments.forEach((segment, index) => {
        const item = document.createElement('div');
        item.style.cssText = `
          display:flex;
          flex-direction:column;
          gap:8px;
          padding:10px;
          background:rgba(255,255,255,0.04);
          border-radius:8px;
          border-left:4px solid ${segment.action === 'popup' ? '#4aa8ff' : '#fb7299'};
        `;

        const actionLabel = segment.action === 'popup' ? '重点弹窗' : '自动跳过';
        const content = segment.action === 'popup' ? (segment.content || '该片段暂无文案') : '该片段默认执行跳过';
        const segmentId = segment.id;
        const canDelete = Number.isFinite(Number(segmentId)) && Number(segmentId) > 0;

        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div style="color:#fff;font-size:13px;">
              <span style="color:#9fd2ff;">${segment.start_time.toFixed(1)}s</span> -
              <span style="color:#9fd2ff;">${segment.end_time.toFixed(1)}s</span>
            </div>
            <span style="font-size:11px;color:#d8ecff;background:${segment.action === 'popup' ? 'rgba(74,168,255,.35)' : 'rgba(251,114,153,.35)'};padding:2px 7px;border-radius:99px;">
              ${actionLabel}
            </span>
          </div>
          <div style="font-size:12px;color:#c3d8ee;line-height:1.45;">${content}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button data-index="${index}" class="adskipper-jump-btn" style="padding:5px 12px;background:#4aa8ff;border:none;border-radius:4px;color:#fff;font-size:12px;cursor:pointer;">跳转</button>
            <button data-id="${canDelete ? segmentId : ''}" class="adskipper-delete-btn" ${canDelete ? '' : 'disabled'} style="padding:5px 12px;background:${canDelete ? '#42546f' : '#374255'};border:none;border-radius:4px;color:${canDelete ? '#fff' : '#8898ad'};font-size:12px;cursor:${canDelete ? 'pointer' : 'not-allowed'};">删除</button>
          </div>
        `;

        list.appendChild(item);
      });

      if (!safeSegments.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 16px 10px; text-align: center; color: #9fb6d8; font-size: 12px;';
        empty.textContent = '当前视频暂无可用片段';
        list.appendChild(empty);
      }

      panel.appendChild(header);
      panel.appendChild(summaryBlock);
      panel.appendChild(list);
      document.body.appendChild(panel);

      document.getElementById('adskipper-close-panel').onclick = () => panel.remove();

      document.querySelectorAll('.adskipper-jump-btn').forEach(button => {
        button.onclick = () => {
          const index = Number(button.getAttribute('data-index'));
          const segment = safeSegments[index];
          this.seekToSegmentStart(segment);
          this.showToast(`跳转到 ${segment.start_time.toFixed(1)}s`, 'success');
        };
      });

      document.querySelectorAll('.adskipper-delete-btn').forEach(button => {
        button.onclick = async () => {
          const rawId = button.getAttribute('data-id');
          const deleteId = Number(rawId);
          if (!Number.isFinite(deleteId) || deleteId <= 0) {
            this.showToast('当前片段不支持删除', 'info');
            return;
          }

          if (!confirm(`确定删除标注 ${deleteId} 吗？`)) return;

          try {
            await this.deleteAnnotation(deleteId);
            this.segments = this.segments.filter(item => Number(item.id) !== deleteId);
            sidebarState.segments = this.segments;
            this.currentSegmentIds = this.currentSegmentIds.filter(id => Number(id) !== deleteId);
            button.closest('div').parentElement.remove();

            const titleSpan = header.querySelector('span');
            titleSpan.textContent = `AI 片段列表 (${this.segments.length})`;

            this.showToast('删除成功', 'success');
            if (this.segments.length === 0) {
              panel.remove();
            }
          } catch (error) {
            this.showToast('删除失败: ' + error.message, 'error');
          }
        };
      });

      this.showToast(`已显示 ${safeSegments.length} 条片段`, 'success');
    }
  }

  new AdSkipperCore().init();
})();


