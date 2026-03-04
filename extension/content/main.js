(function () {
  'use strict';

  if (window.adSkipper) return;

  // Sidebar state (will be initialized when sidebar loads)
  let sidebarState = null;

  // API 基础路径
  const API_BASE = window.API_BASE || 'http://localhost:8080/api/v1';
  const VIDEO_ANALYSIS_BASE = window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080';

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
      this.sidebarController = null;
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
      this.networkState = {
        offlineUntil: 0,
        hasLoggedOffline: false,
        wasOffline: false
      };
      this.networkCooldownMs = 30000;
      this.networkTimeoutMs = 6000;


    }

    async init() {
      console.log("[AdSkipper] 初始化...");
      const ok = await this.player.init();
      if (!ok) return;

      // 初始化 AI 弹幕 (并等待 sidebarState 就绪)
      await this.initAiDanmaku();

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
      this.initSidebar().then(() => {
        console.log("[AdSkipper] Sidebar 初始化完成");
      }).catch(err => {
        console.error("[AdSkipper] Sidebar 初始化失败:", err);
      });

      this.initAiFloatingButton();

      this.player.onTimeUpdate = (t) => this.checkSkip(t);
      this.startInjectionObserver();

      const bvid = this.player.currentBvid;
      if (bvid) {
        this.loadSegments(bvid).then(async () => {
          // 如果没有片段数据，自动触发AI分析
          if (this.segments.length === 0) {
            console.log("[AdSkipper] 没有广告段数据，尝试自动分析视频...");
            await this.analyzeVideo(bvid);
          }
          window.adSkipper = this;
        });
      }

      // Global click listener for closing popover
      document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('adskipper-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          this.togglePopover(false);
        }

      });

      // ESC key listener
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.togglePopover(false);
          if (this.sidebarController) {
            this.sidebarController.hide();
          }
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

      window.addEventListener('visionmark:delete-segment', (event) => {
        const segmentId = Number(event?.detail?.segmentId);
        this.handleSidebarDelete(segmentId);
      });

      // 调试：将实例暴露到全局，便于控制台调试
      window.adSkipperDebug = this;
      console.log('[AdSkipper] 调试模式已启用，使用: adSkipperDebug.addSegmentMarkers() 手动添加标记');
    }


    async initAiDanmaku() {
      if (this.aiDanmakuApp) return;

      try {
        // 动态导入 createAiDanmaku 和 sidebarState
        const { createAiDanmaku, sidebarState: importedSidebarState } = await import('../sidebar/index.js');
        
        // 确保 main.js 中的 sidebarState 引用已更新，以便 checkSkip 能更新 currentTime
        if (!sidebarState) {
            sidebarState = importedSidebarState;
        }

        // 查找视频元素
        const videoElement = this.player.video;
        if (!videoElement) {
          console.warn('[AdSkipper] Cannot init AiDanmaku: Video element not found');
          return;
        }

        // 尝试找到 .bpx-player-video-area (B站播放器的主要视频区域)
        // 这个区域包含了视频和弹幕层，是放置我们覆盖层的理想位置
        // 如果找不到，退回到 video 的父元素
        let container = document.querySelector('.bpx-player-video-area') || videoElement.parentElement;
        
        if (!container) {
           console.warn('[AdSkipper] Cannot init AiDanmaku: Container not found');
           return;
        }

        // 创建弹幕容器
        const danmakuRoot = document.createElement('div');
        danmakuRoot.id = 'vm-ai-danmaku-root';
        danmakuRoot.style.position = 'absolute';
        danmakuRoot.style.top = '0';
        danmakuRoot.style.left = '0';
        danmakuRoot.style.width = '100%';
        danmakuRoot.style.height = '100%';
        danmakuRoot.style.pointerEvents = 'none'; // 点击穿透，不影响用户操作视频
        danmakuRoot.style.zIndex = '10'; // 位于视频之上，但低于控制栏
        danmakuRoot.style.overflow = 'hidden';

        // 确保父容器有定位上下文
        const computedStyle = window.getComputedStyle(container);
        if (computedStyle.position === 'static') {
          container.style.position = 'relative';
        }

        container.appendChild(danmakuRoot);

        console.log("[AdSkipper] 初始化 AI 弹幕...");
        const { app, instance } = createAiDanmaku(danmakuRoot);
        this.aiDanmakuApp = app;
        this.aiDanmakuInstance = instance;
        
      } catch (error) {
        console.error('[AdSkipper] Failed to init AiDanmaku:', error);
      }
    }

    async initSidebar() {
      if (this.sidebarController) return;

      // 动态导入 sidebar 模块
      const { createSidebar, sidebarState: importedSidebarState } = await import('../sidebar/index.js');

      // 将导入的 sidebarState 赋值给局部变量
      sidebarState = importedSidebarState;

      const existingRoot = document.getElementById('vm-sidebar-root');
      if (existingRoot) {
        this.sidebarController = createSidebar(existingRoot);
        return;
      }

      const root = document.createElement('div');
      root.id = 'vm-sidebar-root';
      document.body.appendChild(root);

      console.log("[AdSkipper Sidebar] 初始化侧边栏...");
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
        console.log("[AdSkipper] AI按钮样式已添加");
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
      button.title = 'AI video summary';
      button.setAttribute('aria-label', 'AI video summary');
      button.onclick = (event) => {
        event.stopPropagation();
        this.toggleSidebar();
      };

      document.body.appendChild(button);
      console.log("[AdSkipper] ✅ AI按钮已创建并添加到body");

      // 验证按钮是否真的在DOM中并检查位置
      setTimeout(() => {
        const btn = document.getElementById('visionmark-ai-fab');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          console.log("[AdSkipper] ✅ 验证：AI按钮在DOM中1");
          console.log("[AdSkipper] 📍 位置信息:");
          console.log("  - 尺寸:", btn.offsetWidth, "x", btn.offsetHeight);
          console.log("  - 屏幕位置:", rect.left, ",", rect.top);
          console.log("  - right/top:", rect.right, ",", rect.bottom);
          console.log("  - 在视口内:", rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth);
          console.log("  - z-index:", window.getComputedStyle(btn).zIndex);
        } else {
          console.error("[AdSkipper] ❌ 错误：AI按钮创建后未在DOM中找到！");
        }
      }, 100);
    }

    ensureSidebarReady() {
      if (this.sidebarController) return true;
      this.initSidebar();
      return Boolean(this.sidebarController);
    }

    showSidebar(options = {}) {
      if (!this.ensureSidebarReady()) return;

      if (options.refresh && this.player.currentBvid) {
        this.loadSegments(this.player.currentBvid);
      }

      this.sidebarController.show();
    }

    toggleSidebar() {
      if (!this.ensureSidebarReady()) return;
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
      const error = new Error('Failed to fetch');
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
        console.warn(`[AdSkipper] Backend unreachable during ${context}, pausing requests for 30s.`, error);
        this.networkState.hasLoggedOffline = true;
      }
    }

    markNetworkOnline() {
      if (this.networkState.wasOffline) {
        console.info('[AdSkipper] Backend connection restored.');
      }
      this.networkState.offlineUntil = 0;
      this.networkState.hasLoggedOffline = false;
      this.networkState.wasOffline = false;
    }

    async safeFetch(url, options = {}, context = 'request') {
      if (Date.now() < this.networkState.offlineUntil) {
        throw this.createNetworkUnavailableError();
      }

      const controller = options.signal ? null : new AbortController();
      const timeoutId = setTimeout(() => {
        if (controller) controller.abort();
      }, this.networkTimeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: options.signal || (controller ? controller.signal : undefined)
        });
        clearTimeout(timeoutId);
        this.markNetworkOnline();
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        if (this.isNetworkFailure(error)) {
          this.markNetworkOffline(context, error);
          throw this.createNetworkUnavailableError();
        }
        throw error;
      }
    }

    async loadSegments(bvid) {
      if (!bvid || this.isLoadingSegments) return;
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
          throw new Error("Failed to load segments: " + res.status);
        }

        const data = await res.json();
        console.log("[AdSkipper] 📊 后端返回的数据结构:", Object.keys(data));
        console.log("[AdSkipper] 📊 data.ai_title:", data.ai_title);
        console.log("[AdSkipper] 📊 data.knowledge_points:", data.knowledge_points);
        console.log("[AdSkipper] 📊 data.hot_words:", data.hot_words);

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
        if (sidebarState) {
          sidebarState.bvid = bvid;
          sidebarState.cid = this.player.currentCid || null;

          sidebarState.aiSummary = this.aiSummary || '';
          // 确保其他AI分析信息也被保留（如果后端返回了这些字段）
          if (data.ai_title !== undefined) {
            sidebarState.aiTitle = data.ai_title || '';
          }
          // 辅助函数：将 MM:SS 格式转换为秒
          const parseTimestamp = (timeStr) => {
            if (!timeStr) return 0;
            try {
              const parts = timeStr.split(':');
              if (parts.length === 2) {
                return parseInt(parts[0]) * 60 + parseInt(parts[1]);
              } else if (parts.length === 3) {
                return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
              }
              return 0;
            } catch (e) {
              console.warn('[AdSkipper] 时间戳解析失败:', timeStr, e);
              return 0;
            }
          };

          if (data.knowledge_points !== undefined) {
            sidebarState.knowledgePoints = (data.knowledge_points || []).map(kp => ({
              ...kp,
              timestamp_seconds: parseTimestamp(kp.timestamp)
            }));
          }
          if (data.hot_words !== undefined) {
            sidebarState.hotWords = (data.hot_words || []).map(hw => ({
              ...hw,
              timestamp_seconds: parseTimestamp(hw.timestamp)
            }));
          }

          // 保留现有的 AI 分段，避免被覆盖
          const existingAiSegments = (sidebarState.segments || []).filter(s => s.is_ai_segment);
          
          // 合并手动分段和 AI 分段
          sidebarState.segments = [...this.segments, ...existingAiSegments];
          
          sidebarState.activeSegmentKey = null;

          console.log("[AdSkipper] 📊 侧边栏状态更新后:");
          console.log("  - aiTitle:", sidebarState.aiTitle);
          console.log("  - aiSummary:", sidebarState.aiSummary?.substring(0, 50));
          console.log("  - knowledgePoints:", sidebarState.knowledgePoints);
          console.log("  - hotWords:", sidebarState.hotWords);
          console.log("  - isLoading:", sidebarState.isLoading);
          console.log("  - loadError:", sidebarState.loadError);
        }

        this.addSegmentMarkers();
      } catch (error) {
        if (error.code !== 'NETWORK_UNAVAILABLE') {
          console.error('[AdSkipper] Load segments failed:', error);
        }
        this.segments = [];
        this.allSegments = [];
        this.currentSegmentIds = [];
        if (sidebarState) {
          sidebarState.bvid = bvid;
          sidebarState.cid = this.player.currentCid || null;
          
          // 出错时保留 AI 分段
          const existingAiSegments = (sidebarState.segments || []).filter(s => s.is_ai_segment);
          sidebarState.segments = existingAiSegments;
          
          if (existingAiSegments.length === 0) {
            sidebarState.aiSummary = 'AI 总结加载失败';
            sidebarState.loadError = error.message || 'load failed';
          }
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

    async analyzeVideo(bvid) {
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
          console.log("[AdSkipper] ✅ 分析成功");
          console.log("[AdSkipper] title:", result.data.title);
          console.log("[AdSkipper] summary:", result.data.summary);
          console.log("[AdSkipper] ad_segments:", result.data.ad_segments?.length || 0);
          console.log("[AdSkipper] knowledge_points:", result.data.knowledge_points?.length || 0);
          console.log("[AdSkipper] hot_words:", result.data.hot_words?.length || 0);

          // 更新侧边栏显示
          if (sidebarState) {
            // 辅助函数：将 MM:SS 格式转换为秒
            const parseTimestamp = (timeStr) => {
              if (!timeStr) return 0;
              try {
                const parts = timeStr.split(':');
                if (parts.length === 2) {
                  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
                } else if (parts.length === 3) {
                  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
                }
                return 0;
              } catch (e) {
                console.warn('[AdSkipper] 时间戳解析失败:', timeStr, e);
                return 0;
              }
            };

            // 处理知识点数据，添加 seconds 字段
            const knowledgePoints = (result.data.knowledge_points || []).map(kp => ({
              ...kp,
              timestamp_seconds: parseTimestamp(kp.timestamp)
            }));

            // 处理热词数据，添加 seconds 字段
            const hotWords = (result.data.hot_words || []).map(hw => ({
              ...hw,
              timestamp_seconds: parseTimestamp(hw.timestamp)
            }));

            sidebarState.aiSummary = result.data.summary || '';
            sidebarState.aiTitle = result.data.title || '';
            sidebarState.knowledgePoints = knowledgePoints;
            sidebarState.hotWords = hotWords;
            sidebarState.bvid = bvid;
            sidebarState.cid = this.player.currentCid || null;
            sidebarState.isLoading = false; // 结束加载状态

            // 调试：打印知识点和热词数据
            console.log("[AdSkipper] 📚 知识点数据:", knowledgePoints);
            console.log("[AdSkipper] 📚 知识点数量:", knowledgePoints.length);
            console.log("[AdSkipper] 🔥 热词数据:", hotWords);
            console.log("[AdSkipper] 🔥 热词数量:", hotWords.length);

            // 处理 AI 分析的分段数据
            if (result.data.ad_segments && result.data.ad_segments.length > 0) {
              console.log("[AdSkipper] 🎬 发现", result.data.ad_segments.length, "个 AI 分析分段");
              console.log("[AdSkipper] 🎬 分段详情:", result.data.ad_segments);

              // 将 AI 分段转换为 TimelineItem 期望的格式
              const aiSegments = result.data.ad_segments.map((seg, index) => ({
                id: `ai-${bvid}-${index}`, // 生成唯一 ID
                start_time: Number(seg.start_time) || 0,
                end_time: Number(seg.end_time) || 0,
                action: seg.highlight ? 'popup' : 'skip', // highlight 为 true 时为重点
                content: seg.description || '',
                ad_type: seg.ad_type || (seg.highlight ? 'hard_ad' : 'soft_ad'),
                is_ai_segment: true // 标记为 AI 分析的片段
              }));

              // 保留现有的非 AI 分段（手动分段）
              const existingManualSegments = (sidebarState.segments || []).filter(s => !s.is_ai_segment);
              
              // 将 AI 分段添加到侧边栏，保留手动分段
              sidebarState.segments = [...existingManualSegments, ...aiSegments];
              console.log("[AdSkipper] AI 分段已添加到侧边栏:", aiSegments.length);
            } else {
              console.warn("[AdSkipper] AI 分析未返回分段数据 (ad_segments 为空)");
              // 如果没有 AI 分段，保留手动分段，移除旧的 AI 分段
              const existingManualSegments = (sidebarState.segments || []).filter(s => !s.is_ai_segment);
              sidebarState.segments = existingManualSegments;
            }

            console.log("[AdSkipper] ✅ 侧边栏数据已更新:");
            console.log("  - aiTitle:", sidebarState.aiTitle);
            console.log("  - aiSummary:", sidebarState.aiSummary ? sidebarState.aiSummary.substring(0, 50) + '...' : '');
            console.log("  - knowledgePoints:", sidebarState.knowledgePoints.length);
            console.log("  - hotWords:", sidebarState.hotWords.length);
            console.log("  - segments:", sidebarState.segments.length);

            // 刷新进度条标记
            this.addSegmentMarkers();
          }
        }
      } catch (error) {
        console.error("[AdSkipper] 分析视频出错:", error);
        if (sidebarState) {
          sidebarState.isLoading = false;
          sidebarState.loadError = '分析失败：' + error.message;
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

    updateCurrentSegmentDisplay(currentTime) {
      const display = document.getElementById('adskipper-segment-display');
      if (!display) return;

      // 优先使用 sidebarState 中的 segments (包含 AI 分段)
      const segments = (typeof sidebarState !== 'undefined' && sidebarState && sidebarState.segments) 
                        ? sidebarState.segments 
                        : this.segments;
      
      const activeSegment = segments.find(s => currentTime >= s.start_time && currentTime < s.end_time);

      if (activeSegment) {
            const text = activeSegment.content || activeSegment.description || '当前分段';
            // 只在内容变化时更新，避免闪烁
            if (display.textContent !== text) {
                display.textContent = text;
                display.title = text; // Tooltip for full text
                display.style.opacity = '1';
            }
      } else {
            // 如果没有分段，隐藏显示
            if (display.style.opacity !== '0') {
                display.style.opacity = '0';
            }
      }
    }

    // 更新后的 checkSkip 方法
    checkSkip(currentTime) {
      // 更新持久化显示组件
      this.updateCurrentSegmentDisplay(currentTime);

      if (sidebarState) {
        sidebarState.currentTime = currentTime;
        if (this.player.currentBvid) {
          sidebarState.bvid = this.player.currentBvid;
        }
        if (this.player.currentCid) {
          sidebarState.cid = this.player.currentCid;
        }
      }

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

      // 创建持久化分段信息显示组件
      const segmentDisplay = document.createElement('div');
      segmentDisplay.id = 'adskipper-segment-display';
      segmentDisplay.style.cssText = `
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: normal;
          margin-right: 15px;
          color: rgba(255, 255, 255, 0.9);
          font-size: 12px;
          line-height: 1.35;
          max-width: 55vw;
          user-select: none;
          pointer-events: auto; /* 允许鼠标交互，以便显示 title Tooltip */
          transition: opacity 0.3s ease;
          cursor: default;
          word-break: break-word;
      `;
      // 初始隐藏
      segmentDisplay.style.opacity = '0';

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
        white-space: nowrap; /* 防止按钮文字换行 */
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
        // Use native confirm for control panel popover (dark theme UI)
        const confirmed = confirm(`确定删除最近标注 ID: ${targetId} ?`);
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
        // 将 segmentDisplay 插入到 wrapper 前面，位于广告控制左侧
        target.insertBefore(segmentDisplay, wrapper);
      } else {
        target.appendChild(segmentDisplay);
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

      const res = await this.safeFetch(API_BASE + "/segments", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      }, 'submit annotation');

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

    showToast(msg, type = 'info') {
      const old = document.getElementById('adskipper-toast');
      if (old) old.remove();

      const t = document.createElement("div");
      t.id = 'adskipper-toast';
      
      // 截断过长的消息
      const displayMsg = msg.length > 20 ? msg.substring(0, 20) + '...' : msg;
      
      t.innerHTML = `
        <span style="margin-right: 6px;">${type === 'success' ? '✅' : (type === 'error' ? '❌' : '🚀')}</span>
        <span>${displayMsg}</span>
      `;

      // 尝试挂载到播放器容器内，以跟随全屏
      const playerContainer = document.querySelector('#bilibili-player') || document.body;
      const isPlayer = playerContainer.id === 'bilibili-player';

      t.style.cssText = `
        position: ${isPlayer ? 'absolute' : 'fixed'};
        bottom: ${isPlayer ? '80px' : '20%'};
        left: ${isPlayer ? '20px' : '50%'};
        ${!isPlayer ? 'transform: translateX(-50%);' : ''}
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(4px);
        color: #fff;
        padding: 8px 16px;
        border-radius: 4px;
        z-index: 100000;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        opacity: 0;
        transform: translateY(10px);
        transition: all 0.3s ease;
        pointer-events: none;
        display: flex;
        align-items: center;
      `;

      playerContainer.appendChild(t);

      // Animate in
      requestAnimationFrame(() => {
        t.style.opacity = '1';
        t.style.transform = 'translateY(0)';
        if (!isPlayer) {
           t.style.transform = 'translateX(-50%) translateY(0)';
        }
      });

      // Animate out and remove
      setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateY(10px)';
        if (!isPlayer) {
           t.style.transform = 'translateX(-50%) translateY(10px)';
        }
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
      // 移除旧标记
      const oldMarkers = document.querySelectorAll('.adskipper-progress-marker');
      oldMarkers.forEach(marker => marker.remove());

      // 获取所有需要显示的分段
      // 优先使用 sidebarState 中的 segments（包含 AI 分段和手动分段）
      // 如果 sidebarState 不可用，回退到 this.segments（仅包含广告/跳过分段）
      const segmentsToShow = (sidebarState && sidebarState.segments && sidebarState.segments.length > 0)
        ? sidebarState.segments
        : this.segments;

      if (!segmentsToShow || !segmentsToShow.length) {
        console.log('[AdSkipper] addSegmentMarkers: 没有分段需要显示');
        return;
      }

      // 查找进度条容器
      const progressContainer = document.querySelector('.bpx-player-progress') ||
        document.querySelector('.bilibili-player-video-progress') ||
        document.querySelector('.bpx-player-progress-wrap');
      
      if (!progressContainer) {
        console.warn('[AdSkipper] addSegmentMarkers: 未找到进度条容器 (.bpx-player-progress 等)');
        // 尝试延迟重试
        if (!this._markerRetryCount || this._markerRetryCount < 5) {
            this._markerRetryCount = (this._markerRetryCount || 0) + 1;
            console.log(`[AdSkipper] 进度条容器未找到，${this._markerRetryCount * 500}ms 后重试...`);
            setTimeout(() => this.addSegmentMarkers(), 500);
        }
        return;
      }
      // 重置重试计数
      this._markerRetryCount = 0;

      const duration = this.player.getState().duration;
      if (!duration || duration <= 0) {
        console.warn('[AdSkipper] addSegmentMarkers: 视频时长无效', duration);
        // 尝试延迟重试（可能是视频元数据尚未加载）
        setTimeout(() => this.addSegmentMarkers(), 1000);
        return;
      }

      // 尝试找到最佳挂载点
      const progressSlide = progressContainer.querySelector('.bpx-player-progress-schedule-wrap') || 
                            progressContainer.querySelector('.bpx-player-progress-slide') ||
                            progressContainer.querySelector('.bili-progress-slip') ||
                            progressContainer.querySelector('.bpx-player-progress-buffer');
      
      if (!progressSlide) {
        console.warn('[AdSkipper] addSegmentMarkers: 未找到进度条滑块 (.bpx-player-progress-schedule-wrap 等)');
        // 同样需要重试，因为可能外层容器有了但内层还没渲染
        if (!this._markerRetryCount || this._markerRetryCount < 10) {
            this._markerRetryCount = (this._markerRetryCount || 0) + 1;
            setTimeout(() => this.addSegmentMarkers(), 500);
        }
        return;
      }

      console.log(`[AdSkipper] 开始添加 ${segmentsToShow.length} 个进度条标记，时长: ${duration}s`);

      // 确保父容器有定位上下文
      const computedStyle = window.getComputedStyle(progressSlide);
      if (computedStyle.position === 'static') {
        progressSlide.style.position = 'relative';
      }

      let addedCount = 0;
      segmentsToShow.forEach((segment, index) => {
        // 确保时间有效
        const startTime = Number(segment.start_time);
        const endTime = Number(segment.end_time);
        
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
            return;
        }

        const startPercent = (startTime / duration) * 100;
        const endPercent = (endTime / duration) * 100;
        // 限制宽度在 0-100% 之间，且至少显示一点宽度以便可见
        const width = Math.max(Math.min(endPercent - startPercent, 100 - startPercent), 0.5); 

        const marker = document.createElement('div');
        marker.className = 'adskipper-progress-marker';
        marker.setAttribute('data-segment-id', this.getSegmentKey(segment, index));

        // 样式逻辑
        let markerColor, zIndex, height;
        
        if (segment.is_ai_segment) {
            // AI 内容分段：蓝色/青色，高度较低，不遮挡可能存在的广告标记
            markerColor = 'rgba(0, 255, 255, 0.7)'; 
            zIndex = '15';
            height = '40%'; // 占据下半部分
        } else if (segment.action === 'skip' || segment.ad_type) {
            // 广告分段：红色，全高
            markerColor = 'rgba(251, 114, 153, 0.9)';
            zIndex = '20'; // 广告优先级更高
            height = '100%';
        } else {
            // 其他（如 popup）：默认颜色
            markerColor = 'rgba(71, 167, 255, 0.88)';
            zIndex = '10';
            height = '60%';
        }

        marker.style.cssText = `
          position: absolute;
          left: ${startPercent}%;
          bottom: 0; 
          width: ${width}%;
          height: ${height};
          background: ${markerColor};
          pointer-events: auto; /* 允许交互 */
          z-index: ${zIndex};
          cursor: pointer;
          opacity: 0.8;
          transition: opacity 0.2s, height 0.2s;
          border-radius: 2px;
        `;

        // 悬停效果
        marker.onmouseenter = (e) => {
            marker.style.opacity = '1';
            marker.style.height = '100%'; // 悬停时展开全高
            this.showSegmentTooltip(e, segment);
        };

        marker.onmouseleave = () => {
            marker.style.opacity = '0.8';
            marker.style.height = height; // 恢复原高度
            this.hideSegmentTooltip();
        };

        // 点击跳转
        marker.onclick = (e) => {
            e.stopPropagation(); // 防止触发进度条原本的点击
            this.player.skipTo(startTime);
            // 移除 Toast 提示，依赖持久化显示组件
            this.updateCurrentSegmentDisplay(startTime);
        };

        progressSlide.appendChild(marker);
        addedCount++;
      });
      console.log(`[AdSkipper] 已添加 ${addedCount} 个标记`);

      // 添加 Observer 监听标记是否被意外移除
      if (this._markerObserver) {
          this._markerObserver.disconnect();
      }
      this._markerObserver = new MutationObserver((mutations) => {
          let needsReadd = false;
          for (const mutation of mutations) {
              if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
                  for (const node of mutation.removedNodes) {
                      if (node.classList && node.classList.contains('adskipper-progress-marker')) {
                          needsReadd = true;
                          break;
                      }
                  }
              }
          }
          if (needsReadd) {
              console.log('[AdSkipper] 检测到标记被移除，重新添加...');
              this._markerObserver.disconnect();
              this.addSegmentMarkers();
          }
      });
      this._markerObserver.observe(progressSlide, { childList: true });
    }



    showSegmentTooltip(event, segment) {
        let tooltip = document.getElementById('adskipper-segment-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'adskipper-segment-tooltip';
            tooltip.style.cssText = `
                position: fixed;
                z-index: 100000;
                background: rgba(0, 0, 0, 0.85);
                color: white;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 12px;
                pointer-events: none;
                max-width: 250px;
                box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                backdrop-filter: blur(4px);
                border: 1px solid rgba(255,255,255,0.1);
                transform: translate(-50%, -100%);
                margin-top: -10px;
            `;
            document.body.appendChild(tooltip);
        }

        const typeText = segment.is_ai_segment ? 'AI 总结' : (segment.ad_type ? typeLabels[segment.ad_type] || '广告' : '标注');
        const timeText = `${formatTime(segment.start_time)} - ${formatTime(segment.end_time)}`;
        const contentText = segment.content || segment.description || '无描述';

        tooltip.innerHTML = `
            <div style="font-weight:bold; margin-bottom:4px; color:#4fc3f7;">${typeText}</div>
            <div style="margin-bottom:4px;">${timeText}</div>
            <div style="color:rgba(255,255,255,0.8); line-height:1.4;">${contentText}</div>
        `;

        // 定位
        const rect = event.target.getBoundingClientRect();
        const left = rect.left + rect.width / 2;
        const top = rect.top;
        
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.display = 'block';
    }

    hideSegmentTooltip() {
        const tooltip = document.getElementById('adskipper-segment-tooltip');
        if (tooltip) {
            tooltip.style.display = 'none';
        }
    }


    handleShowMarkers() {
      this.showSidebar({ refresh: true });
    }
  }

  new AdSkipperCore().init();
})();


