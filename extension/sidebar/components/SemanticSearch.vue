<template>
  <div class="vm-semantic-search-wrapper">
    <!-- 向量预处理进度提示 -->
    <div v-if="scope === 'current' && (vectorProgressState.status === 'running' || vectorProgressState.status === 'error')" class="vm-vector-progress-container" :class="{ 'is-error': vectorProgressState.status === 'error' }">
      <div class="vm-vector-progress-header">
        <span>{{ vectorProgressState.status === 'error' ? '画面索引失败' : '正在为语义搜索索引画面' }}</span>
        <span>{{ vectorProgressState.percent }}%</span>
      </div>
      <div class="vm-vector-progress-bar">
        <div class="vm-vector-progress-fill" :style="{ width: `${vectorProgressState.percent}%` }"></div>
      </div>
      <div class="vm-vector-progress-msg">
        {{ vectorProgressState.message }}
      </div>
    </div>

    <!-- 查看已解析画面按钮 -->
    <div v-if="scope === 'current' && framesList.length > 0 && vectorProgressState.status !== 'running'" class="vm-frames-dropdown">
      <button class="vm-frames-btn" @click="showFrames = !showFrames">
        <span>可用检索画面 ({{ framesList.length }}帧)</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ 'is-open': showFrames }">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div v-show="showFrames" class="vm-frames-list">
        <div
          v-for="(frame, idx) in framesList"
          :key="idx"
          class="vm-frame-item"
          @click="selectResult(frame)"
          title="点击跳转到该帧"
        >
          帧时间点: {{ formatTime(frame.timestamp) }}
        </div>
      </div>
    </div>

    <!-- 搜索框本体 -->
    <div class="vm-semantic-search" :class="{ 'disabled': searchDisabled }">
      <div class="vm-search-scope" role="group" aria-label="搜索范围">
        <button
          type="button"
          :class="{ 'is-active': scope === 'current' }"
          @click="scope = 'current'"
        >
          当前视频
        </button>
        <button
          type="button"
          :class="{ 'is-active': scope === 'library' }"
          @click="scope = 'library'"
        >
          我的视频库
        </button>
      </div>
      <div class="vm-search-box" :class="{ 'is-active': isFocused || query }">
        <svg class="vm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          v-model="query"
          :placeholder="searchPlaceholder"
          @keyup.enter="handleSearch"
          @focus="isFocused = true"
          @blur="isFocused = false"
          :disabled="searchDisabled"
        />
        <button v-if="query" class="vm-search-clear" @click="clearSearch" :disabled="searchDisabled">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 搜索结果下拉面板 -->
      <div v-if="results.length > 0 || errorMessage || (hasSearched && query && !scopeBlocked)" class="vm-search-results">
        <div v-if="loading" class="vm-search-loading">
          <div class="loader-spinner"></div>
          <span>正在匹配画面...</span>
        </div>
        <template v-else>
          <div v-if="errorMessage" class="vm-search-error">
            {{ errorMessage }}
          </div>
          <div v-else-if="results.length === 0" class="vm-search-empty">
            未能找到匹配画面的时间点
          </div>
          <div
            v-for="(item, index) in results"
            :key="index"
            class="vm-search-item"
            @click="selectResult(item)"
          >
            <div class="vm-search-result-main">
              <div class="vm-search-result-heading">
                <span class="vm-search-title">{{ item.videoTitle || item.bvid || '未命名视频' }}</span>
                <span class="vm-search-time">
                  {{ formatTime(item.startTime ?? item.timestamp) }}–{{ formatTime(item.endTime ?? item.timestamp) }}
                </span>
              </div>
              <div v-if="item.description" class="vm-search-description">{{ item.description }}</div>
              <div v-if="formatEvidence(item.evidence)" class="vm-search-evidence">
                依据：{{ formatEvidence(item.evidence) }}
              </div>
            </div>
            <div class="vm-search-score">
              <div class="score-bar-bg">
                <div class="score-bar-fill" :style="{ width: `${safeScore(item.score) * 100}%` }"></div>
              </div>
              <span>{{ (safeScore(item.score) * 100).toFixed(0) }}%</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { createSearchRequestGuard } from '../utils/searchRequestGuard.mjs';

