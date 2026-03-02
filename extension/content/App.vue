<template>
  <aside class="vm-sidebar" :class="{ 'vm-sidebar-collapsed': collapsed }">
    <button class="vm-toggle" type="button" @click="collapsed = !collapsed">
      {{ collapsed ? 'AI' : '收起' }}
    </button>

    <section v-if="!collapsed" class="vm-panel">
      <header class="vm-header">
        <div class="vm-title-group">
          <h3>AI 视频总结</h3>
          <p>{{ statusText }}</p>
        </div>
        <button class="vm-refresh" type="button" @click="refreshSummary">刷新</button>
      </header>

      <div class="vm-summary">
        <p v-if="videoState.isLoading" class="vm-placeholder">正在加载 AI 解读...</p>
        <p v-else-if="videoState.loadError" class="vm-error">{{ videoState.loadError }}</p>
        <p v-else>{{ summaryText }}</p>
      </div>

      <div class="vm-segments">
        <button
          v-for="segment in orderedSegments"
          :key="segmentKey(segment)"
          class="vm-segment"
          :class="{
            'vm-segment-active': videoState.activeSegmentKey === segmentKey(segment),
            'vm-segment-popup': segment.action === 'popup'
          }"
          type="button"
          @click="seekSegment(segment.start_time)"
        >
          <div class="vm-segment-top">
            <span>{{ formatTime(segment.start_time) }} - {{ formatTime(segment.end_time) }}</span>
            <span class="vm-tag">{{ segment.action === 'popup' ? '重点' : '跳过' }}</span>
          </div>
          <p v-if="segment.action === 'popup'">{{ segment.content || '该片段暂无文案' }}</p>
          <p v-else>该片段将在自动模式下快进。</p>
        </button>

        <div v-if="orderedSegments.length === 0 && !videoState.isLoading" class="vm-placeholder">
          当前视频暂无可用片段。
        </div>
      </div>
    </section>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue';
import { videoState } from './store.js';

const collapsed = ref(false);

const orderedSegments = computed(() => {
  return [...videoState.segments].sort((a, b) => Number(a.start_time) - Number(b.start_time));
});

const summaryText = computed(() => {
  if (videoState.aiSummary && videoState.aiSummary.trim()) {
    return videoState.aiSummary;
  }
  return '后端尚未返回 ai_summary，当前先展示分段能力。';
});

const statusText = computed(() => {
  const total = orderedSegments.value.length;
  return `${total} 个片段 · ${videoState.bvid || '未识别视频'}`;
});

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${minute}:${String(second).padStart(2, '0')}`;
}

function segmentKey(segment) {
  return String(segment.id ?? `${segment.start_time}-${segment.end_time}`);
}

function seekSegment(time) {
  window.dispatchEvent(new CustomEvent('visionmark:seek', {
    detail: { time: Number(time) || 0 }
  }));
}

function refreshSummary() {
  window.dispatchEvent(new Event('visionmark:refresh-ai'));
}
</script>

<style scoped>
.vm-sidebar {
  position: fixed;
  right: 18px;
  top: 90px;
  z-index: 999999;
  display: flex;
  align-items: flex-start;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #ecf3ff;
}

.vm-toggle {
  border: none;
  cursor: pointer;
  border-radius: 12px 0 0 12px;
  background: linear-gradient(180deg, #ff7aa8 0%, #ec5f92 100%);
  color: #fff;
  padding: 12px 10px;
  font-size: 12px;
  letter-spacing: 1px;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  box-shadow: 0 10px 24px rgba(236, 95, 146, 0.35);
}

.vm-panel {
  width: min(360px, 82vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: 0 14px 14px 14px;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(18, 28, 48, 0.97), rgba(12, 18, 34, 0.98));
  border: 1px solid rgba(96, 160, 255, 0.35);
  box-shadow: 0 20px 52px rgba(0, 0, 0, 0.45);
}

.vm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 14px 8px;
  background: rgba(255, 255, 255, 0.03);
}

.vm-title-group h3 {
  margin: 0;
  font-size: 16px;
  color: #9fd2ff;
}

.vm-title-group p {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(231, 243, 255, 0.72);
}

.vm-refresh {
  border: 1px solid rgba(116, 183, 255, 0.48);
  background: rgba(33, 64, 102, 0.8);
  color: #d9ecff;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.vm-summary {
  margin: 0 12px;
  border-radius: 10px;
  border: 1px solid rgba(120, 184, 255, 0.18);
  background: rgba(15, 27, 45, 0.62);
  padding: 12px;
  line-height: 1.55;
  font-size: 13px;
  overflow-y: auto;
  max-height: 140px;
}

.vm-summary p {
  margin: 0;
  white-space: pre-wrap;
}

.vm-segments {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vm-segment {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 4px solid rgba(255, 131, 176, 0.85);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  color: #e9f4ff;
  text-align: left;
  padding: 10px;
  cursor: pointer;
}

.vm-segment-popup {
  border-left-color: rgba(87, 179, 255, 0.95);
}

.vm-segment-active {
  border-color: rgba(141, 201, 255, 0.62);
  background: rgba(87, 179, 255, 0.14);
}

.vm-segment-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 6px;
}

.vm-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 42px;
  border-radius: 999px;
  font-size: 11px;
  padding: 2px 7px;
  color: #fff;
  background: rgba(255, 112, 164, 0.95);
}

.vm-segment-popup .vm-tag {
  background: rgba(65, 167, 255, 0.9);
}

.vm-segment p {
  margin: 0;
  color: rgba(223, 237, 255, 0.85);
  font-size: 12px;
  line-height: 1.45;
}

.vm-placeholder {
  margin: 0;
  color: rgba(202, 223, 255, 0.7);
  font-size: 12px;
}

.vm-error {
  margin: 0;
  color: #ff9aa8;
  font-size: 12px;
}

.vm-sidebar-collapsed .vm-panel {
  display: none;
}

@media (max-width: 980px) {
  .vm-sidebar {
    right: 10px;
    top: 76px;
  }

  .vm-panel {
    width: min(320px, 86vw);
    max-height: 72vh;
  }
}
</style>

