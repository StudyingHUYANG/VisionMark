<template>
  <div
    v-if="shouldRenderPanel"
    class="vm-ai-timeline"
  >
    <div
      v-if="isLoading"
      class="vm-ai-timeline__status vm-ai-timeline__status--loading"
    >
      AI 章节解析中...
    </div>

    <div
      v-else-if="errorMessage"
      class="vm-ai-timeline__status vm-ai-timeline__status--error"
      :title="errorMessage"
    >
      AI 解析失败: {{ errorMessage }}
    </div>

    <div
      v-else-if="chapterItems.length > 0"
      class="vm-ai-timeline__track"
    >
      <button
        v-for="chapter in chapterItems"
        :key="chapter.key"
        type="button"
        class="vm-ai-timeline__segment"
        :style="{
          '--segment-progress': chapter.playedRatio
        }"
        :title="chapter.title"
        @click.stop="jumpTo(chapter.startTime)"
      >
        <span class="vm-ai-timeline__label">{{ chapter.title }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ANALYSIS_UPDATED_EVENT } from '../events.js';

const props = defineProps({
  bvid: {
    type: String,
    default: ''
  },
  videoElement: {
    type: Object,
    default: null
  },
  apiUrl: {
    type: String,
    default: ''
  }
});

const chapters = ref([]);
const currentTime = ref(0);
const duration = ref(0);
const videoRef = ref(null);
const isLoading = ref(true);
const errorMessage = ref('');

let activeRequestId = 0;

const normalizedChapters = computed(() => {
  return normalizeChapters(chapters.value);
});

const shouldRenderPanel = computed(() => {
  return isLoading.value || Boolean(errorMessage.value) || chapterItems.value.length > 0;
});

const resolvedDuration = computed(() => {
  if (Number.isFinite(duration.value) && duration.value > 0) {
    return duration.value;
  }

  return normalizedChapters.value.reduce((maxValue, chapter) => {
    return Math.max(maxValue, chapter.endTime);
  }, 0);
});

const chapterItems = computed(() => {
  return buildChapterItems(normalizedChapters.value, resolvedDuration.value, currentTime.value, isLoading.value);
});

