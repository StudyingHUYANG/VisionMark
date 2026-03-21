<template>
  <Teleport to="body">
    <Transition name="vm-dialog">
      <div v-if="visible" class="vm-dialog-overlay" @click="handleClose">
        <div class="vm-dialog" @click.stop>
          <div class="vm-dialog__header">
            <div class="vm-dialog__icon">
              <!-- 火焰图标表示热词 -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2c0 0-5 6-5 12a5 5 0 0 0 10 0c0-6-5-12-5-12Z"/>
                <path d="M12 2v10"/>
              </svg>
            </div>
            <h3 class="vm-dialog__title">{{ word }}</h3>
            <!-- 弹窗里的关闭按钮 -->
            <button class="vm-dialog__close" @click="handleClose">
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          
          <div class="vm-dialog__content">
            <div v-if="timestamp" class="vm-dialog__time">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              出现时间: {{ timestamp }}
            </div>
            <div class="vm-dialog__desc">
              <span class="vm-dialog__desc-label">释义:</span> 
              {{ explanation || '暂无释义' }}
            </div>
          </div>

          <div class="vm-dialog__actions">
            <button class="vm-dialog__btn vw-dialog__btn--primary" @click="handleClose">
              我知道了
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  word: {
    type: String,
    default: ''
  },
  explanation: {
    type: String,
    default: ''
  },
  timestamp: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['update:visible', 'close']);

function handleClose() {
  emit('update:visible', false);
  emit('close');
}
</script>

<style scoped>
.vm-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.vm-dialog {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.98) 0%, rgba(255, 248, 250, 0.95) 100%);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-radius: 20px;
  padding: 24px;
  width: 90%;
  max-width: 360px;
  box-shadow:
    0 24px 48px rgba(251, 114, 153, 0.15),
    0 12px 24px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.8);
  display: flex;
  flex-direction: column;
  gap: 16px;
  transform-origin: center center;
}

.vm-dialog__header {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
}

.vm-dialog__icon {
  width: 40px;
  height: 40px;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(251, 114, 153, 0.15) 0%, rgba(251, 114, 153, 0.05) 100%);
  border-radius: 12px;
  border: 1px solid rgba(251, 114, 153, 0.2);
}

.vm-dialog__icon svg {
  width: 22px;
  height: 22px;
  color: #fb7299;
}

.vm-dialog__title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #fb7299;
  flex: 1;
  text-shadow: 0 2px 4px rgba(251, 114, 153, 0.1);
}

.vm-dialog__close {
  background: none;
  border: none;
  cursor: pointer;
  color: #999;
  padding: 4px;
  border-radius: 50%;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.vm-dialog__close:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #333;
}

.vm-dialog__content {
  background: rgba(255, 255, 255, 0.6);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(251, 114, 153, 0.1);
}

.vm-dialog__time {
  font-size: 13px;
  color: #666;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.vm-dialog__desc {
  font-size: 15px;
  color: #333;
  line-height: 1.6;
}

.vm-dialog__desc-label {
  font-weight: 600;
  color: #fb7299;
  margin-right: 4px;
}

.vm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.vw-dialog__btn--primary {
  padding: 10px 24px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  background: linear-gradient(135deg, #fb7299 0%, #e2587f 100%);
  color: #fff;
  border: none;
  box-shadow: 0 4px 12px rgba(251, 114, 153, 0.3);
  transition: all 0.2s;
}

.vw-dialog__btn--primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(251, 114, 153, 0.4);
}

.vw-dialog__btn--primary:active {
  transform: translateY(0);
}

/* Transition animations */
.vm-dialog-enter-active,
.vm-dialog-leave-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.vm-dialog-enter-active .vm-dialog,
.vm-dialog-leave-active .vm-dialog {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.vm-dialog-enter-from,
.vm-dialog-leave-to {
  opacity: 0;
  backdrop-filter: blur(0);
}

.vm-dialog-enter-from .vm-dialog,
.vm-dialog-leave-to .vm-dialog {
  transform: scale(0.85) translateY(10px);
  opacity: 0;
}
</style>
