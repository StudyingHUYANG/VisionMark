class BilibiliPlayerController {
  constructor() {
    this.video = null;
    this.currentBvid = null;
    this.currentCid = null;
    this.init();
  }

  init() {
    // 查找B站视频播放器
    const videoElement = document.querySelector('video');
    if (videoElement) {
      this.video = videoElement;
      this.extractVideoInfo();
    }
    
    // 监听页面变化，因为B站是SPA应用
    const observer = new MutationObserver(() => {
      const newVideo = document.querySelector('video');
      if (newVideo && newVideo !== this.video) {
        this.video = newVideo;
        this.extractVideoInfo();
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }

  extractVideoInfo() {
    try {
      // 从URL中提取BV号
      const url = window.location.href;
      const bvidMatch = url.match(/\/video\/(BV\w+)/);
      if (bvidMatch) {
        this.currentBvid = bvidMatch[1];
      }
      
      // 从页面中提取CID（如果需要）
      // 这里可以根据实际需求实现
    } catch (error) {
      console.warn('[AdSkipper] 无法提取视频信息:', error);
    }
  }

  getCurrentState() {
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