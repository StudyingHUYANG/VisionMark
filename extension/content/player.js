class BilibiliPlayerController {
  constructor() {
    this.video = null;
    this.currentBvid = null;
    this.currentCid = null;
    this.onTimeUpdate = null;
  }

  async init() {
    console.log('[AdSkipper] Looking for video element...');
    return new Promise((resolve) => this.tryFindVideo(resolve, 0));
  }

  tryFindVideo(callback, attempts) {
    const video = this.findVideoElement();
    if (video) {
      this.video = video;
      console.log('[AdSkipper] Video found');
    }

    if (this.video) {
      this.extractVideoId();
      this.setupListeners();
      callback(true);
      return;
    }

    if (attempts < 30) {
      setTimeout(() => this.tryFindVideo(callback, attempts + 1), 500);
      return;
    }

    callback(false);
  }

  findVideoElement() {
    const selectors = [
      'video[src*="bilivideo"]',
      'video[class*="bilateral-player"]',
      'bpx-player-video-wrap video',
      '.bilibili-player-video video',
      'video'
    ];

    for (const selector of selectors) {
      const video = document.querySelector(selector);
      if (video) {
        return video;
      }
    }

    return null;
  }

  extractVideoId() {
    const urlMatch = window.location.href.match(/BV[a-zA-Z0-9]+/i);

    if (urlMatch) {
      this.currentBvid = urlMatch[0];
    } else {
      const initialState = window.__INITIAL_STATE__ || {};
      const candidates = [
        initialState?.bvid,
        initialState?.videoData?.bvid,
        initialState?.epInfo?.bvid,
        initialState?.mediaInfo?.bvid
      ];

      const matchedBvid = candidates.find((candidate) => typeof candidate === 'string' && /^BV[a-zA-Z0-9]+$/i.test(candidate));
      this.currentBvid = matchedBvid || null;
    }

    const initialState = window.__INITIAL_STATE__ || {};
    const cidCandidates = [
      initialState?.cid,
      initialState?.videoData?.cid,
      initialState?.epInfo?.cid,
      initialState?.mediaInfo?.cid
    ];
    const matchedCid = cidCandidates.find((candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0);
    this.currentCid = matchedCid ? Number(matchedCid) : null;
    console.log('[AdSkipper] BVID:', this.currentBvid);
  }

  refreshContext(nextBvid = null) {
    const nextVideo = this.findVideoElement();
    if (nextVideo) {
      this.video = nextVideo;
    }

    if (nextBvid) {
      this.currentBvid = nextBvid;
    } else {
      this.extractVideoId();
    }

    return Boolean(this.video);
  }

  setupListeners() {
    setInterval(() => {
      // 在 B 站这种 SPA 单页应用中，切换视频时页面不刷新但 URL 会变
      const match = window.location.pathname.match(/BV[a-zA-Z0-9]+/);
      const newBvid = match ? match[0] : null;
      
      if (newBvid && newBvid !== this.currentBvid) {
        console.log('[AdSkipper] BVID changed from', this.currentBvid, 'to', newBvid);
        this.extractVideoId();
        
        // 当视频切换时，原有 video 元素可能被销毁或替换，重新获取
        const video = this.findVideoElement();
        if (video) {
          this.video = video;
        }
      }

      if (this.video && this.onTimeUpdate) {
        this.onTimeUpdate(this.video.currentTime);
      }
    }, 200);
  }

  skipTo(time) {
    if (!this.video) return false;
    try {
      this.video.currentTime = time;
      return true;
    } catch (error) {
      return false;
    }
  }

  getState() {
    const duration = this.video && Number.isFinite(this.video.duration) ? this.video.duration : 0;
    const playbackRate = this.video && Number.isFinite(this.video.playbackRate) && this.video.playbackRate > 0
      ? this.video.playbackRate
      : 1;
    return {
      currentTime: this.video ? this.video.currentTime : 0,
      duration,
      paused: this.video ? Boolean(this.video.paused) : true,
      playbackRate,
      bvid: this.currentBvid,
      cid: this.currentCid
    };
  }
}

window.BilibiliPlayerController = BilibiliPlayerController;

async function fetchAnalysisResults(videoId) {
  const url = `${window.API_BASE}/video-analysis/${videoId}`;
  const maxRetries = 3;
  let retries = 0;

  // 设置超时时间
  const timeout = 10000; // 10秒超时
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  while (retries < maxRetries) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': localStorage.getItem('user_token') // 如果需要认证
        },
        signal: controller.signal // 添加超时控制
      });

      clearTimeout(id); // 清除超时定时器

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`Fetch failed, retrying... (${retries + 1}/${maxRetries})`, error);
      retries++;
      if (retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒后重试
      }
    }
  }

  clearTimeout(id); // 清除超时定时器
  throw new Error('Failed to fetch analysis results after multiple attempts');
}