const props = defineProps({
  bvid: {
    type: String,
    required: true
  }
});

const emit = defineEmits(['seek']);

const query = ref('');
const scope = ref('current');
const isFocused = ref(false);
const loading = ref(false);
const results = ref([]);
const hasSearched = ref(false);
const errorMessage = ref('');
const vectorProgressState = ref({ status: 'idle', percent: 0, message: '' });
const framesList = ref([]);
const showFrames = ref(false);
let progressInterval = null;

const expireSession = async () => {
  await new Promise(resolve => chrome.storage.local.remove(['adskipper_token'], resolve));
  searchRequestGuard.invalidate();
  loading.value = false;
  errorMessage.value = '登录已过期，请打开 VisionMark 插件重新登录';
  vectorProgressState.value = {
    status: 'error',
    percent: 0,
    message: '登录已过期，请重新登录'
  };
  stopPolling();
  window.dispatchEvent(new CustomEvent('visionmark-auth-expired'));
};
const searchRequestGuard = createSearchRequestGuard();

const scopeBlocked = computed(() =>
  scope.value === 'current' && vectorProgressState.value.status === 'running'
);
const searchDisabled = computed(() => loading.value || scopeBlocked.value);
const searchPlaceholder = computed(() => {
  if (scopeBlocked.value) return '等待当前视频画面索引完成...';
  return scope.value === 'library'
    ? '搜索我的视频库'
    : '搜索当前视频画面';
});

const formatTime = (seconds) => {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const safeScore = (score) => {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return 0;
  return Math.min(1, Math.max(0, numericScore));
};

const formatEvidence = (evidence) => {
  if (!evidence) return '';
  if (typeof evidence === 'string') return evidence;
  if (Array.isArray(evidence)) return evidence.filter(Boolean).join('、');
  if (typeof evidence === 'object') {
    const reasons = Array.isArray(evidence.reasons) ? evidence.reasons.filter(Boolean) : [];
    const cutTimes = Array.isArray(evidence.candidateCutTimes)
      ? evidence.candidateCutTimes.filter(value => Number.isFinite(Number(value))).map(formatTime)
      : [];
    return [...reasons, ...cutTimes.map(time => `切点 ${time}`)].join('、');
  }
  return String(evidence);
};

const clearSearch = () => {
  searchRequestGuard.invalidate();
  loading.value = false;
  query.value = '';
  results.value = [];
  hasSearched.value = false;
  errorMessage.value = '';
};

const fetchFramesList = async () => {
  if (!props.bvid) return;
  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token || '';

    const response = await fetch(`${apiBase}/search/frames?bvid=${props.bvid}`, {
      headers: { 'Authorization': token ? `Bearer ${token}` : '' }
    });

    if (response.status === 401) {
      await expireSession();
      return;
    }

    if (response.ok) {
      const data = await response.json();
      if (data.frames) {
        framesList.value = data.frames;
      }
    }
  } catch(e) {
    console.error('Failed to fetch frames list', e);
  }
};

