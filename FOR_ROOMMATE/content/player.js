class BilibiliPlayerController {
  constructor() {
    this.video = null;
    this.currentBvid = null;
    this.currentCid = null;
    this.onTimeUpdate = null;
  }

  async init() {
    console.log("[AdSkipper] 查找视频...");
    return new Promise((resolve) => this.tryFindVideo(resolve, 0));
  }

  tryFindVideo(callback, attempts) {
    const selectors = [
      'video[src*="bilivideo"]', 'video[class*="bilateral-player"]',
      'bpx-player-video-wrap video', '.bilibili-player-video video', 'video'
    ];
    
    for (let sel of selectors) {
      const v = document.querySelector(sel);
      if (v && v.readyState >= 1) { 
        this.video = v; 
        console.log("[AdSkipper] 找到视频");
        break; 
      }
    }

    if (this.video) {
      this.extractVideoId();
      this.setupListeners();
      callback(true);
    } else if (attempts < 30) {
      setTimeout(() => this.tryFindVideo(callback, attempts + 1), 500);
    } else {
      callback(false);
    }
  }

  extractVideoId() {
    const m = window.location.pathname.match(/BV[a-zA-Z0-9]+/);
    this.currentBvid = m ? m[0] : null;
    console.log("[AdSkipper] BVID:", this.currentBvid);
  }

  setupListeners() {
    if (!this.video) return;
    setInterval(() => {
      if (this.onTimeUpdate) this.onTimeUpdate(this.video.currentTime);
    }, 200);
  }

  skipTo(time) {
    if (!this.video) return false;
    try { 
      this.video.currentTime = time; 
      return true; 
    } catch(e) { 
      return false; 
    }
  }

  getState() {
    return {
      currentTime: this.video ? this.video.currentTime : 0,
      bvid: this.currentBvid,
      cid: this.currentCid
    };
  }
}