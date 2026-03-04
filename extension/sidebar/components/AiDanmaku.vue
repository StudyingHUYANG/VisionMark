<template>
  <div class="ai-danmaku-container" :class="{ 'is-visible': visible }">
    <TransitionGroup name="danmaku-fade">
      <div
        v-for="item in activeItems"
        :key="item.id"
        class="ai-danmaku-item"
        :class="['type-' + item.type]"
        :style="{ top: item.top + '%' }"
      >
        <div class="danmaku-header">
          <span class="danmaku-icon">{{ item.icon }}</span>
          <span class="danmaku-title">{{ item.title }}</span>
          <span class="danmaku-time">{{ formatTime(item.timestamp) }}</span>
        </div>
        <div class="danmaku-content">{{ item.content }}</div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { ref, watch, computed, onUnmounted } from 'vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: true
  },
  currentTime: {
    type: Number,
    default: 0
  },
  knowledgePoints: {
    type: Array,
    default: () => []
  },
  hotWords: {
    type: Array,
    default: () => []
  }
});

const activeItems = ref([]);
const lastTime = ref(0);

// Helper to format time
const formatTime = (seconds) => {
  if (!seconds) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Generate a unique ID for items
const getItemId = (type, item) => {
  return `${type}-${item.timestamp}-${item.term || item.word}`;
};

// Check for new items to show
watch(() => props.currentTime, (newTime, oldTime) => {
  // If seeked significantly, we might want to clear existing items to avoid clutter
  if (Math.abs(newTime - lastTime.value) > 2) {
     activeItems.value = [];
  }
  lastTime.value = newTime;

  // Check Knowledge Points
  props.knowledgePoints.forEach(kp => {
    const time = kp.timestamp_seconds;
    // Trigger window: [time - 0.5, time + 1.5]
    if (newTime >= time - 0.5 && newTime <= time + 1.5) {
      const id = getItemId('kp', kp);
      // Only add if not currently active
      if (!activeItems.value.find(i => i.id === id)) {
        addItem({
          id,
          type: 'knowledge',
          title: kp.term,
          content: kp.explanation,
          timestamp: time,
          icon: '🎓',
          top: 15 + Math.random() * 20
        });
      }
    }
  });

  // Check Hot Words
  props.hotWords.forEach(hw => {
    const time = hw.timestamp_seconds;
    if (newTime >= time - 0.5 && newTime <= time + 1.5) {
      const id = getItemId('hw', hw);
      if (!activeItems.value.find(i => i.id === id)) {
        addItem({
          id,
          type: 'hotword',
          title: hw.word,
          content: hw.meaning,
          timestamp: time,
          icon: '🔥',
          top: 45 + Math.random() * 20
        });
      }
    }
  });
});

const addItem = (item) => {
  activeItems.value.push(item);
  // Auto remove after 8 seconds
  setTimeout(() => {
    removeItem(item.id);
  }, 8000);
};

const removeItem = (id) => {
  const index = activeItems.value.findIndex(i => i.id === id);
  if (index !== -1) {
    activeItems.value.splice(index, 1);
  }
};

// Clear items when video changes
watch(() => [props.knowledgePoints, props.hotWords], () => {
  activeItems.value = [];
}, { deep: true });

</script>

<style scoped>
.ai-danmaku-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none; /* Let clicks pass through to video */
  overflow: hidden;
  z-index: 10000; /* High z-index to sit on top of video */
  opacity: 0;
  transition: opacity 0.3s;
}

.ai-danmaku-container.is-visible {
  opacity: 1;
}

.ai-danmaku-item {
  position: absolute;
  left: 24px; /* Align to left side */
  /* top is set dynamically */
  max-width: 320px;
  background: rgba(16, 21, 34, 0.85);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  padding: 12px;
  color: #fff;
  border-left: 3px solid #47a7ff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: auto; /* Allow interaction with the card itself */
  transform-origin: left center;
}

.type-hotword {
  border-left-color: #fb7299;
}

.danmaku-header {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
  gap: 8px;
}

.danmaku-icon {
  font-size: 16px;
}

.danmaku-title {
  font-weight: 600;
  font-size: 14px;
  color: #eaf4ff;
}

.danmaku-time {
  margin-left: auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  font-family: monospace;
}

.danmaku-content {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.9);
  text-align: justify;
}

/* Animations */
.danmaku-fade-enter-active,
.danmaku-fade-leave-active {
  transition: all 0.5s cubic-bezier(0.25, 0.8, 0.25, 1);
}

.danmaku-fade-enter-from {
  opacity: 0;
  transform: translateX(-20px);
}

.danmaku-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
