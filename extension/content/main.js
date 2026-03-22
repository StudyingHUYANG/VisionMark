(function () {
  'use strict';

  if (window.adSkipper) return;

  // Sidebar state (will be initialized when sidebar loads)
  let sidebarState = null;

  // API 基础路径
  const API_BASE = window.API_BASE || 'http://localhost:8080/api/v1';
  const VIDEO_ANALYSIS_BASE = window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080';
  const DANMU_TRIGGER_WINDOW_SEC = 0.3;
  const DANMU_REWIND_RESET_SEC = 1.0;
  const DANMU_MAX_CONCURRENT = 3;
  const DANMU_BASE_DURATION_SEC = 7.5;
  const DANMU_FALLBACK_TRACK_PX = 640;
  const DANMU_NATIVE_SAMPLE_MS = 300;
  const DANMU_SPEED_MIN_PX_PER_SEC = 60;
  const DANMU_SPEED_MAX_PX_PER_SEC = 1200;
  const DANMU_SPEED_TUNE_FACTOR = 0.78;
  const DANMU_REMOVE_BUFFER_PX = 32;
  const DANMU_LANE_MIN_PERCENT = 6;
  const DANMU_LANE_MAX_PERCENT = 25;
  const DANMU_LANE_STEP_PERCENT = 4;
  const DANMU_DEFAULT_LANES = [8, 14, 20, 24];
  const DANMU_NATIVE_NODE_SELECTORS = [
    '.bpx-player-dm-wrap .bili-dm',
    '.bpx-player-dm-wrap [class*="dm"][class*="item"]',
    '.bilibili-player-video-danmaku [class*="danmaku"]'
  ];

  // 分段类型标签映射
  const typeLabels = {
    'hard_ad': '商业内容',
    'soft_ad': '推广内容',
    'product_placement': '品牌植入',
    'intro_ad': '片头广告',
    'mid_ad': '中段广告'
  };

  class AdSkipperCore {
    constructor() {
      this.player = new BilibiliPlayerController();
      this.sidebarController = null;
      this.segments = [];
      this.allSegments = [];
      this.aiSummary = '';
      this.lastSkipTime = 0;
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
      this.networkState = {
        offlineUntil: 0,
        hasLoggedOffline: false,
        wasOffline: false
      };
      this.networkCooldownMs = 30000;
      this.networkTimeoutMs = 6000;
      this.analysisBvid = null;
      this.knowledgeDanmuQueue = [];
      this.triggeredDanmuIds = new Set();
      this.knowledgeDanmuLayer = null;
      this.lastDanmuCurrentTime = 0;
      this.nextDanmuLane = 0;
      this.activeKnowledgeDanmus = [];
      this.knowledgeDanmuRafId = null;
      this.lastDanmuFrameTs = 0;
      this.nativeDanmuSpeedPxPerSec = 0;
      this.lastNativeSpeedSampleTs = 0;
      this.progressHoverCleanup = null;
      this.progressHoverTarget = null;
      this.progressHoverCard = null;
      this.hoveredSegmentKey = null;
      this.segmentMarkerRetryTimer = null;
      
      this.hotWordPopupLayer = null;
      this.currentHotWordId = null;
    }

    init() {
      console.log("[AdSkipper] 初始化...");
      
      // 1. Load preferences
      this.initPrefs();

      // 2. Start UI Keeper to ensure buttons persist
      this.startUiKeeper();

      // 3. Init global event listeners
      this.initGlobalListeners();

      // 4. Initialize player connection
      this.player.init().then(ok => {
        if (!ok) {
           console.log('[AdSkipper] 暂未找到播放器，Keeper将继续尝试');
           return;
        }
        this.onPlayerReady();
      });
    }

    initPrefs() {
        chrome.storage.local.get(['adskipper_token'], (s) => console.log('[AdSkipper] 登录状态:', s.adskipper_token ? '已登录' : '未登录'));
        chrome.storage.local.get(['skip_mode'], (s) => {
            this.skipMode = s.skip_mode || 'auto';
            console.log("[AdSkipper] 跳过模式:", this.skipMode);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.skip_mode) {
            this.skipMode = changes.skip_mode.newValue || 'auto';
            if (this.skipMode === 'auto') this.hideSkipButton();
          }
        });
    }

    startUiKeeper() {
        // Initial setup
        this.initAiFloatingButton();
        this.initSidebar().catch(e => console.error(e));

        // Periodic check loop
        setInterval(() => {
            const fab = document.getElementById('visionmark-ai-fab');
            if (!fab) {
                console.log('[AdSkipper] Keeper: Restore AI FAB');
                this.initAiFloatingButton();
            }
            
            const sidebarRoot = document.getElementById('vm-sidebar-root');
            if (!sidebarRoot) {
                // console.log('[AdSkipper] Keeper: Restore Sidebar Root'); // Reduce log noise
                this.initSidebar().catch(() => {});
            }

            // Restore segment markers if needed
            if (this.segments && this.segments.length > 0) {
                 const markers = document.querySelectorAll('.adskipper-progress-marker');
                 if (markers.length === 0) {
                     // Check if progress bar exists before trying to add
                     const progressBar = document.querySelector('.bpx-player-progress') || 
                                         document.querySelector('.bilibili-player-progress') ||
                                         document.querySelector('.bpx-player-progress-wrap');
                     if (progressBar) {
                        console.log('[AdSkipper] Keeper: Restore markers');
                        this.addSegmentMarkers();
                     }
                 }
            }
        }, 1500);
    }

    initGlobalListeners() {
      document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('adskipper-wrapper');
        if (wrapper && !wrapper.contains(e.target)) this.togglePopover(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.togglePopover(false);
          if (this.sidebarController) this.sidebarController.hide();
        }
      });
      window.addEventListener('visionmark:seek', (e) => {
        const time = Number(e?.detail?.time);
        if (Number.isFinite(time)) this.player.skipTo(Math.max(time, 0));
      });
      window.addEventListener('visionmark:refresh-ai', () => {
        if (this.player.currentBvid) {
           this.refreshAnalysisForBvid(this.player.currentBvid, { forceAnalyze: true });
        }
      });
      window.addEventListener('visionmark:delete-segment', (e) => this.handleSidebarDelete(Number(e?.detail?.segmentId)));
      
      window.adSkipperDebug = this;
      console.log('[AdSkipper] 调试模式已启用');
    }

    onPlayerReady() {
        console.log('[AdSkipper] Player Ready');
        this.player.onTimeUpdate = (t) => this.checkSkip(t);
        this.startInjectionObserver();
        
        const bvid = this.player.currentBvid;
        if (bvid) {
          this.refreshAnalysisForBvid(bvid).then(() => window.adSkipper = this);
        }
    }

    async initSidebar() {
      if (this.sidebarController) return;

      const { createSidebar, sidebarState: importedSidebarState } = await import('../sidebar/index.js');
      sidebarState = importedSidebarState;

      const existingRoot = document.getElementById('vm-sidebar-root');
      if (existingRoot) {
        this.sidebarController = createSidebar(existingRoot);
        return;
      }

      const root = document.createElement('div');
      root.id = 'vm-sidebar-root';
      document.body.appendChild(root);

      console.log('[AdSkipper Sidebar] 正在初始化侧边栏...');
      this.sidebarController = createSidebar(root);
    }

    initAiFloatingButton() {
      console.log("[AdSkipper] 创建AI浮动按钮...");

      if (!document.getElementById('visionmark-ai-fab-style')) {
        console.log("[AdSkipper] 添加AI按钮样式...");
        const style = document.createElement('style');
        style.id = 'visionmark-ai-fab-style';
        style.textContent = `
          #visionmark-ai-fab {
            position: fixed !important;
            left: 20px !important;
            top: 100px !important;
            z-index: 2147483647 !important;
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
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
          }
          #visionmark-ai-fab:hover {
            transform: translateY(-2px);
            box-shadow: 0 14px 34px rgba(251, 114, 153, 0.55);
          }
        `;
        document.head.appendChild(style);
        console.log('[AdSkipper] AI button style injected.');
      }

      if (document.getElementById('visionmark-ai-fab')) {
        console.log("[AdSkipper] AI按钮已存在，跳过创建");
        return;
      }

      console.log("[AdSkipper] 创建AI按钮DOM元素...");
      const button = document.createElement('button');
      button.id = 'visionmark-ai-fab';
      button.type = 'button';
      button.textContent = 'AI';
      button.title = '视频总结';
      button.setAttribute('aria-label', '视频总结');
      button.onclick = (event) => {
        event.stopPropagation();
        this.toggleSidebar().catch((error) => {
          console.error('[AdSkipper] 切换侧边栏失败:', error);
          this.showToast('视频总结面板加载失败', 'error');
        });
      };

      document.body.appendChild(button);
      console.log("[AdSkipper] AI按钮已创建并添加到body");

      // 验证按钮是否真的在DOM中并检查位置
      setTimeout(() => {
        const btn = document.getElementById('visionmark-ai-fab');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          console.log('[AdSkipper] AI button is present in DOM.');
          console.log("[AdSkipper] 位置信息:");
          console.log("  - 灏哄:", btn.offsetWidth, "x", btn.offsetHeight);
          console.log("  - 灞忓箷浣嶇疆:", rect.left, ",", rect.top);
          console.log("  - right/top:", rect.right, ",", rect.bottom);
          console.log("  - 在视口内:", rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth);
          console.log("  - z-index:", window.getComputedStyle(btn).zIndex);
        } else {
          console.error("[AdSkipper] 错误：AI按钮创建后未在DOM中找到！");
        }
      }, 100);
    }

    async ensureSidebarReady() {
      if (this.sidebarController) return true;
      try {
        await this.initSidebar();
      } catch (error) {
        console.error('[AdSkipper] ensureSidebarReady failed:', error);
      }
      return Boolean(this.sidebarController);
    }

    async refreshAnalysisForBvid(bvid, options = {}) {
      if (!bvid) return;
      await this.loadSegments(bvid);
      const shouldAnalyze = Boolean(options.forceAnalyze) || this.segments.length === 0 || !this.aiSummary;
      if (shouldAnalyze) {
        await this.analyzeVideo(bvid);
      }
    }

    async showSidebar(options = {}) {
      if (!await this.ensureSidebarReady()) return;

      if (options.refresh && this.player.currentBvid) {
        await this.refreshAnalysisForBvid(this.player.currentBvid, { forceAnalyze: true });
      }

      this.sidebarController.show();
    }

    async toggleSidebar() {
      if (!await this.ensureSidebarReady()) return;
      this.sidebarController.toggle();
    }

    async handleSidebarDelete(segmentId) {
      if (!Number.isFinite(segmentId) || segmentId <= 0) {
        this.showToast('当前片段不支持删除', 'info');
        return;
      }

      // Confirmation is now handled by Vue ConfirmDialog component
      // This method is called after user confirms deletion
      try {
        await this.deleteAnnotation(segmentId);
        if (this.player.currentBvid) {
          await this.loadSegments(this.player.currentBvid);
        }
        this.showToast('删除成功', 'success');
      } catch (error) {
        this.showToast('删除失败: ' + error.message, 'error');
      }
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

    createNetworkUnavailableError() {
      const error = new Error('网络不可用，请稍后重试');
      error.code = 'NETWORK_UNAVAILABLE';
      return error;
    }

    isNetworkFailure(error) {
      if (!error) return false;
      if (error.name === 'AbortError') return true;
      const message = String(error.message || '').toLowerCase();
      if (message.includes('failed to fetch') || message.includes('networkerror') || message.includes('load failed')) {
        return true;
      }
      return error instanceof TypeError;
    }

    markNetworkOffline(context, error) {
      this.networkState.offlineUntil = Date.now() + this.networkCooldownMs;
      this.networkState.wasOffline = true;
      if (!this.networkState.hasLoggedOffline) {
        console.warn(`[AdSkipper] 后端在 ${context} 时不可达，暂停请求 30 秒。`, error);
        this.networkState.hasLoggedOffline = true;
      }
    }

    markNetworkOnline() {
      if (this.networkState.wasOffline) {
        console.info('[AdSkipper] 后端连接已恢复');
      }
      this.networkState.offlineUntil = 0;
      this.networkState.hasLoggedOffline = false;
      this.networkState.wasOffline = false;
    }

    async safeFetch(url, options = {}, context = 'request') {
      const now = Date.now();

      // 检查网络冷却状态
      if (now < this.networkState.offlineUntil) {
        const remainingSec = Math.ceil((this.networkState.offlineUntil - now) / 1000);
        console.warn(`[AdSkipper] safeFetch: 网络冷却中，还需等待 ${remainingSec} 秒`);
        throw this.createNetworkUnavailableError();
      }

      console.log(`[AdSkipper] safeFetch: 开始请求 ${context}`);
      console.log(`[AdSkipper] safeFetch: URL = ${url}`);
      console.log(`[AdSkipper] safeFetch: 超时设置 = ${this.networkTimeoutMs}ms`);

      const controller = options.signal ? null : new AbortController();
      const timeoutId = setTimeout(() => {
        if (controller) {
          console.warn(`[AdSkipper] safeFetch: 请求超时 (${this.networkTimeoutMs}ms)`);
          controller.abort();
        }
      }, this.networkTimeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: options.signal || (controller ? controller.signal : undefined)
        });
        clearTimeout(timeoutId);
        this.markNetworkOnline();
        console.log(`[AdSkipper] safeFetch: 请求成功，状态 = ${response.status}`);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[AdSkipper] safeFetch: 请求失败`, error);
        if (this.isNetworkFailure(error)) {
          this.markNetworkOffline(context, error);
          throw this.createNetworkUnavailableError();
        }
        throw error;
      }
    }

    async loadSegments(bvid) {
      if (!bvid || this.isLoadingSegments) return;
      const previousAnalysisBvid = this.analysisBvid;
      this.isLoadingSegments = true;
      if (sidebarState) {
        sidebarState.isLoading = true;
        sidebarState.loadError = null;
      }

      try {
        const storage = await new Promise(r => chrome.storage.local.get(['skip_types'], r));
        const skipTypes = storage.skip_types || ['hard_ad', 'soft_ad', 'product_placement'];

        const url = API_BASE + "/segments?bvid=" + bvid + "&page=" + this.getPage();
        const res = await this.safeFetch(url, {}, 'load segments');
        if (!res.ok) {
          throw new Error('加载片段失败：' + res.status);
        }

        const data = await res.json();
        console.log("[AdSkipper] 后端返回的数据结构:", Object.keys(data));
        console.log("[AdSkipper] data.ai_title:", data.ai_title);
        console.log("[AdSkipper] data.knowledge_points:", data.knowledge_points);
        console.log("[AdSkipper] data.hot_words:", data.hot_words);

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
        this.analysisBvid = bvid;
        if (Array.isArray(data.knowledge_points)) {
          this.updateKnowledgeDanmuSource(data.knowledge_points, bvid);
        } else if (previousAnalysisBvid && previousAnalysisBvid !== bvid) {
          this.clearKnowledgeDanmuState();
        }
        if (sidebarState) {
          sidebarState.bvid = bvid;
          sidebarState.cid = this.player.currentCid || null;

          sidebarState.aiSummary = this.aiSummary || '暂无总结';
          // 确保其他AI分析信息也被保留（如果后端返回了这些字段）
          if (data.ai_title !== undefined) {
            sidebarState.aiTitle = data.ai_title || '';
          }
          if (data.knowledge_points !== undefined) {
            sidebarState.knowledgePoints = data.knowledge_points || [];
          }
          if (data.hot_words !== undefined) {
            sidebarState.hotWords = data.hot_words || [];
          }
          sidebarState.segments = this.segments;
          sidebarState.activeSegmentKey = null;

          console.log("[AdSkipper] 侧边栏状态更新后:");
          console.log("  - aiTitle:", sidebarState.aiTitle);
          console.log("  - aiSummary:", sidebarState.aiSummary?.substring(0, 50));
          console.log("  - knowledgePoints:", sidebarState.knowledgePoints);
          console.log("  - hotWords:", sidebarState.hotWords);
          console.log("  - isLoading:", sidebarState.isLoading);
          console.log("  - loadError:", sidebarState.loadError);
        }

        this.addSegmentMarkers();
      this.scheduleSegmentMarkerRetry(2);
      } catch (error) {
        if (error.code !== 'NETWORK_UNAVAILABLE') {
          console.error('[AdSkipper] 加载片段失败:', error);
        }
        this.segments = [];
        this.allSegments = [];
        this.currentSegmentIds = [];
        if (sidebarState) {
          sidebarState.bvid = bvid;
          sidebarState.cid = this.player.currentCid || null;
          sidebarState.segments = [];
          sidebarState.aiSummary = '总结加载失败';
          sidebarState.loadError = error.message || '加载失败';
        }
      } finally {
        this.isLoadingSegments = false;
        if (sidebarState) {
          sidebarState.isLoading = false;
        }
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

    ensureProgressHoverCardStyle() {
      if (document.getElementById('visionmark-progress-hover-style')) return;

      const style = document.createElement('style');
      style.id = 'visionmark-progress-hover-style';
      style.textContent = `
        #visionmark-progress-hover-card {
          position: fixed;
          z-index: 2147483647;
          width: min(320px, calc(100vw - 24px));
          padding: 14px 16px;
          border-radius: 16px;
          color: #fff;
          background: linear-gradient(145deg, rgba(20, 20, 28, 0.96), rgba(31, 31, 44, 0.92));
          box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
          border: 1px solid rgba(255, 255, 255, 0.14);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          pointer-events: none;
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        #visionmark-progress-hover-card.is-visible {
          opacity: 1;
          transform: translateY(0);
        }
        .visionmark-progress-hover__eyebrow {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.82);
        }
        .visionmark-progress-hover__badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.3px;
          color: #fff;
        }
        .visionmark-progress-hover__badge--popup {
          background: linear-gradient(135deg, #47a7ff, #6fc1ff);
        }
        .visionmark-progress-hover__badge--skip {
          background: linear-gradient(135deg, #fb7299, #ff9a8b);
        }
        .visionmark-progress-hover__title {
          margin: 0 0 8px;
          font-size: 14px;
          line-height: 1.55;
          font-weight: 600;
          color: #fff;
          word-break: break-word;
        }
        .visionmark-progress-hover__detail-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .visionmark-progress-hover__detail-item {
          padding: 8px 10px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.08);
          font-size: 12px;
          line-height: 1.55;
          color: rgba(255, 255, 255, 0.9);
          word-break: break-word;
        }
      `;
      document.head.appendChild(style);
    }

    getProgressHoverCard() {
      this.ensureProgressHoverCardStyle();

      let card = document.getElementById('visionmark-progress-hover-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'visionmark-progress-hover-card';
        document.body.appendChild(card);
      }

      this.progressHoverCard = card;
      return card;
    }

    hideProgressHoverCard() {
      this.hoveredSegmentKey = null;
      if (this.progressHoverCard) {
        this.progressHoverCard.classList.remove('is-visible');
      }
    }

    cleanupProgressHover() {
      if (typeof this.progressHoverCleanup === 'function') {
        this.progressHoverCleanup();
      }
      this.progressHoverCleanup = null;
      this.progressHoverTarget = null;
      this.hideProgressHoverCard();
    }

    formatTimeLabel(seconds) {
      const safeSeconds = Math.max(0, Number(seconds) || 0);
      const wholeSeconds = Math.floor(safeSeconds);
      const hours = Math.floor(wholeSeconds / 3600);
      const minutes = Math.floor((wholeSeconds % 3600) / 60);
      const secs = wholeSeconds % 60;

      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
      return `${minutes}:${String(secs).padStart(2, '0')}`;
    }

    findSegmentByTime(timeSec) {
      if (!Number.isFinite(timeSec) || !Array.isArray(this.segments) || !this.segments.length) return null;

      const exactMatch = this.segments.find(segment => timeSec >= segment.start_time && timeSec <= segment.end_time);
      if (exactMatch) return exactMatch;

      const duration = Number(this.player?.getState?.().duration) || 0;
      const maxSnapDistance = duration > 0
        ? Math.min(24, Math.max(8, duration * 0.05))
        : 12;

      let nearestSegment = null;
      let nearestDistance = Infinity;
      for (const segment of this.segments) {
        const distance = Math.min(
          Math.abs(timeSec - segment.start_time),
          Math.abs(timeSec - segment.end_time)
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestSegment = segment;
        }
      }

      return nearestDistance <= maxSnapDistance ? nearestSegment : null;
    }

    getKnowledgeDetailsForRange(segment) {
      if (!segment || !Array.isArray(this.knowledgeDanmuQueue) || !this.knowledgeDanmuQueue.length) {
        return [];
      }

      const rangePadding = 4;
      const matched = this.knowledgeDanmuQueue.filter(item =>
        item.timeSec >= (segment.start_time - rangePadding) && item.timeSec <= (segment.end_time + rangePadding)
      );

      return matched.slice(0, 3).map(item => {
        const prefix = item.type === 'hot-word' ? '热词' : '知识点';
        return `${prefix} ${this.formatTimeLabel(item.timeSec)}  ${item.text}`;
      });
    }

    getSegmentHoverDetails(segment) {
      if (!segment) return [];

      const details = [];
      if (segment.content) {
        details.push(segment.content.trim());
      }

      const knowledgeDetails = this.getKnowledgeDetailsForRange(segment);
      knowledgeDetails.forEach(item => {
        if (!details.includes(item)) {
          details.push(item);
        }
      });

      if (!details.length && this.aiSummary) {
        details.push(this.aiSummary.trim());
      }

      return details.slice(0, 3);
    }

    findNativeProgressPreview() {
      const selectors = [
        '.bpx-player-progress-preview',
        '.bpx-player-progress-thumbnail',
        '.bpx-player-progress-detail',
        '.bilibili-player-video-progress-detail',
        '.bilibili-player-video-progress-thumbnail',
        '[class*="progress-preview"]',
        '[class*="progress-thumbnail"]'
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;

        const rect = element.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(element);
        if (rect.width > 20 && rect.height > 20 && computedStyle.visibility !== 'hidden' && computedStyle.display !== 'none') {
          return { element, rect };
        }
      }

      return null;
    }

    positionProgressHoverCard(card, anchorClientX, progressRect) {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const preview = this.findNativeProgressPreview();
      const cardRect = card.getBoundingClientRect();
      const gap = 16;

      let left = Math.min(anchorClientX + gap, viewportWidth - cardRect.width - 12);
      let top = progressRect.top - cardRect.height - 22;

      if (preview?.rect) {
        const previewRect = preview.rect;
        left = previewRect.right + 18;
        top = previewRect.top + Math.max(0, (previewRect.height - cardRect.height) / 2);

        if (left + cardRect.width > viewportWidth - 12) {
          left = previewRect.left - cardRect.width - 18;
        }
      }

      if (left < 12) {
        left = 12;
      }
      if (top < 12) {
        top = Math.min(progressRect.bottom + 18, viewportHeight - cardRect.height - 12);
      }
      if (top + cardRect.height > viewportHeight - 12) {
        top = Math.max(12, viewportHeight - cardRect.height - 12);
      }

      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    showProgressHoverCard(segment, anchorClientX, progressRect) {
      const details = this.getSegmentHoverDetails(segment);
      if (!details.length) {
        this.hideProgressHoverCard();
        return;
      }

      const card = this.getProgressHoverCard();
      const segmentKey = this.getSegmentKey(segment);
      const isPopup = segment.action === 'popup';
      const badgeText = isPopup ? '重点' : '跳过';
      const titleText = this.escapeHtml(details[0]);
      const extraDetails = details.slice(1);
      const timeLabel = `${this.formatTimeLabel(segment.start_time)} - ${this.formatTimeLabel(segment.end_time)}`;

      if (this.hoveredSegmentKey !== segmentKey) {
        card.innerHTML = `
          <div class="visionmark-progress-hover__eyebrow">
            <span class="visionmark-progress-hover__badge ${isPopup ? 'visionmark-progress-hover__badge--popup' : 'visionmark-progress-hover__badge--skip'}">${badgeText}</span>
            <span>${this.escapeHtml(timeLabel)}</span>
          </div>
          <p class="visionmark-progress-hover__title">${titleText}</p>
          ${extraDetails.length ? `
            <div class="visionmark-progress-hover__detail-list">
              ${extraDetails.map(text => `<div class="visionmark-progress-hover__detail-item">${this.escapeHtml(text)}</div>`).join('')}
            </div>
          ` : ''}
        `;
        this.hoveredSegmentKey = segmentKey;
      }

      card.classList.add('is-visible');
      this.positionProgressHoverCard(card, anchorClientX, progressRect);
    }

    bindProgressHover(progressContainer, progressSlide, duration) {
      const hoverTargets = [progressContainer, progressSlide].filter(Boolean);
      if (!hoverTargets.length || !Number.isFinite(duration) || duration <= 0) return;
      if (this.progressHoverTarget === hoverTargets[0]) return;

      this.cleanupProgressHover();
      this.progressHoverTarget = hoverTargets[0];

      const resolveHoverRect = () => {
        const containerRect = progressContainer?.getBoundingClientRect?.();
        if (containerRect && containerRect.width > 0) return containerRect;
        const slideRect = progressSlide?.getBoundingClientRect?.();
        if (slideRect && slideRect.width > 0) return slideRect;
        return null;
      };

      const isWithinHoverZone = (event, rect) => {
        if (!rect?.width) return false;

        const preview = this.findNativeProgressPreview();
        const previewRect = preview?.rect || null;
        const zoneLeft = Math.min(rect.left, previewRect?.left ?? rect.left);
        const zoneRight = Math.max(rect.right, previewRect?.right ?? rect.right);
        const zoneTop = Math.min(rect.top - 160, previewRect ? previewRect.top - 24 : rect.top - 160);
        const zoneBottom = Math.max(rect.bottom + 28, previewRect ? previewRect.bottom + 24 : rect.bottom + 28);

        return event.clientX >= zoneLeft && event.clientX <= zoneRight && event.clientY >= zoneTop && event.clientY <= zoneBottom;
      };

      const handleHoverMove = (event) => {
        const rect = resolveHoverRect();
        if (!rect?.width) return;

        if (!isWithinHoverZone(event, rect)) {
          this.hideProgressHoverCard();
          return;
        }

        const percent = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const currentTime = percent * duration;
        const segment = this.findSegmentByTime(currentTime);

        if (!segment) {
          this.hideProgressHoverCard();
          return;
        }

        this.showProgressHoverCard(segment, event.clientX, rect);
      };

      const handleMouseLeave = () => {
        this.hideProgressHoverCard();
      };

      hoverTargets.forEach(target => {
        target.addEventListener('mousemove', handleHoverMove);
        target.addEventListener('mouseleave', handleMouseLeave);
      });
      document.addEventListener('mousemove', handleHoverMove, true);
      window.addEventListener('blur', handleMouseLeave);
      document.addEventListener('scroll', handleMouseLeave, true);

      this.progressHoverCleanup = () => {
        hoverTargets.forEach(target => {
          target.removeEventListener('mousemove', handleHoverMove);
          target.removeEventListener('mouseleave', handleMouseLeave);
        });
        document.removeEventListener('mousemove', handleHoverMove, true);
        window.removeEventListener('blur', handleMouseLeave);
        document.removeEventListener('scroll', handleMouseLeave, true);
      };
    }

    parseTimestampToSeconds(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
      }
      const raw = String(value ?? '').trim();
      if (!raw) return null;

      const bracketMatch = raw.match(/\[(\d{1,2}:\d{1,2}(?::\d{1,2})?)\]/);
      const source = bracketMatch ? bracketMatch[1] : raw;

      const hmsMatch = source.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/);
      if (hmsMatch) {
        const hours = Number(hmsMatch[1]);
        const minutes = Number(hmsMatch[2]);
        const seconds = Number(hmsMatch[3]);
        if ([hours, minutes, seconds].every(Number.isFinite)) {
          return Math.max(0, hours * 3600 + minutes * 60 + seconds);
        }
      }

      const msMatch = source.match(/(\d{1,3}):(\d{1,2})/);
      if (msMatch) {
        const minutes = Number(msMatch[1]);
        const seconds = Number(msMatch[2]);
        if ([minutes, seconds].every(Number.isFinite)) {
          return Math.max(0, minutes * 60 + seconds);
        }
      }

      return null;
    }

    toKnowledgeDanmuText(point) {
      if (typeof point === 'string') {
        return point.trim();
      }
      if (!point || typeof point !== 'object') {
        return '';
      }

      // 处理知识点（knowledge_points）
      const term = typeof point.term === 'string' ? point.term.trim() : '';
      const explanation = typeof point.explanation === 'string' ? point.explanation.trim() : '';
      // 处理热词（hot_words）
      const word = typeof point.word === 'string' ? point.word.trim() : '';
      const meaning = typeof (point.meaning || point.explanation) === 'string' ? (point.meaning || point.explanation).trim() : '';

      // 知识点格式：术语: 解释
      // 热词格式：[热词] 解释
      let text = '';
      if (term && explanation) {
        text = `${term}: ${explanation}`;
      } else if (word && meaning) {
        text = `[${word}] ${meaning}`;
      } else {
        text = term || explanation || word || meaning;
      }

      if (!text) return '';
      // 不再截断文本，显示完整内容
      return text;
    }

    updateKnowledgeDanmuSource(knowledgePoints, bvid) {
      const source = Array.isArray(knowledgePoints) ? knowledgePoints : [];
      this.knowledgeDanmuQueue = source
        .map((point, index) => {
          const seconds = this.parseTimestampToSeconds(
            typeof point === 'object' ? (point.timestamp ?? point.time ?? point.start_time) : null
          );
          const text = this.toKnowledgeDanmuText(point);
          if (!Number.isFinite(seconds) || !text) return null;

          // 判断是热词还是知识点
          const isHotWord = typeof point === 'object' && point.word && (point.meaning || point.explanation);
          const type = isHotWord ? 'hot-word' : 'knowledge-point';

          return {
            id: `${bvid || 'unknown'}-${Math.round(seconds * 10)}-${index}`,
            timeSec: seconds,
            text,
            type, // 添加类型标识
            rawWord: point.word || point.term || null,
            rawExplanation: point.explanation || point.meaning || null
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.timeSec - b.timeSec);

      this.analysisBvid = bvid || this.analysisBvid;
      this.triggeredDanmuIds.clear();
      this.lastDanmuCurrentTime = 0;
      this.nextDanmuLane = 0;
      this.clearKnowledgeDanmuNodes();
    }

    clearKnowledgeDanmuNodes() {
      this.stopKnowledgeDanmuLoop();
      this.activeKnowledgeDanmus.forEach(item => {
        if (item?.node?.remove) {
          item.node.remove();
        }
      });
      this.activeKnowledgeDanmus = [];
      if (!this.knowledgeDanmuLayer) return;
      const nodes = this.knowledgeDanmuLayer.querySelectorAll('.visionmark-knowledge-danmu');
      nodes.forEach(node => node.remove());
    }

    clearKnowledgeDanmuState() {
      this.knowledgeDanmuQueue = [];
      this.triggeredDanmuIds.clear();
      this.lastDanmuCurrentTime = 0;
      this.nextDanmuLane = 0;
      this.nativeDanmuSpeedPxPerSec = 0;
      this.lastNativeSpeedSampleTs = 0;
      this.nativeDanmuTrackSample = null;
      this.clearKnowledgeDanmuNodes();
      this.hideHotWordPopup();
    }

    ensureKnowledgeDanmuLayer() {
      const container = document.querySelector('.bpx-player-video-wrap') ||
        document.querySelector('.bpx-player-video-area') ||
        document.querySelector('.bpx-player-container') ||
        document.querySelector('#bilibili-player');
      if (!container) return null;

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      // 加载 Noto Sans SC 字体（思源黑体 - 现代中性）
      if (!document.getElementById('visionmark-font-noto-sans')) {
        const fontLink = document.createElement('link');
        fontLink.id = 'visionmark-font-noto-sans';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&display=swap';
        fontLink.rel = 'stylesheet';
        document.head.appendChild(fontLink);
      }

      if (!document.getElementById('visionmark-knowledge-danmu-style')) {
        const style = document.createElement('style');
        style.id = 'visionmark-knowledge-danmu-style';
        style.textContent = `
          #visionmark-knowledge-danmu-layer {
            position: absolute;
            inset: 0;
            pointer-events: none;
            overflow: hidden;
            z-index: 99998;
          }
          .visionmark-knowledge-danmu {
            position: absolute;
            max-width: min(75vw, 900px);
            min-width: 200px;
            padding: 8px 16px;

            /* 无背景 - 完全透明 */
            background: transparent !important;
            border: none !important;

            /* 增强文字效果 - 更醒目 */
            color: #ffffff !important;
            font-size: 22px;
            line-height: 1.6;
            letter-spacing: 0.5px;

            /* 使用 Noto Sans SC 字体 */
            font-family: "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
            font-weight: 700;

            /* 多层文字阴影 - 增强可读性 */
            text-shadow:
              0 2px 4px rgba(0, 0, 0, 0.8),
              0 4px 8px rgba(0, 0, 0, 0.6),
              0 0 20px rgba(0, 0, 0, 0.5),
              0 0 40px rgba(0, 0, 0, 0.3);

            /* 允许换行，显示完整内容 */
            white-space: normal;
            word-wrap: break-word;
            word-break: break-word;

            left: 0;
            transform: translate3d(0, 0, 0);
            will-change: transform;
            transition: opacity 0.3s ease;
          }

          /* 知识点样式 - 蓝色光晕 */
          .visionmark-knowledge-danmu.knowledge-point {
            color: #66ccff !important;
            text-shadow:
              0 2px 4px rgba(0, 0, 0, 0.9),
              0 4px 8px rgba(0, 0, 0, 0.7),
              0 0 20px rgba(102, 204, 255, 0.6),
              0 0 40px rgba(102, 204, 255, 0.4);
          }

          /* 热词样式 - 粉色光晕 */
          .visionmark-knowledge-danmu.hot-word {
            color: #ff99cc !important;
            text-shadow:
              0 2px 4px rgba(0, 0, 0, 0.9),
              0 4px 8px rgba(0, 0, 0, 0.7),
              0 0 20px rgba(255, 150, 180, 0.6),
              0 0 40px rgba(255, 150, 180, 0.4);
          }
        `;
        document.head.appendChild(style);
      }

      let layer = container.querySelector('#visionmark-knowledge-danmu-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'visionmark-knowledge-danmu-layer';
        container.appendChild(layer);
      }
      this.knowledgeDanmuLayer = layer;
      return layer;
    }

    pickNativeDanmuNode() {
      const nodes = this.getVisibleNativeDanmuNodes();
      if (nodes.length) return nodes[0];
      return null;
    }

    getVisibleNativeDanmuNodes() {
      const result = [];
      const seen = new Set();
      for (const selector of DANMU_NATIVE_NODE_SELECTORS) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (seen.has(node)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
          if (rect.right <= 0 || rect.left >= window.innerWidth) continue;
          seen.add(node);
          result.push(node);
        }
      }
      return result;
    }

    getKnowledgeDanmuLanes() {
      const fallback = DANMU_DEFAULT_LANES.slice(0, 3);
      if (!this.knowledgeDanmuLayer) return fallback;

      const layerRect = this.knowledgeDanmuLayer.getBoundingClientRect();
      if (!Number.isFinite(layerRect.height) || layerRect.height <= 0) return fallback;

      const nativeNodes = this.getVisibleNativeDanmuNodes();
      if (!nativeNodes.length) return fallback;

      const laneSet = new Set();
      for (const node of nativeNodes.slice(0, 24)) {
        const rect = node.getBoundingClientRect();
        const relativeY = ((rect.top + rect.height / 2) - layerRect.top) / layerRect.height * 100;
        if (!Number.isFinite(relativeY)) continue;
        const clamped = Math.min(Math.max(relativeY, DANMU_LANE_MIN_PERCENT), DANMU_LANE_MAX_PERCENT);
        const bucket = Math.round(clamped / DANMU_LANE_STEP_PERCENT) * DANMU_LANE_STEP_PERCENT;
        laneSet.add(bucket);
      }

      const nativeLanes = Array.from(laneSet)
        .filter(value => Number.isFinite(value))
        .sort((a, b) => a - b);

      const preferredLaneCount = nativeNodes.length <= 3 ? 3 : 4;
      const merged = [...nativeLanes, ...DANMU_DEFAULT_LANES]
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .filter(value => value >= DANMU_LANE_MIN_PERCENT && value <= DANMU_LANE_MAX_PERCENT)
        .sort((a, b) => a - b);

      const lanes = merged.slice(0, preferredLaneCount);
      return lanes.length ? lanes : fallback;
    }

    sampleNativeDanmuSpeed(now = performance.now()) {
      if (now - this.lastNativeSpeedSampleTs < DANMU_NATIVE_SAMPLE_MS) {
        return;
      }
      this.lastNativeSpeedSampleTs = now;

      const node = this.pickNativeDanmuNode();
      if (!node) {
        this.nativeDanmuTrackSample = null;
        return;
      }

      const rect = node.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (!Number.isFinite(centerX)) {
        return;
      }

      const previous = this.nativeDanmuTrackSample;
      if (previous && previous.node === node) {
        const dtSec = (now - previous.ts) / 1000;
        const dx = previous.x - centerX;
        if (dtSec > 0 && dx > 0) {
          const scaleX = this.getKnowledgeDanmuLayerScaleX();
          const speed = (dx / dtSec) / scaleX;
          if (speed >= DANMU_SPEED_MIN_PX_PER_SEC && speed <= DANMU_SPEED_MAX_PX_PER_SEC) {
            this.nativeDanmuSpeedPxPerSec = this.nativeDanmuSpeedPxPerSec > 0
              ? this.nativeDanmuSpeedPxPerSec * 0.7 + speed * 0.3
              : speed;
          }
        }
      }

      this.nativeDanmuTrackSample = { node, x: centerX, ts: now };
    }

    getKnowledgeDanmuLayerScaleX() {
      if (!this.knowledgeDanmuLayer) return 1;
      const localWidth = this.knowledgeDanmuLayer.clientWidth;
      const rectWidth = this.knowledgeDanmuLayer.getBoundingClientRect().width;
      if (!Number.isFinite(localWidth) || localWidth <= 0) return 1;
      if (!Number.isFinite(rectWidth) || rectWidth <= 0) return 1;
      const scaleX = rectWidth / localWidth;
      if (!Number.isFinite(scaleX) || scaleX <= 0) return 1;
      return Math.min(Math.max(scaleX, 0.5), 3);
    }

    getFallbackDanmuSpeedPxPerSec(layerWidth) {
      const safeLocalWidth = Number.isFinite(layerWidth) && layerWidth > 0
        ? layerWidth
        : (this.knowledgeDanmuLayer?.clientWidth || window.innerWidth || 1280);
      const scaleX = this.getKnowledgeDanmuLayerScaleX();
      const viewportWidth = safeLocalWidth * scaleX;
      return ((viewportWidth + DANMU_FALLBACK_TRACK_PX) / DANMU_BASE_DURATION_SEC) / scaleX;
    }

    getKnowledgeDanmuSpeedPxPerSec(layerWidth) {
      let speed = this.getFallbackDanmuSpeedPxPerSec(layerWidth);
      if (
        Number.isFinite(this.nativeDanmuSpeedPxPerSec) &&
        this.nativeDanmuSpeedPxPerSec >= DANMU_SPEED_MIN_PX_PER_SEC &&
        this.nativeDanmuSpeedPxPerSec <= DANMU_SPEED_MAX_PX_PER_SEC
      ) {
        speed = this.nativeDanmuSpeedPxPerSec;
      }
      return speed * DANMU_SPEED_TUNE_FACTOR;
    }

    startKnowledgeDanmuLoop() {
      if (this.knowledgeDanmuRafId !== null) return;
      this.lastDanmuFrameTs = 0;
      this.knowledgeDanmuRafId = requestAnimationFrame((ts) => this.tickKnowledgeDanmu(ts));
    }

    stopKnowledgeDanmuLoop() {
      if (this.knowledgeDanmuRafId !== null) {
        cancelAnimationFrame(this.knowledgeDanmuRafId);
        this.knowledgeDanmuRafId = null;
      }
      this.lastDanmuFrameTs = 0;
    }

    syncKnowledgeDanmuAnimationState() {
      if (!this.activeKnowledgeDanmus.length) {
        this.stopKnowledgeDanmuLoop();
        return;
      }
      const state = this.player.getState();
      if (state.paused) {
        this.stopKnowledgeDanmuLoop();
        return;
      }
      this.startKnowledgeDanmuLoop();
    }

    tickKnowledgeDanmu(frameTs) {
      this.knowledgeDanmuRafId = null;
      if (!this.knowledgeDanmuLayer) {
        this.activeKnowledgeDanmus = [];
        return;
      }

      this.activeKnowledgeDanmus = this.activeKnowledgeDanmus.filter(item => item?.node?.isConnected);
      if (!this.activeKnowledgeDanmus.length) {
        this.stopKnowledgeDanmuLoop();
        return;
      }

      const state = this.player.getState();
      if (state.paused) {
        this.stopKnowledgeDanmuLoop();
        return;
      }

      const currentTs = Number.isFinite(frameTs) ? frameTs : performance.now();
      if (!this.lastDanmuFrameTs) {
        this.lastDanmuFrameTs = currentTs;
      }
      const deltaSec = Math.min(Math.max((currentTs - this.lastDanmuFrameTs) / 1000, 0), 0.1);
      this.lastDanmuFrameTs = currentTs;

      this.sampleNativeDanmuSpeed(currentTs);
      const layerWidth = this.knowledgeDanmuLayer.clientWidth || window.innerWidth || 1280;
      const speed = this.getKnowledgeDanmuSpeedPxPerSec(layerWidth);
      const remaining = [];

      for (const item of this.activeKnowledgeDanmus) {
        item.x -= speed * deltaSec;
        if (item.node && item.node.style) {
          item.node.style.transform = `translate3d(${item.x}px, 0, 0)`;
        }
        if (item.x + item.width < -DANMU_REMOVE_BUFFER_PX) {
          item.node.remove();
          continue;
        }
        remaining.push(item);
      }

      this.activeKnowledgeDanmus = remaining;
      if (!this.activeKnowledgeDanmus.length) {
        this.stopKnowledgeDanmuLoop();
        return;
      }

      this.knowledgeDanmuRafId = requestAnimationFrame((ts) => this.tickKnowledgeDanmu(ts));
    }

    renderKnowledgeDanmu(item) {
      const layer = this.ensureKnowledgeDanmuLayer();
      if (!layer) return;
      if (this.activeKnowledgeDanmus.length >= DANMU_MAX_CONCURRENT) return;

      const lanes = this.getKnowledgeDanmuLanes();
      const lane = lanes[this.nextDanmuLane % lanes.length];
      this.nextDanmuLane += 1;

      const node = document.createElement('div');
      node.className = `visionmark-knowledge-danmu ${item.type || 'knowledge-point'}`;
      node.style.top = `${lane}%`;
      node.textContent = item.text;
      layer.appendChild(node);

      const layerWidth = layer.clientWidth || window.innerWidth || 1280;
      const width = node.getBoundingClientRect().width || 240;
      const startX = layerWidth + 24;
      node.style.transform = `translate3d(${startX}px, 0, 0)`;

      this.activeKnowledgeDanmus.push({
        id: item.id,
        node,
        x: startX,
        width
      });

      this.sampleNativeDanmuSpeed();
      this.syncKnowledgeDanmuAnimationState();
    }

    handleKnowledgeDanmu(currentTime) {
      if (!Number.isFinite(currentTime) || !this.knowledgeDanmuQueue.length) {
        this.lastDanmuCurrentTime = currentTime;
        this.syncKnowledgeDanmuAnimationState();
        return;
      }
      this.sampleNativeDanmuSpeed();
      if (currentTime + DANMU_REWIND_RESET_SEC < this.lastDanmuCurrentTime) {
        this.triggeredDanmuIds.clear();
      }

      let rendered = 0;
      for (const item of this.knowledgeDanmuQueue) {
        if (rendered >= 2) break;
        if (this.triggeredDanmuIds.has(item.id)) continue;
        const delta = currentTime - item.timeSec;
        if (delta >= -DANMU_TRIGGER_WINDOW_SEC && delta <= DANMU_TRIGGER_WINDOW_SEC) {
          this.triggeredDanmuIds.add(item.id);
          this.renderKnowledgeDanmu(item);
          rendered += 1;
        }
      }

      this.lastDanmuCurrentTime = currentTime;
      this.syncKnowledgeDanmuAnimationState();
    }

    ensureHotWordPopupLayer() {
      const container = document.querySelector('.bpx-player-video-wrap') ||
        document.querySelector('.bpx-player-video-area') ||
        document.querySelector('.bpx-player-container') ||
        document.querySelector('#bilibili-player');

      if (!container) return null;

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      if (!this.hotWordPopupLayer || !document.body.contains(this.hotWordPopupLayer)) {
        this.hotWordPopupLayer = document.createElement('div');
        this.hotWordPopupLayer.className = 'visionmark-hotword-popup-layer';
        this.hotWordPopupLayer.style.cssText = `
          position: absolute;
          bottom: 60px; /* 进度条上方 */
          left: 20px;   /* 视频界面左下角 */
          z-index: 99999;
          pointer-events: none;
          transition: opacity 0.3s ease, transform 0.3s ease;
          opacity: 0;
          transform: translateY(10px);
        `;
        container.appendChild(this.hotWordPopupLayer);
      }
      return this.hotWordPopupLayer;
    }

    renderHotWordPopup(item) {
      const layer = this.ensureHotWordPopupLayer();
      if (!layer) return;

      if (this.currentHotWordId === item.id) return; // 防止重复渲染
      this.currentHotWordId = item.id;

      const word = item.rawWord || '小知识';
      const explanation = item.rawExplanation || '暂无详细解释';

      layer.innerHTML = `
        <div style="background: rgba(0, 0, 0, 0.3);
                    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
                    border-radius: 8px; padding: 10px 14px;
                    max-width: 320px; pointer-events: none;
                    display: flex; flex-direction: column; gap: 6px;">
           <div style="display: flex; align-items: center; gap: 6px;">
             <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fb7299" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2c0 0-5 6-5 12a5 5 0 0 0 10 0c0-6-5-12-5-12Z"/>
                <path d="M12 2v10"/>
             </svg>
             <span style="font-size: 16px; font-weight: bold; color: #fb7299; margin: 0; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);">${this.escapeHtml(word)}</span>
           </div>
           <div style="font-size: 13px; color: #fff; line-height: 1.5; font-weight: 500; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);">${this.escapeHtml(explanation)}</div>
        </div>
      `;
      
      layer.style.opacity = '1';
      layer.style.transform = 'translateY(0)';
    }

    hideHotWordPopup() {
      if (this.hotWordPopupLayer && this.hotWordPopupLayer.style.opacity !== '0') {
        this.hotWordPopupLayer.style.opacity = '0';
        this.hotWordPopupLayer.style.transform = 'translateY(10px)';
        this.currentHotWordId = null;
      }
    }

    handleHotWordPopup(currentTime) {
      if (!Number.isFinite(currentTime) || !this.knowledgeDanmuQueue || !this.knowledgeDanmuQueue.length) {
        this.hideHotWordPopup();
        return;
      }

      // 寻找当前时间点处于 [timeSec, timeSec + 5秒] 内的热词
      let activeHotWord = null;
      for (const item of this.knowledgeDanmuQueue) {
        if (item.type === 'hot-word') {
          if (currentTime >= item.timeSec && currentTime <= item.timeSec + 5) {
            activeHotWord = item;
            break;
          }
        }
      }

      if (activeHotWord) {
        this.renderHotWordPopup(activeHotWord);
      } else {
        this.hideHotWordPopup();
      }
    }


    async requestAnalysis(bvid, token) {
      const url = VIDEO_ANALYSIS_BASE + "/video-analysis/analyze";
      console.log('[AdSkipper] 请求URL:', url);
      console.log('[AdSkipper] 请求体:', JSON.stringify({ bvid }));
      console.log('[AdSkipper] 注意：视频分析无超时限制，可能需要几分钟时间');

      // 直接使用原生 fetch，不设置超时
      // 视频分析需要很长时间（下载、提取、AI分析），不能有超时限制
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ bvid })
      });

      console.log('[AdSkipper] 响应状态:', res.status, res.statusText);

      let payload = null;
      try {
        payload = await res.json();
        console.log('[AdSkipper] 响应数据:', payload);
      } catch (error) {
        console.error('[AdSkipper] 解析JSON失败:', error);
        payload = null;
      }

      if (!res.ok) {
        const message = payload?.message || payload?.error || `分析失败（${res.status}）`;
        console.error('[AdSkipper] API错误:', message);
        throw new Error(message);
      }
      return payload;
    }

    applyAnalysisData(bvid, data) {
      const analysisData = data || {};
      const rawSegments = Array.isArray(analysisData.ad_segments) ? analysisData.ad_segments : [];
      const aiSegments = rawSegments
        .map((segment, index) => this.normalizeSegment({
          id: `ai-${bvid}-${index}`,
          start_time: Number(segment.start_time ?? segment.start ?? 0),
          end_time: Number(segment.end_time ?? segment.end ?? 0),
          action: segment.highlight ? 'popup' : 'skip',
          content: typeof segment.description === 'string' ? segment.description : '',
          ad_type: segment.ad_type || (segment.highlight ? 'hard_ad' : 'soft_ad'),
          is_ai_segment: true
        }, index))
        .filter(segment => Number.isFinite(segment.start_time) && Number.isFinite(segment.end_time) && segment.end_time > segment.start_time);

      const knowledgePoints = Array.isArray(analysisData.knowledge_points) ? analysisData.knowledge_points : [];
      const hotWords = Array.isArray(analysisData.hot_words) ? analysisData.hot_words : [];

      // 去重：知识点和热词重复时，以知识点为主（优先显示知识点）
      const knowledgePointTerms = new Set(knowledgePoints.map(kp => kp.term));
      const filteredHotWords = hotWords.filter(hw => !knowledgePointTerms.has(hw.word));

      // 合并知识点和过滤后的热词（知识点在前，热词在后）
      const allDanmuItems = [...knowledgePoints, ...filteredHotWords];

      console.log('[AdSkipper] 弹幕数据统计:');
      console.log('  - 知识点:', knowledgePoints.length);
      console.log('  - 原始热词:', hotWords.length);
      console.log('  - 去重后热词:', filteredHotWords.length);
      console.log('  - 总弹幕数:', allDanmuItems.length);

      this.analysisBvid = bvid;
      this.aiSummary = typeof analysisData.summary === 'string' ? analysisData.summary.trim() : '';
      this.segments = aiSegments;
      this.allSegments = aiSegments;
      this.currentSegmentIds = [];
      this.updateKnowledgeDanmuSource(allDanmuItems, bvid);
      this.addSegmentMarkers();
        this.scheduleSegmentMarkerRetry(2);

      if (sidebarState) {
        sidebarState.aiSummary = this.aiSummary || '暂无总结';
        sidebarState.aiTitle = analysisData.title || '';
        sidebarState.knowledgePoints = knowledgePoints;
        sidebarState.hotWords = hotWords;
        sidebarState.bvid = bvid;
        sidebarState.cid = this.player.currentCid || null;
        sidebarState.segments = aiSegments;
        sidebarState.activeSegmentKey = null;
      }
    }

    async analyzeVideoLegacy(bvid) {
      try {
        const token = await this.getToken();
        if (!token) {
          console.log("[AdSkipper] 未登录，跳过视频分析");
          return;
        }

        console.log("[AdSkipper] 开始分析视频:", bvid);

        // 设置加载状态
        if (sidebarState) {
          sidebarState.isLoading = true;
          sidebarState.loadError = null;
        }

        const url = VIDEO_ANALYSIS_BASE + "/video-analysis/analyze";
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ bvid })
        });

        const result = await res.json();

        if (!res.ok) {
          console.error("[AdSkipper] 分析失败:", result.message || result.error);
          if (sidebarState) {
            sidebarState.isLoading = false;
            sidebarState.loadError = result.message || result.error || '分析失败';
          }
          return;
        }

        if (result.success && result.data) {
          console.log("[AdSkipper] 分析成功");
          console.log("[AdSkipper] title:", result.data.title);
          console.log("[AdSkipper] summary:", result.data.summary);
          console.log("[AdSkipper] ad_segments:", result.data.ad_segments?.length || 0);
          console.log("[AdSkipper] knowledge_points:", result.data.knowledge_points?.length || 0);
          console.log("[AdSkipper] hot_words:", result.data.hot_words?.length || 0);

          // 更新侧边栏显示
          if (sidebarState) {
            sidebarState.aiSummary = result.data.summary || '暂无总结';
            sidebarState.aiTitle = result.data.title || '';
            sidebarState.knowledgePoints = result.data.knowledge_points || [];
            sidebarState.hotWords = result.data.hot_words || [];
            sidebarState.bvid = bvid;
            sidebarState.cid = this.player.currentCid || null;
            sidebarState.isLoading = false; // 结束加载状态

            // 处理 AI 分析的分段数据
            if (result.data.ad_segments && result.data.ad_segments.length > 0) {
              console.log("[AdSkipper] 发现", result.data.ad_segments.length, "个 AI 分析分段");

              // 将 AI 分段转换为 TimelineItem 期望的格式
              const aiSegments = result.data.ad_segments.map((seg, index) => ({
                id: `ai-${bvid}-${index}`, // 生成唯一 ID
                start_time: seg.start_time,
                end_time: seg.end_time,
                action: seg.highlight ? 'popup' : 'skip', // highlight 为 true 时为重点
                content: seg.description || '',
                ad_type: seg.ad_type || (seg.highlight ? 'hard_ad' : 'soft_ad'),
                is_ai_segment: true // 标记为 AI 分析的片段
              }));

              // 将 AI 分段添加到侧边栏
              sidebarState.segments = aiSegments;
              console.log("[AdSkipper] AI 分段已添加到侧边栏:", aiSegments.length);
            } else {
              // 如果没有 AI 分段，清空分段列表
              sidebarState.segments = [];
            }

            console.log("[AdSkipper] 侧边栏数据已更新:");
            console.log("  - aiTitle:", sidebarState.aiTitle);
            console.log("  - aiSummary:", sidebarState.aiSummary ? sidebarState.aiSummary.substring(0, 50) + '...' : '');
            console.log("  - knowledgePoints:", sidebarState.knowledgePoints.length);
            console.log("  - hotWords:", sidebarState.hotWords.length);
            console.log("  - segments:", sidebarState.segments.length);
          }
        }
      } catch (error) {
        console.error("[AdSkipper] 分析视频出错:", error);
        if (sidebarState) {
          sidebarState.isLoading = false;
          sidebarState.loadError = '分析失败: ' + error.message;
        }
      }
    }

    async analyzeVideo(bvid) {
      try {
        console.log('[AdSkipper] ========== 开始视频分析 ==========');
        console.log('[AdSkipper] BV号:', bvid);
        console.log('[AdSkipper] API地址:', VIDEO_ANALYSIS_BASE);

        let token = '';
        token = await this.getToken();
        console.log('[AdSkipper] Token:', token ? '已获取（前10位: ' + token.substring(0, 10) + '...）' : '未获取');

        if (!token) {
          console.log('[AdSkipper] 未登录，跳过视频分析');
          if (sidebarState) {
            sidebarState.loadError = '请先登录后再使用AI分析功能';
          }
          return;
        }

        if (sidebarState) {
          sidebarState.isLoading = true;
          sidebarState.loadError = null;
        }

        console.log('[AdSkipper] 开始请求分析API...');
        const result = await this.requestAnalysis(bvid, token);
        console.log('[AdSkipper] API返回:', result);

        if (!result?.success || !result?.data) {
          throw new Error('分析结果无效');
        }

        this.applyAnalysisData(bvid, result.data);
        if (sidebarState) {
          sidebarState.isLoading = false;
        }
        console.log('[AdSkipper] ========== 视频分析完成 ==========');
      } catch (error) {
        console.error('[AdSkipper] 视频分析异常:', error);
        console.error('[AdSkipper] 错误详情:', {
          message: error.message,
          code: error.code,
          stack: error.stack
        });
        if (sidebarState) {
          sidebarState.isLoading = false;
          sidebarState.loadError = '分析失败: ' + error.message;
        }
      }
    }

    getSegmentKey(segment, indexFallback = 0) {
      return String(segment.id ?? `${segment.start_time}-${segment.end_time}-${indexFallback}`);
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

    // 鏇存柊鍚庣殑 checkSkip 鏂规硶
    checkSkip(currentTime) {
      if (this.analysisBvid && this.player.currentBvid && this.analysisBvid !== this.player.currentBvid) {
        this.clearKnowledgeDanmuState();
        this.analysisBvid = this.player.currentBvid;
      }

      if (sidebarState) {
        sidebarState.currentTime = currentTime;
        if (this.player.currentBvid) {
          sidebarState.bvid = this.player.currentBvid;
        }
        if (this.player.currentCid) {
          sidebarState.cid = this.player.currentCid;
        }
      }

      this.handleKnowledgeDanmu(currentTime);
      this.handleHotWordPopup(currentTime);

      if (!this.segments.length) {
        if (sidebarState) {
          sidebarState.activeSegmentKey = null;
        }
        this.hideSkipButton();
        return;
      }

      const activeSegment = this.getActiveSegment(currentTime);
      if (!activeSegment) {
        if (sidebarState) {
          sidebarState.activeSegmentKey = null;
        }
        this.hideSkipButton();
        return;
      }

      if (sidebarState) {
        sidebarState.activeSegmentKey = this.getSegmentKey(activeSegment);
      }

      if (activeSegment.action === 'popup') {
        this.hideSkipButton();
        return;
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
        `;
        document.head.appendChild(style);
      }

      const wrapper = document.createElement('div');
      wrapper.id = 'adskipper-wrapper';
      wrapper.style.cssText = 'position:relative;display:inline-flex;vertical-align:middle;height:100%;align-items:center;margin-right:12px;z-index:100;';

      const toggleBtn = document.createElement('div');
      toggleBtn.id = 'adskipper-toggle';
      toggleBtn.title = '分段评价';
      toggleBtn.setAttribute('aria-label', '分段评价');
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
      toggleBtn.innerHTML = '<span class="adskipper-toggle-text">分段评价</span>';
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
        { val: 'hard_ad', text: '商业内容' },
        { val: 'soft_ad', text: '推广内容' },
        { val: 'product_placement', text: '品牌植入' },
        { val: 'intro_ad', text: '片头广告' },
        { val: 'mid_ad', text: '中段广告' }
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
        // Use native confirm for control panel popover (dark theme UI)
        const confirmed = confirm(`确定要删除最近标注（ID：${targetId}）吗？`);
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

      const res = await this.safeFetch(`${API_BASE}/segments/${segmentId}`, {
        method: "DELETE",
        headers: headers
      }, 'delete annotation');

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

      console.log('[AdSkipper] 提交标注:', body);
      const storage = await new Promise(r => chrome.storage.local.get(['adskipper_token'], r));
      const token = storage.adskipper_token;
      console.log('[AdSkipper] 令牌状态:', token ? '存在' : '缺失');

      const headers = { "Content-Type": "application/json" };
      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
        console.log('[AdSkipper] 认证头:', 'Bearer ' + token.substring(0, 20) + '...');
      } else {
        console.warn('[AdSkipper] 警告：请求未携带令牌');
      }

      console.log('[AdSkipper] 请求头:', headers);

      const res = await this.safeFetch(API_BASE + "/segments", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      }, 'submit annotation');

      if (!res.ok) {
        let errorMsg = '提交失败';
        try {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
          console.error('[AdSkipper] 服务器错误:', data);
        } catch (e) {
          console.error('[AdSkipper] 解析响应失败:', res.status, res.statusText);
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
      toast.innerHTML = `✓ 已自动跳过 ${duration}s`;

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
      // 浼樺厛绾э細.bpx-player-video-wrap > .bpx-player-video-area > fallback
      let playerContainer = document.querySelector('.bpx-player-video-wrap') ||
        document.querySelector('.bpx-player-video-area') ||
        document.querySelector('.bpx-player-container') ||
        document.querySelector('#bilibili-player');

      if (!playerContainer) {
        console.log('[AdSkipper] 未找到视频容器');
        return;
      }

      // 4. 确保父容器有相对定位（子绝父相）
      if (getComputedStyle(playerContainer).position === 'static') {
        playerContainer.style.position = 'relative';
      }

      const btn = document.createElement('div');
      btn.id = 'adskipper-skip-btn';
      btn.textContent = '跳过分段';
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
        self.showToast('已跳过 ' + (ad.end_time - ad.start_time).toFixed(1) + ' 秒', 'success');
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

    scheduleSegmentMarkerRetry(attempt = 1) {
      if (this.segmentMarkerRetryTimer) {
        clearTimeout(this.segmentMarkerRetryTimer);
        this.segmentMarkerRetryTimer = null;
      }

      if (attempt > 8) {
        console.warn('[AdSkipper] progress hover: retry limit reached');
        return;
      }

      const delayMs = 250 * attempt;
      console.log(`[AdSkipper] progress hover: scheduling retry #${attempt} in ${delayMs}ms`);
      this.segmentMarkerRetryTimer = setTimeout(() => {
        this.segmentMarkerRetryTimer = null;
        this.addSegmentMarkers(attempt + 1);
      }, delayMs);
    }
    addSegmentMarkers(retryAttempt = 1) {
      const oldMarkers = document.querySelectorAll('.adskipper-progress-marker');
      oldMarkers.forEach(marker => marker.remove());

      if (!this.segments.length) {
        console.log('[AdSkipper] progress hover: skip binding because segments are empty');
        return;
      }

      const progressContainer = document.querySelector('.bpx-player-progress') ||
        document.querySelector('.bilibili-player-progress') ||
        document.querySelector('.bpx-player-progress-wrap');
      if (!progressContainer) {
        console.warn('[AdSkipper] progress hover: progressContainer not found');
        this.scheduleSegmentMarkerRetry(retryAttempt);
        return;
      }

      const duration = this.player.getState().duration;
      if (!duration || duration <= 0) {
        console.warn('[AdSkipper] progress hover: invalid duration', duration);
        this.scheduleSegmentMarkerRetry(retryAttempt);
        return;
      }

      const progressSlide = progressContainer.querySelector('.bpx-player-progress-slide') ||
        progressContainer.querySelector('.bili-progress-slip') ||
        progressContainer.querySelector('.bpx-player-progress-buffer');
      const markerHost = progressSlide || progressContainer;
      if (!progressSlide) {
        console.warn('[AdSkipper] progress hover: progressSlide not found, fallback to progressContainer', progressContainer.className || progressContainer.id);
      }

      if (this.segmentMarkerRetryTimer) {
        clearTimeout(this.segmentMarkerRetryTimer);
        this.segmentMarkerRetryTimer = null;
      }

      markerHost.style.position = markerHost.style.position || 'relative';

      console.log('[AdSkipper] progress hover: binding listeners', {
        segmentCount: this.segments.length,
        duration,
        progressContainer: progressContainer.className || progressContainer.id,
        progressSlide: progressSlide ? (progressSlide.className || progressSlide.id) : '(fallback:container)'
      });
      this.bindProgressHover(progressContainer, markerHost, duration);

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
        const actionText = segment.action === 'popup' ? '重点' : '跳过';
        marker.title = `${segment.start_time.toFixed(1)}s - ${segment.end_time.toFixed(1)}s | ${actionText}${titleContent}`;

        markerHost.appendChild(marker);
      });
    }

    handleShowMarkers() {
      this.showSidebar({ refresh: true });
    }
  }

  new AdSkipperCore().init();
})();