function normalizeChapters(rawChapters) {
  if (!Array.isArray(rawChapters)) return [];

  return rawChapters
    .map((chapter, index) => {
      const startTime = Number(chapter?.startTime ?? chapter?.start_time ?? chapter?.start ?? 0);
      const endTime = Number(chapter?.endTime ?? chapter?.end_time ?? chapter?.end ?? 0);
      const title = String(
        chapter?.title
        || chapter?.name
        || chapter?.label
        || `章节 ${index + 1}`
      ).trim();

      return {
        startTime,
        endTime,
        title
      };
    })
    .filter((chapter) => Number.isFinite(chapter.startTime)
      && Number.isFinite(chapter.endTime)
      && chapter.endTime > chapter.startTime)
    .sort((left, right) => {
      if (left.startTime !== right.startTime) {
        return left.startTime - right.startTime;
      }

      if (left.endTime !== right.endTime) {
        return left.endTime - right.endTime;
      }

      return left.title.localeCompare(right.title, 'zh-CN');
    });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toPercent(value) {
  return `${Math.max(value, 0) * 100}%`;
}

function buildChapterItems(rawChapters, totalDuration, playbackTime, loading) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return [];
  }

  // 基于 startTime + endTime 去重，防止 API 返回重复数据
  const seen = new Set();
  const deduplicated = rawChapters.filter((chapter) => {
    const key = `${chapter.startTime}-${chapter.endTime}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return deduplicated
    .map((chapter, index) => {
      const startTime = clamp(chapter.startTime, 0, totalDuration);
      const endTime = clamp(chapter.endTime, 0, totalDuration);
      const chapterDuration = endTime - startTime;

      if (!Number.isFinite(chapterDuration) || chapterDuration <= 0) {
        return null;
      }

      const playedRatio = loading
        ? 0
        : clamp((playbackTime - startTime) / chapterDuration, 0, 1);

      return {
        ...chapter,
        startTime,
        endTime,
        key: `${startTime}-${endTime}-${chapter.title}-${index}`,
        left: toPercent(startTime / totalDuration),
        width: toPercent(chapterDuration / totalDuration),
        playedRatio,
        isActive: playedRatio > 0 && playedRatio < 1,
        isComplete: playedRatio >= 1
      };
    })
    .filter(Boolean);
}

function getAuthToken() {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) {
      resolve('');
      return;
    }

    chrome.storage.local.get(['adskipper_token'], (storage) => {
      resolve(storage?.adskipper_token || '');
    });
  });
}

function extractChapterPayload(data) {
  const payload = data?.data ?? data;

  if (Array.isArray(payload)) {
    return payload;
  }

  const chapterCandidates = [
    payload?.chapters,
    payload?.chapter_timeline,
    payload?.chapterTimeline,
    payload?.ai_chapters,
    payload?.aiChapterTimeline
  ];

  for (const candidate of chapterCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (Array.isArray(payload?.ad_segments)) {
    return payload.ad_segments.map((segment, index) => ({
      startTime: segment?.startTime ?? segment?.start_time ?? segment?.start ?? 0,
      endTime: segment?.endTime ?? segment?.end_time ?? segment?.end ?? 0,
      title: segment?.title || segment?.description || `AI 章节 ${index + 1}`
    }));
  }

  if (Array.isArray(payload?.segments)) {
    return payload.segments.map((segment, index) => ({
      startTime: segment?.startTime ?? segment?.start_time ?? segment?.start ?? 0,
      endTime: segment?.endTime ?? segment?.end_time ?? segment?.end ?? 0,
      title: segment?.title || segment?.description || `AI 章节 ${index + 1}`
    }));
  }

  return [];
}

async function fetchChapterData(bvid) {
  if (!bvid || !props.apiUrl) {
    errorMessage.value = !props.apiUrl ? '未配置章节接口地址' : '';
    return [];
  }

  console.log('🚀 [AI Timeline] 开始请求数据, 当前 BVID:', bvid);

  try {
    const requestUrl = new URL(props.apiUrl, window.location.origin);

    // 当前默认使用 Query 参数方式传递 bvid：
    // 形如 /video-view?bvid=BVxxxxxx
    // 如果后端要求 Path 参数方式，可改成：
    // const requestUrl = new URL(`${props.apiUrl.replace(/\/$/, '')}/${bvid}`, window.location.origin);
    requestUrl.searchParams.set('bvid', bvid);
    const fullUrl = requestUrl.toString();
    const token = await getAuthToken();
    const headers = {};

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    console.log('🚀 [AI Timeline] 准备发送请求, 完整 URL:', fullUrl);

    // 如果是跨域报错，需要将 fetch 逻辑移至 background.js
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      console.error('❌ [AI Timeline] HTTP 响应异常:', {
        status: response.status,
        url: response.url
      });
      throw new Error(`章节接口请求失败：${response.status}`);
    }

    const data = await response.json();
    console.log('✅ [AI Timeline] 成功拿到后端数据:', data);

    const chapterList = extractChapterPayload(data);
    console.log('🧩 [AI Timeline] 解析后的章节数据:', chapterList);
    return normalizeChapters(chapterList);
  } catch (error) {
    if (bvid === props.bvid) {
      errorMessage.value = error instanceof Error ? error.message : String(error || '未知错误');
    }
    console.error('❌ [AI Timeline] 接口报错:', error);
    throw error;
  }
}

function syncVideoState() {
  if (!videoRef.value) {
    currentTime.value = 0;
    duration.value = 0;
    return;
  }

  currentTime.value = Number.isFinite(videoRef.value.currentTime)
    ? videoRef.value.currentTime
    : 0;

  duration.value = Number.isFinite(videoRef.value.duration)
    ? videoRef.value.duration
    : 0;
}

function handleTimeUpdate() {
  if (!videoRef.value) return;

  currentTime.value = Number.isFinite(videoRef.value.currentTime)
    ? videoRef.value.currentTime
    : 0;
}

function handleDurationChange() {
  if (!videoRef.value) return;

  duration.value = Number.isFinite(videoRef.value.duration)
    ? videoRef.value.duration
    : 0;
}

function unbindVideoEvents() {
  if (!videoRef.value) return;

  videoRef.value.removeEventListener('timeupdate', handleTimeUpdate);
  videoRef.value.removeEventListener('durationchange', handleDurationChange);
}

function bindVideoElement(videoElement) {
  if (videoRef.value === videoElement) {
    syncVideoState();
    return;
  }

  unbindVideoEvents();
  videoRef.value = videoElement || null;

  if (!videoRef.value) {
    currentTime.value = 0;
    duration.value = 0;
    return;
  }

  videoRef.value.addEventListener('timeupdate', handleTimeUpdate);
  videoRef.value.addEventListener('durationchange', handleDurationChange);
  syncVideoState();
}

async function loadChapters(bvid) {
  const requestId = ++activeRequestId;

  chapters.value = [];
  currentTime.value = 0;
  isLoading.value = true;
  errorMessage.value = '';

  if (!bvid) {
    isLoading.value = false;
    return;
  }

  try {
    const nextChapters = await fetchChapterData(bvid);

    if (requestId !== activeRequestId) {
      return;
    }

    chapters.value = nextChapters;
    console.log('📝 [AI Timeline] 当前章节标题列表:', nextChapters.map((chapter) => chapter.title));
    syncVideoState();
  } catch (error) {
    if (requestId !== activeRequestId) {
      return;
    }

    chapters.value = [];
    if (!errorMessage.value) {
      errorMessage.value = error instanceof Error ? error.message : String(error || '未知错误');
    }
  } finally {
    if (requestId === activeRequestId) {
      isLoading.value = false;
    }
  }
}

function handleAnalysisUpdated(event) {
  const updatedBvid = String(event?.detail?.bvid || '');

  if (!updatedBvid || updatedBvid !== props.bvid) {
    return;
  }

  // BUG FIX: 必须先递增 activeRequestId，否则与 watch 触发的 loadChapters 产生竞争
  ++activeRequestId;
  loadChapters(updatedBvid);
}

function jumpTo(startTime) {
  if (!videoRef.value) return;
  videoRef.value.currentTime = startTime;
}

watch(
  () => props.videoElement,
  (nextVideoElement) => {
    bindVideoElement(nextVideoElement);
  },
  { immediate: true }
);

watch(
  () => props.bvid,
  (nextBvid) => {
    loadChapters(nextBvid);
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener(ANALYSIS_UPDATED_EVENT, handleAnalysisUpdated);
});

onUnmounted(() => {
  activeRequestId += 1;
  window.removeEventListener(ANALYSIS_UPDATED_EVENT, handleAnalysisUpdated);
  unbindVideoEvents();
});
</script>

<style scoped>
.vm-ai-timeline {
  --timeline-height: 28px;
  --timeline-bg: #000;
  --timeline-block-inactive-bg: #0a0a0a;
  --timeline-block-active-bg: #5c1010;
  --timeline-text-color: #ffffff;
  --timeline-text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);

  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: var(--timeline-height);
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
  font-family: 'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.vm-ai-timeline__track {
  display: flex;
  width: 100%;
  height: 100%;
  background: var(--timeline-bg);
  pointer-events: auto;
}

.vm-ai-timeline__status {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0 12px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  pointer-events: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vm-ai-timeline__status--loading {
  color: rgba(255, 255, 255, 0.92);
}

.vm-ai-timeline__status--error {
  color: #ff7b7b;
}

.vm-ai-timeline__segment {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 1px;
  padding: 0 6px;
  border: none;
  background: linear-gradient(
    90deg,
    var(--timeline-block-active-bg) 0%,
    var(--timeline-block-active-bg) calc(var(--segment-progress, 0) * 100%),
    var(--timeline-block-inactive-bg) calc(var(--segment-progress, 0) * 100%),
    var(--timeline-block-inactive-bg) 100%
  );
  color: var(--timeline-text-color);
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  overflow: hidden;
  transition: filter 0.15s ease;
}

.vm-ai-timeline__segment:last-child {
  margin-right: 0;
}

.vm-ai-timeline__segment:hover {
  filter: brightness(1.2);
}

.vm-ai-timeline__label {
  position: relative;
  z-index: 1;
  width: 100%;
  overflow: hidden;
  color: var(--timeline-text-color);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-shadow: var(--timeline-text-shadow);
  pointer-events: none;
}
</style>
