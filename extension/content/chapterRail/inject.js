import { createApp, h, ref } from 'vue';
import Timeline from './Timeline.vue';

const PLAYER_CONTAINER_SELECTOR = '.bpx-player-video-wrap, .bpx-player-video-area';
const VIDEO_SELECTOR = 'video';
const MOUNT_ID = 'visionmark-ai-timeline-root';
const MOUNT_Z_INDEX = '5';
const ROUTE_CHANGE_EVENT = 'visionmark:spa-route-change';
const ROUTE_POLL_INTERVAL_MS = 800;
const BVID_PATTERN = /(BV[0-9A-Za-z]+)/i;
const API_BASE = window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080';
const API_VERSION = window.LOCAL_CONFIG?.API_VERSION || 'api/v1';

export const CHAPTER_API_URL = window.VISIONMARK_CHAPTER_API_URL || `${API_BASE}/${API_VERSION}/video-view`;

function getRouteMonitorState() {
  if (!window.__VISIONMARK_ROUTE_MONITOR__) {
    window.__VISIONMARK_ROUTE_MONITOR__ = {
      installed: false,
      lastHref: '',
      lastBvid: '',
      pollTimer: null
    };
  }

  return window.__VISIONMARK_ROUTE_MONITOR__;
}

function extractBvidFromValue(value) {
  if (typeof value !== 'string') return '';

  const match = value.match(BVID_PATTERN);
  return match ? match[1] : '';
}

export function getCurrentBvid() {
  const urlBvid = extractBvidFromValue(window.location.href);
  if (urlBvid) return urlBvid;

  const initialState = window.__INITIAL_STATE__ || {};
  const bvidCandidates = [
    initialState?.bvid,
    initialState?.videoData?.bvid,
    initialState?.epInfo?.bvid,
    initialState?.mediaInfo?.bvid
  ];

  for (const candidate of bvidCandidates) {
    const matchedBvid = extractBvidFromValue(candidate);
    if (matchedBvid) {
      return matchedBvid;
    }
  }

  return '';
}

function emitRouteChangeIfNeeded(force = false) {
  const state = getRouteMonitorState();
  const href = window.location.href;
  const bvid = getCurrentBvid();

  if (!force && href === state.lastHref && bvid === state.lastBvid) {
    return;
  }

  state.lastHref = href;
  state.lastBvid = bvid;

  window.dispatchEvent(new CustomEvent(ROUTE_CHANGE_EVENT, {
    detail: { href, bvid }
  }));
}

function ensureRouteMonitorInstalled() {
  const state = getRouteMonitorState();
  if (state.installed) return;

  state.installed = true;
  state.lastHref = window.location.href;
  state.lastBvid = getCurrentBvid();

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function pushStatePatched(...args) {
    const result = originalPushState(...args);
    Promise.resolve().then(() => emitRouteChangeIfNeeded());
    return result;
  };

  history.replaceState = function replaceStatePatched(...args) {
    const result = originalReplaceState(...args);
    Promise.resolve().then(() => emitRouteChangeIfNeeded());
    return result;
  };

  window.addEventListener('popstate', () => {
    emitRouteChangeIfNeeded();
  });

  window.addEventListener('hashchange', () => {
    emitRouteChangeIfNeeded();
  });

  state.pollTimer = window.setInterval(() => {
    emitRouteChangeIfNeeded();
  }, ROUTE_POLL_INTERVAL_MS);
}

export function watchBilibiliSpaRoute(callback) {
  ensureRouteMonitorInstalled();

  const listener = (event) => {
    callback(event.detail || {
      href: window.location.href,
      bvid: getCurrentBvid()
    });
  };

  window.addEventListener(ROUTE_CHANGE_EVENT, listener);
  callback({
    href: window.location.href,
    bvid: getCurrentBvid()
  });

  return () => {
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener);
  };
}

class ChapterTimelineInjector {
  constructor() {
    this.app = null;
    this.container = null;
    this.video = null;
    this.mountPoint = null;
    this.observer = null;
    this.pollTimer = null;
    this.stopRouteWatch = null;
    this.started = false;
    this.bvidSource = ref(getCurrentBvid());
    this.videoSource = ref(null);
  }

