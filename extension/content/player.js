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
      console.log('[AdSkipper] BVID:', this.currentBvid);
      return;
    }

    const initialState = window.__INITIAL_STATE__ || {};
    const candidates = [
      initialState?.bvid,
      initialState?.videoData?.bvid,
      initialState?.epInfo?.bvid,
      initialState?.mediaInfo?.bvid
    ];

    const matchedBvid = candidates.find((candidate) => typeof candidate === 'string' && /^BV[a-zA-Z0-9]+$/i.test(candidate));
    this.currentBvid = matchedBvid || null;
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
