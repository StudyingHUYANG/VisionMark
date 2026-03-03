<template>
  <div class="vm-timeline">
    <div v-if="loading" class="vm-timeline__loading">
      <SkeletonLoader v-for="i in 3" :key="i" variant="list-item" />
    </div>
    <template v-else>
      <TimelineItem
        v-for="segment in segments"
        :key="getSegmentKey(segment)"
        :segment="segment"
        :active="activeKey === getSegmentKey(segment)"
        @seek="$emit('seek', $event)"
        @delete="$emit('delete', $event)"
      />
      <div v-if="segments.length === 0" class="vm-timeline__empty">
        <p>当前视频暂无可用片段</p>
      </div>
    </template>
  </div>
</template>

<script setup>
import TimelineItem from './TimelineItem.vue';
import SkeletonLoader from './SkeletonLoader.vue';

defineProps({
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
  }
});

defineEmits(['seek', 'delete']);

function getSegmentKey(segment) {
  return String(segment.id ?? `${segment.start_time}-${segment.end_time}`);
}
</script>

<style scoped>
.vm-timeline {
  padding: 0 16px 16px;
}

.vm-timeline__loading {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.vm-timeline__empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--vm-text-secondary);
  font-size: 14px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.6) 0%, rgba(255, 245, 248, 0.5) 100%);
  border-radius: 12px;
  margin-top: 8px;
}

.vm-timeline__empty p {
  margin: 0;
}
</style>
