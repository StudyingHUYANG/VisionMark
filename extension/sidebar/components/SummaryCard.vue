<template>
  <div class="vm-summary" :class="{ 'vm-summary--loading': loading }">
    <template v-if="loading">
      <SkeletonLoader variant="card" :lines="3" />
    </template>
    <template v-else-if="error">
      <div class="vm-summary__error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>{{ error }}</span>
      </div>
    </template>
    <template v-else>
      <p class="vm-summary__text">{{ displaySummary }}</p>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import SkeletonLoader from './SkeletonLoader.vue';

const props = defineProps({
  summary: {
    type: String,
    default: ''
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: String,
    default: null
  }
});

const displaySummary = computed(() => {
  return props.summary || '暂无总结';
});
</script>

<style scoped>
.vm-summary {
  margin: 12px 16px;
  padding: 16px;
  position: relative;

  /* 水晶玻璃卡片效果 */
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 248, 250, 0.88) 50%, rgba(255, 245, 248, 0.85) 100%);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 12px;

  /* 精致光影 */
  box-shadow:
    0 4px 20px rgba(251, 114, 153, 0.06),
    0 2px 8px rgba(0, 0, 0, 0.02),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 0 -1px 0 rgba(251, 114, 153, 0.03);

  border: 1px solid rgba(255, 255, 255, 0.6);
  min-height: 80px;
}

/* 装饰性高光 */
.vm-summary::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 50%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.4) 0%, transparent 100%);
  border-radius: 12px 12px 0 0;
  pointer-events: none;
}

.vm-summary--loading {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.6) 100%);
}

.vm-summary__text {
  margin: 0;
  line-height: 1.6;
  font-size: 14px;
  color: var(--vm-text-primary);
  white-space: pre-wrap;
}

.vm-summary__error {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #e53935;
  font-size: 13px;
}
</style>
