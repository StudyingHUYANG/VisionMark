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
  return props.summary || '暂无 AI 总结';
});
</script>

<style scoped>
.vm-summary {
  margin: 12px 16px;
  padding: 16px;
  background: linear-gradient(135deg, #f8f9fa 0%, #fff5f8 100%);
  border-radius: 12px;
  min-height: 80px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.03);
}

.vm-summary--loading {
  background: rgba(255, 255, 255, 0.6);
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