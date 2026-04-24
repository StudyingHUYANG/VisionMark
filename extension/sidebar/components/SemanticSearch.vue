<template>
  <div class="vm-semantic-search-wrapper">
    <!-- 向量预处理进度提示 -->
    <div v-if="vectorProgressState.status === 'running' || vectorProgressState.status === 'error'" class="vm-vector-progress-container" :class="{ 'is-error': vectorProgressState.status === 'error' }">
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
    <div v-if="framesList.length > 0 && vectorProgressState.status !== 'running'" class="vm-frames-dropdown">
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
    <div class="vm-semantic-search" :class="{ 'disabled': vectorProgressState.status === 'running' }">
      <div class="vm-search-box" :class="{ 'is-active': isFocused || query }">
        <svg class="vm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          v-model="query"
          :placeholder="vectorProgressState.status === 'running' ? '等待画面索引完成...' : '搜索视频画面 (例如：拿出手机测试)'"
          @keyup.enter="handleSearch"
          @focus="isFocused = true"
          @blur="isFocused = false"
          :disabled="loading || vectorProgressState.status === 'running'"
        />
        <button v-if="query" class="vm-search-clear" @click="clearSearch" :disabled="loading || vectorProgressState.status === 'running'">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 搜索结果下拉面板 -->
      <div v-if="results.length > 0 || (hasSearched && query && vectorProgressState.status !== 'running')" class="vm-search-results">
        <div v-if="loading" class="vm-search-loading">
          <div class="loader-spinner"></div>
          <span>正在匹配画面...</span>
        </div>
        <template v-else>
          <div v-if="results.length === 0" class="vm-search-empty">
            未能找到匹配画面的时间点
          </div>
          <div
            v-for="(item, index) in results"
            :key="index"
            class="vm-search-item"
            @click="selectResult(item)"
          >
            <div class="vm-search-time">{{ formatTime(item.timestamp) }}</div>
            <div class="vm-search-score">
              <div class="score-bar-bg">
                <div class="score-bar-fill" :style="{ width: `${item.score * 100}%` }"></div>
              </div>
              <span>{{ (item.score * 100).toFixed(0) }}% 相似</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';

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
const vectorProgressState = ref({ status: 'idle', percent: 0, message: '' });
const framesList = ref([]);
const showFrames = ref(false);
let progressInterval = null;

const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const clearSearch = () => {
  query.value = '';
  results.value = [];
  hasSearched.value = false;
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
  emit('seek', item.timestamp);
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
  if (newVal) {
    vectorProgressState.value = { status: 'idle', percent: 0, message: '' };
    framesList.value = [];
    showFrames.value = false;
    fetchFramesList();
    startPolling();
  }
});

const handleSearch = async () => {
  if (!query.value.trim() || !props.bvid || vectorProgressState.value.status === 'running') return;

  loading.value = true;
  hasSearched.value = true;
  results.value = [];

  try {
    const apiBase = window.API_BASE || 'http://localhost:8080/api/v1';
    const searchUrl = `${apiBase}/search/semantic?bvid=${props.bvid}&q=${encodeURIComponent(query.value)}&topk=3`;
    const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
    const token = storage.adskipper_token;
    
    // In extension context, we can fetch directly
    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': token ? `Bearer ${token}` : ''
      }
    });
    
    if (!response.ok) throw new Error('Search failed');
    const data = await response.json();
    if (data.success) {
      results.value = data.results || [];
    }
  } catch (error) {
    console.error('Semantic search error:', error);
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
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
  border-bottom: 1px solid #f5f5f5;
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
