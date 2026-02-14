// 从本地配置文件读取（优先）或使用默认值
window.API_BASE = (window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080') + '/' + (window.LOCAL_CONFIG?.API_VERSION || 'api/v1');

window.CONFIG = {
  CHECK_INTERVAL: 200,
  CONFIDENCE_THRESHOLD: 0.7,
  MIN_VOTES: 3,
  SELECTORS: {
    video: ['bpx-player-video-wrap video', '#bilibiliPlayer video', '.bilibili-player-video video'],
    title: 'h1.video-title'
  },
  WILSON_Z: 1.96
};

const AD_TYPES = {
  HARD_AD: 'hard_ad',
  SOFT_AD: 'soft_ad',
  PRODUCT_PLACEMENT: 'product_placement',
  INTRO_AD: 'intro_ad',
  MID_AD: 'mid_ad'
};

const STORAGE_KEYS = {
  SEGMENTS_CACHE: 'ad_segments_cache',
  USER_TOKEN: 'user_token'
};