const selectResult = (item) => {
  const targetTime = Number(item.startTime ?? item.timestamp ?? 0);
  if (!item.bvid || item.bvid === props.bvid) {
    emit('seek', Number.isFinite(targetTime) ? targetTime : 0);
    return;
  }

  const safeBvid = String(item.bvid).replace(/[^A-Za-z0-9]/g, '');
  if (!safeBvid) return;
  const seconds = Math.max(0, Math.floor(Number.isFinite(targetTime) ? targetTime : 0));
  const url = `https://www.bilibili.com/video/${encodeURIComponent(safeBvid)}?t=${seconds}`;
  if (globalThis.chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

const pollVectorProgress = async () => {
  if (!props.bvid) return;
  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token;

    // Check vector status to display progress
    // videoAnalysisRouter is mounted at /video-analysis, not /api/v1/video-analysis
    const hostBase = window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080';
    const response = await fetch(`${hostBase}/video-analysis/vector-progress?bvid=${props.bvid}`, {
      headers: { 'Authorization': token ? `Bearer ${token}` : '' }
    });

    if (response.status === 401) {
      await expireSession();
      return;
    }

    if (response.ok) {
      const data = await response.json();
      vectorProgressState.value = data;

      if (data.status === 'completed' || data.status === 'error') {
        stopPolling();
        if (data.status === 'completed') {
          fetchFramesList(); // 获取最新帧列表
        }
      }
    }
  } catch(e) {
    console.error('Failed to fetch vector progress', e);
  }
};

const startPolling = () => {
  if (progressInterval) clearInterval(progressInterval);
  pollVectorProgress();
  progressInterval = setInterval(pollVectorProgress, 1500);
};

const stopPolling = () => {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
};

onMounted(() => {
  fetchFramesList();
  startPolling();
});

onUnmounted(() => {
  stopPolling();
});

watch(() => props.bvid, (newVal) => {
  searchRequestGuard.invalidate();
  loading.value = false;
  if (newVal) {
    vectorProgressState.value = { status: 'idle', percent: 0, message: '' };
    framesList.value = [];
    showFrames.value = false;
    results.value = [];
    errorMessage.value = '';
    hasSearched.value = false;
    fetchFramesList();
    startPolling();
  }
});

watch(scope, () => {
  searchRequestGuard.invalidate();
  loading.value = false;
  results.value = [];
  errorMessage.value = '';
  hasSearched.value = false;
});

const handleSearch = async () => {
  const normalizedQuery = query.value.trim();
  if (!normalizedQuery || (scope.value === 'current' && !props.bvid) || scopeBlocked.value) return;

  loading.value = true;
  hasSearched.value = true;
  results.value = [];
  errorMessage.value = '';
  const requestId = searchRequestGuard.begin();

  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const params = new URLSearchParams({
      scope: scope.value,
      q: normalizedQuery,
      topk: scope.value === 'library' ? '10' : '3'
    });
    if (scope.value === 'current') params.set('bvid', props.bvid);
    const searchUrl = `${apiBase}/search/semantic?${params.toString()}`;
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token;

    // In extension context, we can fetch directly
    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': token ? `Bearer ${token}` : ''
      }
    });

    const data = await response.json();
    if (!searchRequestGuard.isCurrent(requestId)) return;
    if (response.status === 401) {
      await expireSession();
      return;
    }
    if (!response.ok || !data.success) {
      throw new Error(data?.error?.message || data?.message || '语义搜索失败');
    }
    results.value = data.results || [];
  } catch (error) {
    if (!searchRequestGuard.isCurrent(requestId)) return;
    console.error('Semantic search error:', error);
    errorMessage.value = error?.message || '语义搜索失败，请稍后重试';
  } finally {
    if (searchRequestGuard.isCurrent(requestId)) loading.value = false;
  }
};
</script>

<style scoped>
.vm-semantic-search-wrapper {
  display: flex;
  flex-direction: column;
}

.vm-vector-progress-container {
  margin: 0 16px 12px 16px;
  padding: 12px;
  background: #f4f4f4;
  border-radius: 8px;
  border-left: 3px solid #00a1d6;
}

.vm-vector-progress-container.is-error {
  border-left-color: #ff4d4f;
  background: #fff2f0;
}

.vm-vector-progress-header {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #333;
  margin-bottom: 8px;
  font-weight: 500;
}

.is-error .vm-vector-progress-header {
  color: #cf1322;
}

.vm-vector-progress-bar {
  height: 4px;
  background: #e0e0e0;
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 6px;
}

.is-error .vm-vector-progress-bar {
  background: #ffccc7;
}

