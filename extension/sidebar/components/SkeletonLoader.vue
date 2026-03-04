<template>
  <div class="vm-skeleton" :class="`vm-skeleton--${variant}`">
    <div
      v-for="i in lines"
      :key="i"
      class="vm-skeleton__line"
      :style="getLineStyle(i)"
    ></div>
  </div>
</template>

<script setup>
defineProps({
  lines: {
    type: Number,
    default: 3
  },
  variant: {
    type: String,
    default: 'card',
    validator: (v) => ['card', 'list-item'].includes(v)
  }
});

function getLineStyle(index) {
  if (index === 1) return { width: '80%' };
  if (index === 2) return { width: '100%' };
  return { width: '60%' };
}
</script>

<style scoped>
.vm-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vm-skeleton--card {
  padding: 4px 0;
}

.vm-skeleton--list-item {
  padding: 8px 0;
  gap: 10px;
}

.vm-skeleton__line {
  height: 14px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: vm-shimmer 1.5s infinite;
  border-radius: 4px;
}

@keyframes vm-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>