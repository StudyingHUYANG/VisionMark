<template>
  <section v-if="clips.length" class="vm-materials">
    <button
      class="vm-materials__header"
      type="button"
      :aria-expanded="isExpanded"
      @click="isExpanded = !isExpanded"
    >
      <div>
        <h3>精彩片段</h3>
        <p>基于视频内容分析智能推荐</p>
      </div>
      <div class="vm-materials__header-actions">
        <span>{{ Math.min(clips.length, 12) }}</span>
        <svg :class="{ 'is-expanded': isExpanded }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </button>

    <div v-if="isExpanded" class="vm-materials__content">
    <article v-for="clip in displayClips" :key="clip.id" class="vm-material-card">
      <div class="vm-material-card__frames">
        <button
          v-for="frame in clip.frames"
          :key="`${clip.id}-${frame.time}`"
          type="button"
          :title="`跳转到 ${formatTime(frame.time)}`"
          @click="emit('seek', frame.time)"
        >
          <img v-if="frame.objectUrl" :src="frame.objectUrl" :alt="`${clip.title}代表帧`" />
          <span v-else>{{ formatTime(frame.time) }}</span>
        </button>
      </div>

      <button class="vm-material-card__body" type="button" @click="emit('seek', clip.suggestedStartTime)">
        <div class="vm-material-card__title-row">
          <strong>{{ clip.insight?.status === 'ready' ? clip.insight.title : (clip.title || '精彩片段') }}</strong>
        </div>
        <div class="vm-material-card__time">
          片段范围 {{ formatTime(clip.startTime) }}–{{ formatTime(clip.endTime) }}
        </div>
        <div class="vm-material-card__description">
          <span>片段介绍</span>
          <p>{{ chineseDescription(clip) }}</p>
        </div>
        <div v-if="clip.insight?.status === 'ready' && clip.insight.highlight" class="vm-material-card__description">
          <span>片段看点</span>
          <p>{{ clip.insight.highlight }}</p>
        </div>
      </button>
      <ClipCollectionActions :clip="clip" :bvid="bvid" :video-title="videoTitle" :page="1" />
    </article>
    </div>
  </section>
</template>

<script setup>
import { onUnmounted, ref, watch } from 'vue';
import ClipCollectionActions from './ClipCollectionActions.vue';

const props = defineProps({
  bvid: String,
  videoTitle: String,
  clips: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['seek']);
const displayClips = ref([]);
const isExpanded = ref(false);
let loadGeneration = 0;

function revokeObjectUrls() {
  displayClips.value.forEach(clip => {
    clip.frames?.forEach(frame => {
      if (frame.objectUrl) URL.revokeObjectURL(frame.objectUrl);
    });
  });
}

function formatTime(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function chineseDescription(clip) {
  if (clip.insight?.status === 'ready' && clip.insight.source === 'model_analysis') {
    return clip.insight.description;
  }
  if (!clip.insight) return '该历史片段尚未生成内容解读，请重新分析视频。';
  if (clip.insight.status === 'insufficient') return '当前画面与字幕不足以生成可靠介绍，可点击画面查看原片段。';
  return '片段解读暂不可用，请稍后重新分析视频。';
}

async function loadFrames(clips) {
  const generation = ++loadGeneration;
  revokeObjectUrls();
  const source = Array.isArray(clips) ? clips.slice(0, 12) : [];
  displayClips.value = source.map(clip => ({
    ...clip, frames: (clip.representativeFrames || []).map(frame => ({ ...frame, objectUrl: null }))
  }));
  const storage = await new Promise(resolve => chrome.storage.local.get(['adskipper_token'], resolve));
  const token = storage.adskipper_token || '';
  const apiBase = window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080';

  const resolved = await Promise.all(source.map(async clip => {
    const frames = await Promise.all((clip.representativeFrames || []).map(async frame => {
      if (!frame?.url) return { ...frame, objectUrl: null };
      try {
        const response = await fetch(`${apiBase}${frame.url}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' }
        });
        if (!response.ok) return { ...frame, objectUrl: null };
        return { ...frame, objectUrl: URL.createObjectURL(await response.blob()) };
      } catch (_) {
        return { ...frame, objectUrl: null };
      }
    }));
    return { ...clip, frames };
  }));

  if (generation !== loadGeneration) {
    resolved.forEach(clip => clip.frames.forEach(frame => {
      if (frame.objectUrl) URL.revokeObjectURL(frame.objectUrl);
    }));
    return;
  }
  displayClips.value = resolved;
}

watch([() => props.clips, isExpanded], ([clips, expanded]) => {
  if (!expanded) {
    loadGeneration += 1;
    revokeObjectUrls();
    displayClips.value = [];
    return;
  }
  loadFrames(clips);
}, { immediate: true, deep: true });
onUnmounted(() => {
  loadGeneration += 1;
  revokeObjectUrls();
});
</script>

<style scoped>
.vm-materials {
  margin: 0 16px 12px;
  overflow: hidden;
  border: 1px solid rgba(0, 161, 214, 0.16);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.82);
}

.vm-materials__header,
.vm-material-card__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vm-materials__header {
  width: 100%;
  padding: 14px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.vm-materials__header h3,
.vm-materials__header p {
  margin: 0;
}

.vm-materials__header h3 {
  color: #0087b3;
  font-size: 14px;
}

.vm-materials__header p {
  margin-top: 2px;
  color: #888;
  font-size: 10px;
}

.vm-materials__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vm-materials__header-actions > span {
  padding: 2px 8px;
  color: white;
  background: #00a1d6;
  border-radius: 10px;
  font-size: 11px;
}

.vm-materials__header-actions svg {
  color: #0087b3;
  transition: transform 0.2s ease;
}

.vm-materials__header-actions svg.is-expanded {
  transform: rotate(180deg);
}

.vm-materials__content {
  padding: 0 14px 14px;
  border-top: 1px solid rgba(0, 161, 214, 0.08);
}

.vm-material-card {
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid #edf3f5;
  border-radius: 9px;
  background: white;
}

.vm-material-card__frames {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  min-height: 54px;
  background: #f2f5f6;
}

.vm-material-card__frames button,
.vm-material-card__body {
  padding: 0;
  border: 0;
  cursor: pointer;
}

.vm-material-card__frames button {
  min-width: 0;
  height: 62px;
  color: #777;
  background: #eef3f5;
  font-size: 11px;
}

.vm-material-card__frames img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.vm-material-card__body {
  display: block;
  width: 100%;
  padding: 9px 10px 10px;
  color: #333;
  background: white;
  text-align: left;
}

.vm-material-card__title-row strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vm-material-card__title-row span {
  color: #00a1d6;
  font-size: 10px;
}

.vm-material-card__time {
  margin-top: 4px;
  color: #0087b3;
  font-family: monospace;
  font-size: 11px;
}

.vm-material-card__description {
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid #f1f1f1;
}

.vm-material-card__description > span {
  display: block;
  margin-bottom: 3px;
  color: #555;
  font-size: 10px;
  font-weight: 600;
}

.vm-material-card__description p {
  margin: 0;
  color: #777;
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