  init() {
    if (this.started) return;

    this.started = true;
    this.stopRouteWatch = watchBilibiliSpaRoute(({ bvid }) => {
      const nextBvid = typeof bvid === 'string' ? bvid : '';

      if (nextBvid !== this.bvidSource.value) {
        this.bvidSource.value = nextBvid;
        this.video = null;
        this.videoSource.value = null;
      }

      this.ensureMounted();
    });

    this.ensureMounted();

    this.observer = new MutationObserver(() => {
      this.ensureMounted();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.pollTimer = window.setInterval(() => {
      const latestBvid = getCurrentBvid();
      if (latestBvid !== this.bvidSource.value) {
        this.bvidSource.value = latestBvid;
        this.video = null;
        this.videoSource.value = null;
      }

      this.ensureMounted();
    }, 1200);
  }

  ensureMounted() {
    const target = this.findTarget();

    if (!target) {
      if (this.mountPoint && !this.mountPoint.isConnected) {
        this.unmount();
      }
      return;
    }

    const shouldRemount = !this.mountPoint
      || !this.mountPoint.isConnected
      || this.container !== target.container;

    if (shouldRemount) {
      this.unmount();
      this.mount(target.container, target.video);
      return;
    }

    if (this.video !== target.video) {
      this.video = target.video;
      this.videoSource.value = target.video;
    }
  }

  findTarget() {
    const containers = Array.from(document.querySelectorAll(PLAYER_CONTAINER_SELECTOR));

    for (const container of containers) {
      const video = container.querySelector(VIDEO_SELECTOR);
      if (video) {
        return { container, video };
      }
    }

    const video = document.querySelector(VIDEO_SELECTOR);
    const container = video?.closest(PLAYER_CONTAINER_SELECTOR);

    if (!video || !container) return null;

    return { container, video };
  }

  mount(container, video) {
    this.container = container;
    this.video = video;
    this.videoSource.value = video;

    this.mountPoint = document.createElement('div');
    this.mountPoint.id = MOUNT_ID;
    this.mountPoint.dataset.visionmarkAiTimeline = 'true';
    this.mountPoint.style.cssText = [
      'position:absolute',
      'left:0',
      'bottom:0',
      'width:100%',
      'height:26px',
      `z-index:${MOUNT_Z_INDEX}`,
      'pointer-events:none'
    ].join(';');

    const computedStyle = window.getComputedStyle(container);
    if (computedStyle.position === 'static') {
      container.dataset.visionmarkTimelinePositionPatched = 'true';
      container.dataset.visionmarkTimelinePrevPosition = container.style.position || '';
      container.style.position = 'relative';
    }

    container.appendChild(this.mountPoint);

    const bvidSource = this.bvidSource;
    const videoSource = this.videoSource;

    this.app = createApp({
      name: 'VisionMarkChapterTimelineHost',
      setup() {
        return () => h(Timeline, {
          bvid: bvidSource.value,
          videoElement: videoSource.value,
          apiUrl: CHAPTER_API_URL
        });
      }
    });

    this.app.mount(this.mountPoint);
  }

  unmount() {
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }

    if (this.mountPoint?.isConnected) {
      this.mountPoint.remove();
    }

    if (this.container?.dataset?.visionmarkTimelinePositionPatched === 'true') {
      this.container.style.position = this.container.dataset.visionmarkTimelinePrevPosition || '';
      delete this.container.dataset.visionmarkTimelinePositionPatched;
      delete this.container.dataset.visionmarkTimelinePrevPosition;
    }

    this.container = null;
    this.video = null;
    this.videoSource.value = null;
    this.mountPoint = null;
  }

  destroy() {
    if (this.stopRouteWatch) {
      this.stopRouteWatch();
      this.stopRouteWatch = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.unmount();
    this.started = false;
  }
}

export function createChapterTimelineInjector() {
  return new ChapterTimelineInjector();
}
