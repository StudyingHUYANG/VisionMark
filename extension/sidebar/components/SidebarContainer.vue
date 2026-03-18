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

      <AIAnalysisDetails
        v-if="!loading && !error"
        :title="aiTitle"
        :knowledge-points="knowledgePoints"
        :hot-words="hotWords"
      />

      <TimelineList
        :segments="segments"
        :active-key="activeKey"
        :loading="loading"
        @seek="handleSeek"
        @delete="handleDeleteRequest"
      />
    </div>

    <ConfirmDialog
      v-model="showDeleteDialog"
      title="删除确认"
      :message="deleteDialogMessage"
      @confirm="handleDeleteConfirm"
      @cancel="handleDeleteCancel"
    />
  </aside>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import SidebarHeader from './SidebarHeader.vue';
import SummaryCard from './SummaryCard.vue';
import AIAnalysisDetails from './AIAnalysisDetails.vue';
import TimelineList from './TimelineList.vue';
import ConfirmDialog from './ConfirmDialog.vue';

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
    default: '视频总结'
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
  aiTitle: {
    type: String,
    default: ''
  },
  knowledgePoints: {
    type: Array,
    default: () => []
  },
  hotWords: {
    type: Array,
    default: () => []
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

// 监听数据变化，输出调试信息
watch(() => props.aiTitle, (newVal) => {
  console.log('[SidebarContainer] aiTitle changed:', newVal);
}, { immediate: true });

watch(() => props.knowledgePoints, (newVal) => {
  console.log('[SidebarContainer] knowledgePoints changed:', newVal?.length || 0);
}, { immediate: true });

watch(() => props.hotWords, (newVal) => {
  console.log('[SidebarContainer] hotWords changed:', newVal?.length || 0);
}, { immediate: true });

watch(() => props.segments, (newVal) => {
  console.log('[SidebarContainer] segments changed:', newVal?.length || 0);
  if (newVal && newVal.length > 0) {
    console.log('[SidebarContainer] segments data:', newVal);
  }
}, { immediate: true, deep: true });

watch(() => props.loading, (newVal) => {
  console.log('[SidebarContainer] loading changed:', newVal);
}, { immediate: true });

watch(() => props.error, (newVal) => {
  console.log('[SidebarContainer] error changed:', newVal);
}, { immediate: true });

const emit = defineEmits(['update:visible', 'seek', 'refresh', 'delete']);

// Delete dialog state
const showDeleteDialog = ref(false);
const pendingDeleteId = ref(null);

const deleteDialogMessage = computed(() => {
  if (pendingDeleteId.value) {
    return `确定要删除这个标注片段吗？\n此操作无法撤销。`;
  }
  return '确定要删除这个标注片段吗？';
});

function handleClose() {
  emit('update:visible', false);
}

function handleRefresh() {
  emit('refresh');
}

function handleSeek(time) {
  emit('seek', time);
}

function handleDeleteRequest(segmentId) {
  pendingDeleteId.value = segmentId;
  showDeleteDialog.value = true;
}

function handleDeleteConfirm() {
  if (pendingDeleteId.value !== null) {
    emit('delete', pendingDeleteId.value);
    pendingDeleteId.value = null;
  }
}

function handleDeleteCancel() {
  pendingDeleteId.value = null;
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

  /* Crystal Glass 多层毛玻璃效果 */
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 245, 248, 0.82) 30%, rgba(255, 255, 255, 0.75) 100%),
    var(--vm-gradient-soft);
  backdrop-filter: saturate(180%) blur(28px);
  -webkit-backdrop-filter: saturate(180%) blur(28px);

  /* 精致的光影边框 */
  border-radius: 16px 0 0 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.7);
  border-top: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow:
    -12px 0 40px rgba(251, 114, 153, 0.06),
    -4px 0 20px rgba(0, 0, 0, 0.04),
    inset 1px 0 0 rgba(255, 255, 255, 0.9),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);

  transform: translateX(0);
  transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-family: var(--vm-font-family);
}

.vm-sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 120px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.6) 0%, transparent 100%);
  pointer-events: none;
  border-radius: 16px 0 0 0;
}

.vm-sidebar--hidden {
  transform: translateX(100%);
}

.vm-sidebar__content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
