<template>
  <div class="vm-analysis-details">
    <!-- 视频标题 -->
    <div v-if="title" class="vm-analysis-section">
      <div class="vm-analysis-section__header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
          <polyline points="17 2 12 7 7 2"/>
        </svg>
        <h3 class="vm-analysis-section__title">视频主题</h3>
      </div>
      <p class="vm-analysis-section__content">{{ title }}</p>
    </div>

    <!-- 知识点 -->
    <div v-if="knowledgePoints.length > 0" class="vm-analysis-section">
      <div class="vm-analysis-section__header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <h3 class="vm-analysis-section__title">知识点</h3>
        <span class="vm-analysis-section__count">{{ knowledgePoints.length }}</span>
      </div>
      <ul class="vm-analysis-list">
        <li v-for="(point, index) in knowledgePoints" :key="index" class="vm-analysis-list__item">
          <span class="vm-analysis-list__bullet">{{ index + 1 }}</span>
          <div class="vm-analysis-list__content">
            <div class="vm-analysis-list__title">
              {{ typeof point === 'object' ? point.term : point }}
              <span v-if="typeof point === 'object' && point.timestamp" class="vm-analysis-list__time">
                {{ point.timestamp }}
              </span>
            </div>
            <p v-if="typeof point === 'object' && point.explanation" class="vm-analysis-list__desc">
              {{ point.explanation }}
            </p>
          </div>
        </li>
      </ul>
    </div>

    <!-- 热词 -->
    <div v-if="hotWords.length > 0" class="vm-analysis-section">
      <div class="vm-analysis-section__header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
        </svg>
        <h3 class="vm-analysis-section__title">热词</h3>
        <span class="vm-analysis-section__count">{{ hotWords.length }}</span>
      </div>
      <div class="vm-analysis-tags">
        <span
          v-for="(word, index) in hotWords"
          :key="index"
          class="vm-analysis-tag"
          :title="typeof word === 'object' && word.meaning ? word.meaning : ''"
        >
          {{ typeof word === 'object' ? word.word : word }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  title: {
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
  }
});
</script>

<style scoped>
.vm-analysis-details {
  margin: 0 16px 12px;
}

.vm-analysis-section {
  padding: 16px;
  margin-bottom: 12px;

  /* 水晶玻璃卡片效果 */
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 248, 250, 0.85) 100%);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 12px;
  box-shadow:
    0 4px 16px rgba(251, 114, 153, 0.05),
    0 2px 6px rgba(0, 0, 0, 0.02),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.6);
}

.vm-analysis-section:last-child {
  margin-bottom: 0;
}

/* 装饰性高光 */
.vm-analysis-section::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 50%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.3) 0%, transparent 100%);
  border-radius: 12px 12px 0 0;
  pointer-events: none;
}

.vm-analysis-section__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  color: var(--vm-color-primary, #FB7299);
}

.vm-analysis-section__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  flex: 1;
}

.vm-analysis-section__count {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--vm-color-primary, #FB7299);
  color: white;
  border-radius: 10px;
  font-weight: 500;
}

.vm-analysis-section__content {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vm-text-primary);
  font-weight: 500;
}

.vm-analysis-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.vm-analysis-list__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(251, 114, 153, 0.08);
}

.vm-analysis-list__item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.vm-analysis-list__item:first-child {
  padding-top: 0;
}

.vm-analysis-list__bullet {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--vm-color-primary, #FB7299), #ff8e9f);
  color: white;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  margin-top: 1px;
}

.vm-analysis-list__content {
  flex: 1;
  min-width: 0;
}

.vm-analysis-list__title {
  font-size: 13px;
  line-height: 1.5;
  color: var(--vm-text-primary);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.vm-analysis-list__time {
  font-size: 10px;
  padding: 1px 6px;
  background: rgba(251, 114, 153, 0.1);
  color: var(--vm-color-primary, #FB7299);
  border-radius: 8px;
  font-weight: 500;
  font-family: "SF Mono", "Consolas", monospace;
}

.vm-analysis-list__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vm-text-secondary, #666);
}

.vm-analysis-list__text {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  color: var(--vm-text-primary);
}

.vm-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vm-analysis-tag {
  display: inline-block;
  padding: 6px 12px;
  background: linear-gradient(135deg, rgba(251, 114, 153, 0.1), rgba(255, 142, 159, 0.08));
  border: 1px solid rgba(251, 114, 153, 0.2);
  border-radius: 16px;
  color: var(--vm-color-primary, #FB7299);
  font-weight: 500;
  line-height: 1.2;
  transition: all 0.2s;
}

.vm-analysis-tag:hover {
  background: linear-gradient(135deg, rgba(251, 114, 153, 0.15), rgba(255, 142, 159, 0.12));
  border-color: rgba(251, 114, 153, 0.3);
  transform: translateY(-1px);
}
</style>
