import { createApp, reactive, readonly } from 'vue';
import SidebarContainer from './components/SidebarContainer.vue';
import './styles/variables.css';

// Shared state - exported for main.js to access directly
const sidebarState = reactive({
  isVisible: true,
  isLoading: false,
  loadError: null,
  bvid: null,
  cid: null,
  aiSummary: '',
  segments: [],
  activeSegmentKey: null,
  currentTime: 0
});

/**
 * Create and mount the sidebar to a DOM element
 * @param {HTMLElement} container - The DOM element to mount the sidebar to
 * @returns {Object} Controller object with methods to control the sidebar
 */
export function createSidebar(container) {
  const app = createApp(SidebarContainer, {
    visible: sidebarState.isVisible,
    bvid: sidebarState.bvid,
    segmentCount: sidebarState.segments.length,
    summary: sidebarState.aiSummary,
    segments: readonly(sidebarState.segments),
    activeKey: sidebarState.activeSegmentKey,
    loading: sidebarState.isLoading,
    error: sidebarState.loadError,
    'onUpdate:visible': (value) => {
      sidebarState.isVisible = value;
    },
    onSeek: (time) => {
      window.dispatchEvent(new CustomEvent('visionmark:seek', {
        detail: { time: Number(time) || 0 }
      }));
    },
    onRefresh: () => {
      window.dispatchEvent(new Event('visionmark:refresh-ai'));
    }
  });

  // Watch state changes and update props
  const unwatch = app.config.globalProperties.$watchEffect = () => {};

  const instance = app.mount(container);

  console.log('[VisionMark Sidebar] Sidebar mounted successfully');

  return {
    app,
    instance,
    state: sidebarState,
    show: () => { sidebarState.isVisible = true; },
    hide: () => { sidebarState.isVisible = false; },
    toggle: () => { sidebarState.isVisible = !sidebarState.isVisible; },
    updateData: (data) => {
      if (data.bvid !== undefined) sidebarState.bvid = data.bvid;
      if (data.cid !== undefined) sidebarState.cid = data.cid;
      if (data.aiSummary !== undefined) sidebarState.aiSummary = data.aiSummary;
      if (data.segments !== undefined) sidebarState.segments = data.segments;
      if (data.isLoading !== undefined) sidebarState.isLoading = data.isLoading;
      if (data.loadError !== undefined) sidebarState.loadError = data.loadError;
    },
    setActiveSegment: (key) => {
      sidebarState.activeSegmentKey = key;
    }
  };
}

// Export the reactive state for direct access from main.js
export { sidebarState };