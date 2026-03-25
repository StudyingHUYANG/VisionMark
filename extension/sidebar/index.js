import { createApp, h, reactive } from 'vue';
import SidebarContainer from './components/SidebarContainer.vue';
import './styles/variables.css';

// Shared state - exported for main.js to access directly
const sidebarState = reactive({
  isVisible: false,
  modelConfigVisible: false,
  isLoading: false,
  loadError: null,
  bvid: null,
  cid: null,
  aiSummary: '',
  aiTitle: '',
  knowledgePoints: [],
  hotWords: [],
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
  const app = createApp({
    name: 'VisionMarkSidebarRoot',
    render() {
      return h(SidebarContainer, {
        visible: sidebarState.isVisible,
        bvid: sidebarState.bvid,
        segmentCount: sidebarState.segments.length,
        summary: sidebarState.aiSummary,
        aiTitle: sidebarState.aiTitle,
        knowledgePoints: sidebarState.knowledgePoints,
        hotWords: sidebarState.hotWords,
        segments: sidebarState.segments,
        activeKey: sidebarState.activeSegmentKey,
        modelConfigVisible: sidebarState.modelConfigVisible,
        loading: sidebarState.isLoading,
        error: sidebarState.loadError,
        'onUpdate:visible': (value) => {
          sidebarState.isVisible = value;
        },
        'onUpdate:modelConfigVisible': (value) => {
          sidebarState.modelConfigVisible = value;
        },
        onSeek: (time) => {
          window.dispatchEvent(new CustomEvent('visionmark:seek', {
            detail: { time: Number(time) || 0 }
          }));
        },
        onRefresh: () => {
          window.dispatchEvent(new Event('visionmark:refresh-ai'));
        },
        onDelete: (segmentId) => {
          window.dispatchEvent(new CustomEvent('visionmark:delete-segment', {
            detail: { segmentId: Number(segmentId) }
          }));
        }
      });
    }
  });

  const instance = app.mount(container);

  console.log('[VisionMark Sidebar] Sidebar mounted successfully');

  return {
    app,
    instance,
    state: sidebarState,
    show: () => { sidebarState.isVisible = true; },
    hide: () => { sidebarState.isVisible = false; },
    toggle: () => { sidebarState.isVisible = !sidebarState.isVisible; },
    showModelConfig: () => { sidebarState.modelConfigVisible = true; },
    hideModelConfig: () => { sidebarState.modelConfigVisible = false; },
    updateData: (data) => {
      if (data.bvid !== undefined) sidebarState.bvid = data.bvid;
      if (data.cid !== undefined) sidebarState.cid = data.cid;
      if (data.aiSummary !== undefined) sidebarState.aiSummary = data.aiSummary;
      if (data.aiTitle !== undefined) sidebarState.aiTitle = data.aiTitle;
      if (data.knowledgePoints !== undefined) sidebarState.knowledgePoints = data.knowledgePoints;
      if (data.hotWords !== undefined) sidebarState.hotWords = data.hotWords;
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
