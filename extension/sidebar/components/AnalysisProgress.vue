<template>
  <section
    class="vm-analysis-progress"
    :class="`vm-analysis-progress--${status}`"
    aria-live="polite"
  >
    <div class="vm-analysis-progress__header">
      <span class="vm-analysis-progress__label">{{ message }}</span>
      <span class="vm-analysis-progress__percent">{{ displayPercent }}%</span>
    </div>

    <div
      class="vm-analysis-progress__track"
      role="progressbar"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="displayPercent"
      :aria-label="message"
    >
      <div
        class="vm-analysis-progress__bar"
        :style="{ width: `${displayPercent}%` }"
      ></div>
    </div>

    <div class="vm-analysis-progress__steps">
      <span
        v-for="step in steps"
        :key="step.key"
        class="vm-analysis-progress__step"
        :class="{
          'vm-analysis-progress__step--active': step.active,
          'vm-analysis-progress__step--done': step.done
        }"
      >
        {{ step.label }}
      </span>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';

const STAGE_ORDER = ['prepare', 'download', 'frames', 'model', 'finalize', 'completed'];
const DISPLAY_STEPS = [
  { key: 'download', label: '下载' },
  { key: 'frames', label: '抽帧' },
  { key: 'model', label: '大模型' }
];

const props = defineProps({
  progress: {
    type: Object,
    default: null
  }
});

const status = computed(() => props.progress?.status || 'running');

const currentStage = computed(() => props.progress?.stage || 'prepare');

const displayPercent = computed(() => {
  const percent = Number(props.progress?.percent);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
});

const message = computed(() => props.progress?.message || '准备分析视频');

const currentStageIndex = computed(() => {
  const index = STAGE_ORDER.indexOf(currentStage.value);
  return index >= 0 ? index : 0;
});

const steps = computed(() => DISPLAY_STEPS.map((step) => {
  const index = STAGE_ORDER.indexOf(step.key);
  return {
    ...step,
    active: step.key === currentStage.value,
    done: status.value === 'completed' || (index >= 0 && index < currentStageIndex.value)
  };
}));
</script>

<style scoped>
.vm-analysis-progress {
  margin: 12px 16px 0;
  padding: 14px;
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.92), rgba(246, 252, 255, 0.82)),
    linear-gradient(135deg, rgba(251, 114, 153, 0.12), rgba(25, 118, 210, 0.1));
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 8px;
  box-shadow:
    0 8px 24px rgba(25, 118, 210, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
}

.vm-analysis-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.vm-analysis-progress__label {
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--vm-text-primary);
  overflow-wrap: anywhere;
}

.vm-analysis-progress__percent {
  flex: 0 0 auto;
  min-width: 42px;
  text-align: right;
  font-size: 13px;
  font-weight: 700;
  color: var(--vm-color-primary);
  font-variant-numeric: tabular-nums;
}

.vm-analysis-progress__track {
  height: 8px;
  overflow: hidden;
  border-radius: 8px;
  background: rgba(25, 118, 210, 0.12);
  box-shadow: inset 0 1px 3px rgba(25, 118, 210, 0.12);
}

.vm-analysis-progress__bar {
  position: relative;
  height: 100%;
  min-width: 6px;
  border-radius: 8px;
  background: linear-gradient(90deg, #fb7299 0%, #1976d2 100%);
  transition: width 0.28s ease;
}

.vm-analysis-progress__bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.62), transparent);
  animation: vm-progress-shine 1.25s ease-in-out infinite;
}

.vm-analysis-progress__steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.vm-analysis-progress__step {
  min-width: 0;
  padding: 5px 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.62);
  color: var(--vm-text-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  text-align: center;
}

.vm-analysis-progress__step--done {
  color: #1976d2;
  background: rgba(25, 118, 210, 0.1);
}

.vm-analysis-progress__step--active {
  color: #fff;
  background: var(--vm-gradient-accent);
  box-shadow: 0 4px 12px rgba(251, 114, 153, 0.18);
}

.vm-analysis-progress--failed .vm-analysis-progress__percent {
  color: var(--vm-color-danger);
}

.vm-analysis-progress--failed .vm-analysis-progress__bar {
  background: linear-gradient(90deg, #ef4444 0%, #fb7299 100%);
}

@keyframes vm-progress-shine {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vm-analysis-progress__bar,
  .vm-analysis-progress__bar::after {
    animation: none;
    transition: none;
  }
}
</style>
