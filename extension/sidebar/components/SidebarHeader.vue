<template>
  <header class="vm-header">
    <div class="vm-header__left">
      <div class="vm-header__logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" fill="#FB7299"/>
          <path d="M8 12l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="vm-header__info">
        <h3 class="vm-header__title">{{ title }}</h3>
        <p class="vm-header__subtitle">
          <span v-if="segmentCount > 0">{{ segmentCount }} 个片段</span>
          <span v-if="bvid" class="vm-header__bvid">{{ bvid }}</span>
        </p>
      </div>
    </div>
    <div class="vm-header__actions">
      <button
        class="vm-header__btn vm-header__btn--refresh"
        type="button"
        title="刷新"
        @click="$emit('refresh')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
      <button
        class="vm-header__btn vm-header__btn--close"
        type="button"
        title="关闭"
        @click="$emit('close')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup>
defineProps({
  title: {
    type: String,
    default: 'AI 视频总结'
  },
  bvid: {
    type: String,
    default: null
  },
  segmentCount: {
    type: Number,
    default: 0
  }
});

defineEmits(['close', 'refresh']);
</script>

<style scoped>
.vm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #eee;
  background: var(--vm-bg-primary);
}

.vm-header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.vm-header__logo {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vm-header__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vm-header__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--vm-text-primary);
}

.vm-header__subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--vm-text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.vm-header__bvid {
  color: var(--vm-color-primary);
  font-family: "SF Mono", "Consolas", monospace;
}

.vm-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vm-header__btn {
  width: 32px;
  height: 32px;
  border: none;
  background: #f0f0f0;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vm-text-secondary);
  transition: all 0.2s;
}

.vm-header__btn:hover {
  background: #e0e0e0;
  color: var(--vm-text-primary);
}

.vm-header__btn--refresh:hover {
  color: var(--vm-color-highlight);
}
</style>