import { reactive, computed, readonly } from 'vue';

const state = reactive({
  isVisible: false,
  isLoading: false,
  loadError: null,
  bvid: null,
  cid: null,
  aiSummary: '',
  segments: [],
  activeSegmentKey: null,
  analysisProgress: null,
  currentTime: 0
});

// Getters
const sortedSegments = computed(() =>
  [...state.segments].sort((a, b) => a.start_time - b.start_time)
);

const segmentCount = computed(() => state.segments.length);

// Actions
function setVisible(value) {
  state.isVisible = value;
}

function toggle() {
  state.isVisible = !state.isVisible;
}

function setVideoData(data) {
  state.bvid = data.bvid || null;
  state.cid = data.cid || null;
  state.aiSummary = data.aiSummary || '';
  state.segments = data.segments || [];
  state.loadError = data.error || null;
}

function setActiveSegment(key) {
  state.activeSegmentKey = key;
}

function setLoading(loading) {
  state.isLoading = loading;
}

function setError(error) {
  state.loadError = error;
}

export function useSidebarState() {
  return {
    state: readonly(state),
    sortedSegments,
    segmentCount,
    setVisible,
    toggle,
    setVideoData,
    setActiveSegment,
    setLoading,
    setError
  };
}

// Export raw state for main.js direct access
export { state as sidebarState };
