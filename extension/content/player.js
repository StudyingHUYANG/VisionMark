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
    const selectors = [
      'video[src*="bilivideo"]',
      'video[class*="bilateral-player"]',
      'bpx-player-video-wrap video',
      '.bilibili-player-video video',
      'video'
    ];

    for (const selector of selectors) {
      const video = document.querySelector(selector);
      // Relaxed check: don't require readyState >= 1 immediately for initial detection
      if (video) {
        this.video = video;
        console.log('[AdSkipper] Video found');
        break;
      }
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

  extractVideoId() {
    const match = window.location.pathname.match(/BV[a-zA-Z0-9]+/);
    this.currentBvid = match ? match[0] : null;
    console.log('[AdSkipper] BVID:', this.currentBvid);
  }

  setupListeners() {
    if (!this.video) return;
    setInterval(() => {
      if (this.onTimeUpdate) {
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