.vm-vector-progress-fill {
  height: 100%;
  background: #00a1d6;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.is-error .vm-vector-progress-fill {
  background: #ff4d4f;
}

.vm-vector-progress-msg {
  font-size: 11px;
  color: #666;
  word-break: break-all;
}

.is-error .vm-vector-progress-msg {
  color: #cf1322;
}

.vm-semantic-search {
  padding: 0 16px;
  margin-bottom: 16px;
  position: relative;
  z-index: 10;
}

.vm-search-scope {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
}

.vm-search-scope button {
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  background: transparent;
  color: #777;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.vm-search-scope button.is-active {
  background: white;
  color: #FB7299;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  font-weight: 600;
}

.vm-frames-dropdown {
  margin: 0 16px 12px 16px;
}

.vm-frames-btn {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f4f4f4;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #333;
}

.vm-frames-btn svg {
  transition: transform 0.2s ease;
}

.vm-frames-btn svg.is-open {
  transform: rotate(180deg);
}

.vm-frames-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  background: #fdfdfd;
  border: 1px solid #eee;
  border-radius: 0 0 6px 6px;
  border-top: none;
  padding: 8px;
  max-height: 150px;
  overflow-y: auto;
}

.vm-frames-list::-webkit-scrollbar {
  width: 4px;
}

.vm-frames-list::-webkit-scrollbar-thumb {
  background-color: #ccc;
  border-radius: 2px;
}

.vm-frame-item {
  background: white;
  border: 1px solid #eee;
  border-radius: 4px;
  font-size: 11px;
  text-align: center;
  padding: 4px 6px;
  cursor: pointer;
  color: #666;
  white-space: nowrap;
}

.vm-frame-item:hover {
  background: #00a1d6;
  color: white;
  border-color: #00a1d6;
}

.vm-search-box {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  padding: 8px 12px;
  transition: all 0.3s ease;
  border: 1px solid transparent;
}

.vm-search-box.is-active {
  background: white;
  border-color: #FB7299;
  box-shadow: 0 4px 12px rgba(251, 114, 153, 0.15);
}

.vm-search-icon {
  color: #999;
  margin-right: 8px;
}

.vm-search-box.is-active .vm-search-icon {
  color: #FB7299;
}

input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: #333;
}

input::placeholder {
  color: #aaa;
}

.vm-search-clear {
  background: transparent;
  border: none;
  color: #999;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.vm-search-clear:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #666;
}

.vm-search-results {
  background: white;
  border-radius: 8px;
  margin-top: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  border: 1px solid #f0f0f0;
}

.vm-search-loading {
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #666;
  font-size: 13px;
}

.loader-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #FB7299;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}

.vm-search-empty {
  padding: 16px;
  text-align: center;
  color: #999;
  font-size: 12px;
}

.vm-search-error {
  padding: 12px;
  color: #cf1322;
  background: #fff2f0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.vm-search-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
  border-bottom: 1px solid #f5f5f5;
  gap: 10px;
}

.vm-search-result-main {
  flex: 1;
  min-width: 0;
}

.vm-search-result-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.vm-search-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #333;
  font-size: 12px;
  font-weight: 600;
}

.vm-search-description,
.vm-search-evidence {
  color: #666;
  font-size: 11px;
  line-height: 1.45;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.vm-search-evidence {
  color: #999;
  margin-top: 2px;
}

.vm-search-item:last-child {
  border-bottom: none;
}

.vm-search-item:hover {
  background: #fdf5f7;
}

.vm-search-time {
  font-size: 13px;
  font-family: monospace;
  color: #FB7299;
  font-weight: 600;
  background: rgba(251, 114, 153, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
}

.vm-search-score {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #999;
  flex-direction: column;
  flex-shrink: 0;
  gap: 4px;
}

.score-bar-bg {
  width: 40px;
  height: 4px;
  background: #eee;
  border-radius: 2px;
  overflow: hidden;
}

.score-bar-fill {
  height: 100%;
  background: #FB7299;
  border-radius: 2px;
}
</style>
