class BilibiliPlayerController {
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
    const bvidMatch = window.location.pathname.match(/BV\w+/);
    this.currentBvid = bvidMatch ? bvidMatch[0] : null;
    
    try {
      if (window.__INITIAL_STATE__?.videoData?.cid) {
        this.currentCid = window.__INITIAL_STATE__.videoData.cid;
      } else {
        // 从弹幕接口推断
        const scripts = document.querySelectorAll('script');
        for (let s of scripts) {
          const m = s.textContent.match(/"cid":(\d+)/);
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
