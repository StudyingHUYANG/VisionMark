<template>
  <aside
    class="vm-sidebar"
    :class="{ 'vm-sidebar--hidden': !visible }"
  >
    <SidebarHeader
      :title="title"
      :bvid="bvid"
      :segment-count="segmentCount"
      @close="handleClose"
      @refresh="handleRefresh"
    />

    <div class="vm-sidebar__content">
      <SummaryCard
        :summary="summary"
        :loading="loading"
        :error="error"
      />

      <TimelineList
        :segments="segments"
        :active-key="activeKey"
        :loading="loading"
        @seek="handleSeek"
      />
    </div>
  </aside>

  <!-- Toggle tab when sidebar is hidden -->
  <button
    v-if="!visible"
    class="vm-toggle-tab"
    @click="handleShow"
  >
    <span class="vm-toggle-tab__icon">AI</span>
  </button>
</template>

<script setup>
import { computed } from 'vue';
import SidebarHeader from './SidebarHeader.vue';
import SummaryCard from './SummaryCard.vue';
import TimelineList from './TimelineList.vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  topOffset: {
    type: Number,
    default: 64
  },
  width: {
    type: Number,
    default: 380
  },
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
  },
  summary: {
    type: String,
    default: ''
  },
  segments: {
    type: Array,
    default: () => []
  },
  activeKey: {
    type: String,
    default: null
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

const emit = defineEmits(['update:visible', 'seek', 'refresh']);

function handleShow() {
  emit('update:visible', true);
}

function handleClose() {
  emit('update:visible', false);
}

function handleRefresh() {
  emit('refresh');
}

function handleSeek(time) {
  emit('seek', time);
}
</script>

<style scoped>
.vm-sidebar {
  position: fixed !important;
  right: 0 !important;
  top: 64px !important;
  height: calc(100vh - 64px) !important;
  width: 380px !important;
  z-index: 2147483647 !important;
  
  /* 极致毛玻璃高级感 (Glassmorphism) */
  background-color: rgba(255, 255, 255, 0.75);
  backdrop-filter: saturate(180%) blur(24px);
  -webkit-backdrop-filter: saturate(180%) blur(24px);
  
  border-radius: 16px 0 0 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.08);
  
  transform: translateX(0);
  transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-family: var(--vm-font-family);
}

.vm-sidebar--hidden {
  transform: translateX(100%);
}

.vm-sidebar__content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.vm-toggle-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 80px;
  background: var(--vm-color-primary);
  color: white;
  border: none;
  border-radius: 8px 0 0 8px;
  cursor: pointer;
  z-index: 99998;
  box-shadow: -2px 0 10px rgba(251, 114, 153, 0.3);
  transition: all 0.2s;
}

.vm-toggle-tab:hover {
  width: 36px;
  box-shadow: -4px 0 15px rgba(251, 114, 153, 0.5);
}

.vm-toggle-tab__icon {
  writing-mode: vertical-rl;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 2px;
}
</style>