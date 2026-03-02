<template>
  <div class="vm-timeline-item" :class="{ 'vm-timeline-item--active': active }">
    <div class="vm-timeline-item__line">
      <div class="vm-timeline-item__node" :class="`vm-timeline-item__node--${tagType}`"></div>
    </div>
    <div class="vm-timeline-item__content">
      <div class="vm-timeline-item__header">
        <button
          class="vm-timeline-item__time"
          type="button"
          @click="handleSeek"
        >
          {{ formatTime(segment.start_time) }}
        </button>
        <span class="vm-timeline-item__tag" :class="`vm-tag--${tagType}`">
          {{ tagText }}
        </span>
      </div>
      <p v-if="segment.action === 'popup'" class="vm-timeline-item__desc">
        {{ segment.content || '该片段暂无文案' }}
      </p>
      <p v-else class="vm-timeline-item__desc vm-timeline-item__desc--skip">
        该片段将在自动模式下快进
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  segment: {
    type: Object,
    required: true
  },
  active: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['seek']);

const tagType = computed(() => {
  return props.segment.action === 'popup' ? 'highlight' : 'skip';
});

const tagText = computed(() => {
  return props.segment.action === 'popup' ? '重点' : '跳过';
});

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${minute}:${String(second).padStart(2, '0')}`;
}

function handleSeek() {
  emit('seek', props.segment.start_time);
}
</script>

<style scoped>
.vm-timeline-item {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.2s;
}

.vm-timeline-item:last-child {
  border-bottom: none;
}

.vm-timeline-item--active {
  background: rgba(251, 114, 153, 0.05);
  margin: 0 -16px;
  padding-left: 16px;
  padding-right: 16px;
  border-radius: 8px;
}

.vm-timeline-item__line {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 6px;
}

.vm-timeline-item__node {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid;
}

.vm-timeline-item__node--highlight {
  background: var(--vm-color-highlight);
  border-color: var(--vm-color-highlight);
}

.vm-timeline-item__node--skip {
  background: var(--vm-color-skip);
  border-color: var(--vm-color-skip);
}

.vm-timeline-item__content {
  flex: 1;
  min-width: 0;
}

.vm-timeline-item__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.vm-timeline-item__time {
  background: #f0f0f0;
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  font-family: "SF Mono", "Consolas", monospace;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
  color: var(--vm-text-primary);
}

.vm-timeline-item__time:hover {
  background: #e0e0e0;
}

.vm-timeline-item__tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 11px;
  padding: 2px 8px;
  font-weight: 500;
}

.vm-tag--highlight {
  background: #e3f2fd;
  color: var(--vm-color-highlight);
}

.vm-tag--skip {
  background: #fce4ec;
  color: var(--vm-color-skip);
}

.vm-timeline-item__desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--vm-text-secondary);
}

.vm-timeline-item__desc--skip {
  color: #999;
  font-style: italic;
}
</style>