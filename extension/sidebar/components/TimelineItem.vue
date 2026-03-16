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
        <button
          class="vm-timeline-item__delete"
          type="button"
          :disabled="!canDelete"
          :title="canDelete ? '删除该标注' : '当前片段不支持删除'"
          @click="handleDelete"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
      <p v-if="segment.action === 'popup'" class="vm-timeline-item__desc">
        {{ segment.content || '该片段暂无文案' }}
      </p>
      <p v-else-if="segment.is_ai_segment" class="vm-timeline-item__desc">
        {{ segment.content || '视频片段' }}
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

const emit = defineEmits(['seek', 'delete']);

const tagType = computed(() => {
  return props.segment.action === 'popup' ? 'highlight' : 'skip';
});

const tagText = computed(() => {
  if (props.segment.is_ai_segment) {
    return props.segment.action === 'popup' ? '高能' : '片段';
  }
  return props.segment.action === 'popup' ? '重点' : '跳过';
});

const canDelete = computed(() => {
  const id = Number(props.segment?.id);
  return Number.isFinite(id) && id > 0;
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

function handleDelete() {
  if (!canDelete.value) return;
  emit('delete', Number(props.segment.id));
}
</script>

<style scoped>
.vm-timeline-item {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(251, 114, 153, 0.06);
  transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.vm-timeline-item:last-child {
  border-bottom: none;
}

.vm-timeline-item--active {
  background: linear-gradient(90deg, rgba(251, 114, 153, 0.08) 0%, rgba(251, 114, 153, 0.03) 50%, transparent 100%);
  margin: 0 -16px;
  padding-left: 16px;
  padding-right: 16px;
  border-radius: 10px;
  box-shadow: inset 3px 0 0 rgba(251, 114, 153, 0.3);
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
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

.vm-timeline-item__node--highlight {
  background: linear-gradient(135deg, #2196F3 0%, #1976d2 100%);
  border-color: var(--vm-color-highlight);
  box-shadow: 0 2px 8px rgba(25, 118, 210, 0.3);
}

.vm-timeline-item__node--skip {
  background: linear-gradient(135deg, #E91E63 0%, #c2185b 100%);
  border-color: var(--vm-color-skip);
  box-shadow: 0 2px 8px rgba(194, 24, 91, 0.3);
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
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.9) 0%, rgba(245, 245, 245, 0.85) 100%);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 4px 10px;
  font-family: "SF Mono", "Consolas", monospace;
  font-size: 13px;
  cursor: pointer;
  color: var(--vm-text-primary);
  transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.03),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

.vm-timeline-item__time:hover {
  background: linear-gradient(145deg, rgba(251, 114, 153, 0.1) 0%, rgba(255, 255, 255, 0.95) 100%);
  border-color: rgba(251, 114, 153, 0.2);
  box-shadow:
    0 4px 12px rgba(251, 114, 153, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 1);
  transform: translateY(-1px);
  color: var(--vm-color-primary);
}

.vm-timeline-item__tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 11px;
  padding: 2px 8px;
  font-weight: 500;
  letter-spacing: 0.3px;
}

.vm-tag--highlight {
  background: linear-gradient(135deg, rgba(25, 118, 210, 0.1) 0%, rgba(25, 118, 210, 0.06) 100%);
  color: var(--vm-color-highlight);
  border: 1px solid rgba(25, 118, 210, 0.15);
  box-shadow: 0 1px 3px rgba(25, 118, 210, 0.08);
}

.vm-tag--skip {
  background: linear-gradient(135deg, rgba(194, 24, 91, 0.1) 0%, rgba(194, 24, 91, 0.06) 100%);
  color: var(--vm-color-skip);
  border: 1px solid rgba(194, 24, 91, 0.15);
  box-shadow: 0 1px 3px rgba(194, 24, 91, 0.08);
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

/* Delete button - hover reveal, icon style */
.vm-timeline-item__delete {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  margin-left: auto;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
}

.vm-timeline-item__delete svg {
  width: 14px;
  height: 14px;
  color: #ef4444;
  transition: all 0.2s ease;
}

.vm-timeline-item:hover .vm-timeline-item__delete {
  opacity: 0.5;
}

.vm-timeline-item__delete:hover:not(:disabled) {
  opacity: 1;
  background: rgba(239, 68, 68, 0.1);
}

.vm-timeline-item__delete:hover:not(:disabled) svg {
  color: #dc2626;
}

.vm-timeline-item__delete:disabled {
  opacity: 0 !important;
  cursor: not-allowed;
}
</style>
