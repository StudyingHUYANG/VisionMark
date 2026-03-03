<template>
  <div class="ai-assistant-vue-root">
    <!-- Vue 渲染测试 UI -->
    <div class="test-panel">
      <h3>Vue 3 微前端助手</h3>
      <p>当前播放时间: <strong>{{ videoState.currentTime.toFixed(2) }}s</strong></p>
      <p>当前 BVID: {{ videoState.bvid || '未获取' }}</p>
      <p>
        广告段数: {{ videoState.segments.length }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { videoState } from './store.js';

</script>

<style scoped>
.ai-assistant-vue-root {
  position: fixed;
  top: 100px;
  right: 20px;
  z-index: 999999;
  font-family: Arial, sans-serif;
  pointer-events: none; /* 防止挡住底下的原生交互 */
}

.test-panel {
  background: rgba(20, 20, 20, 0.9);
  color: #fff;
  padding: 15px;
  border-radius: 8px;
  border: 1px solid rgba(255, 105, 180, 0.5); /* B站粉色系边框色感 */
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
  min-width: 200px;
  pointer-events: auto; /* 让面板自身可以交互（如果后续添加按钮） */
}

.test-panel h3 {
  margin: 0 0 10px 0;
  font-size: 14px;
  color: #FB7299;
}

.test-panel p {
  margin: 5px 0;
  font-size: 13px;
}
</style>
