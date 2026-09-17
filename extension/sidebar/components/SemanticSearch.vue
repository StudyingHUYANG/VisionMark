<template>
  <div class="vm-semantic-search-wrapper">
    <!-- 向量预处理进度提示 -->
    <div v-if="isIndexing || vectorProgressState.status === 'failed'" class="vm-vector-progress-container" :class="{ 'is-error': vectorProgressState.status === 'failed' }">
      <div class="vm-vector-progress-header">
        <span>{{ vectorProgressState.status === 'failed' ? '跨模态索引失败' : '正在索引画面与字幕' }}</span>
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
    <div v-if="framesList.length > 0 && !isIndexing" class="vm-frames-dropdown">
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
    <div class="vm-semantic-search" :class="{ 'disabled': isIndexing }">
      <div class="vm-search-box" :class="{ 'is-active': isFocused || query }">
        <svg class="vm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          v-model="query"
          :placeholder="isIndexing ? '等待跨模态索引完成...' : '搜索画面、动作或口播内容'"
          @keyup.enter="handleSearch"
          @focus="isFocused = true"
          @blur="isFocused = false"
          :disabled="loading || isIndexing"
        />
        <button v-if="query" class="vm-search-clear" @click="clearSearch" :disabled="loading || isIndexing">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 搜索结果下拉面板 -->
      <div v-if="results.length > 0 || (hasSearched && query && !isIndexing)" class="vm-search-results">
        <div v-if="loading" class="vm-search-loading">
          <div class="loader-spinner"></div>
          <span>正在匹配画面...</span>
        </div>
        <template v-else>
          <div v-if="results.length === 0" class="vm-search-empty">
            {{ searchError || '未找到匹配的视频片段' }}
          </div>
          <div
            v-for="(item, index) in results"
            :key="item.id || index"
            class="vm-search-item"
            @click="selectResult(item)"
          >
            <img v-if="item.thumbnailObjectUrl" class="vm-search-thumbnail" :src="item.thumbnailObjectUrl" alt="检索片段缩略图" />
            <div class="vm-search-content">
              <div class="vm-search-meta">
                <div class="vm-search-time">{{ formatTime(item.startTime) }}–{{ formatTime(item.endTime) }}</div>
                <div class="vm-search-score">
                  <div class="score-bar-bg">
                    <div class="score-bar-fill" :style="{ width: `${item.score * 100}%` }"></div>
                  </div>
                  <span>{{ (item.score * 100).toFixed(0) }}%</span>
                </div>
              </div>
              <div class="vm-search-modalities">
                <span v-for="modality in item.matchedModalities" :key="modality">
                  {{ modality === 'visual' ? '画面' : '字幕' }}
                </span>
              </div>
              <div v-if="item.evidence?.transcript" class="vm-search-evidence">
                {{ item.evidence.transcript }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';

const props = defineProps({
  bvid: {
    type: String,
    required: true
  }
});

const emit = defineEmits(['seek']);

const query = ref('');
const isFocused = ref(false);
const loading = ref(false);
const results = ref([]);
const hasSearched = ref(false);
const searchError = ref('');
const vectorProgressState = ref({ status: 'not_found', percent: 0, message: '' });
const framesList = ref([]);
const showFrames = ref(false);
let progressInterval = null;
const indexingStatuses = new Set(['pending', 'extracting', 'embedding', 'committing']);
const isIndexing = computed(() => indexingStatuses.has(vectorProgressState.value.status));

const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const clearSearch = () => {
  clearResultObjectUrls();
  query.value = '';
  results.value = [];
  hasSearched.value = false;
  searchError.value = '';
};

const clearResultObjectUrls = () => {
  results.value.forEach(item => {
    if (item.thumbnailObjectUrl) URL.revokeObjectURL(item.thumbnailObjectUrl);
  });
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
  emit('seek', item.seekTime ?? item.timestamp ?? item.startTime);
};

const pollVectorProgress = async () => {
  if (!props.bvid) return;
  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token;
    
    const response = await fetch(`${apiBase}/search/status?bvid=${props.bvid}`, {
      headers: { 'Authorization': token ? `Bearer ${token}` : '' }
    });
    
    if (response.ok) {
      const data = await response.json();
      const percentByStatus = { not_found: 0, pending: 1, extracting: 20, embedding: 70, committing: 95, ready: 100, failed: 100 };
      vectorProgressState.value = {
        ...data,
        percent: percentByStatus[data.status] ?? 0,
        message: data.error || (data.status === 'ready' ? '跨模态检索索引已就绪' : '正在准备检索索引')
      };
      
      if (data.status === 'ready' || data.status === 'failed') {
        stopPolling();
        if (data.status === 'ready') {
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
  clearResultObjectUrls();
});

watch(() => props.bvid, (newVal) => {
  if (newVal) {
    clearResultObjectUrls();
    results.value = [];
    vectorProgressState.value = { status: 'not_found', percent: 0, message: '' };
    framesList.value = [];
    showFrames.value = false;
    fetchFramesList();
    startPolling();
  }
});

const handleSearch = async () => {
  if (!query.value.trim() || !props.bvid || isIndexing.value) return;

  loading.value = true;
  hasSearched.value = true;
  clearResultObjectUrls();
  results.value = [];
  searchError.value = '';

  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const searchUrl = `${apiBase}/search/multimodal`;
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token;
    
    // In extension context, we can fetch directly
    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': token ? `Bearer ${token}` : '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ bvid: props.bvid, query: query.value.trim(), topK: 5 })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '搜索失败');
    if (data.success) {
      const hostBase = new URL(apiBase).origin;
      results.value = await Promise.all((data.results || []).map(async item => {
        if (!item.thumbnailUrl) return item;
        try {
          const thumbnailResponse = await fetch(`${hostBase}${item.thumbnailUrl}`, {
            headers: { 'Authorization': token ? `Bearer ${token}` : '' }
          });
          if (!thumbnailResponse.ok) return item;
          const blob = await thumbnailResponse.blob();
          return { ...item, thumbnailObjectUrl: URL.createObjectURL(blob) };
        } catch (_) {
          return item;
        }
      }));
    }
  } catch (error) {
    console.error('Semantic search error:', error);
    searchError.value = error.message || '搜索失败';
  } finally {
    loading.value = false;
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

.vm-search-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
  border-bottom: 1px solid #f5f5f5;
}

.vm-search-thumbnail {
  width: 96px;
  height: 54px;
  flex: 0 0 auto;
  object-fit: cover;
  border-radius: 5px;
  background: #f3f3f3;
}

.vm-search-content {
  min-width: 0;
  flex: 1;
}

.vm-search-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vm-search-modalities {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.vm-search-modalities span {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 161, 214, 0.1);
  color: #0087b3;
  font-size: 10px;
}

.vm-search-evidence {
  margin-top: 5px;
  color: #666;
  font-size: 11px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
