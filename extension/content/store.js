import { reactive } from 'vue';

export const videoState = reactive({
  currentTime: 0,
  bvid: null,
  cid: null,
  aiSummary: '',
  segments: [],
  isLoading: false,
  loadError: '',
  activeSegmentKey: null
});

