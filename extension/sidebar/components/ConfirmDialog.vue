<template>
  <Teleport to="body">
    <Transition name="vm-dialog">
      <div v-if="modelValue" class="vm-dialog-overlay" @click="handleCancel">
        <div class="vm-dialog" @click.stop>
          <div class="vm-dialog__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <h3 class="vm-dialog__title">{{ title }}</h3>
          <p class="vm-dialog__message">{{ message }}</p>
          <div class="vm-dialog__actions">
            <button class="vm-dialog__btn vm-dialog__btn--secondary" @click="handleCancel">
              取消
            </button>
            <button class="vm-dialog__btn vm-dialog__btn--danger" @click="handleConfirm">
              确认删除
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: '确认操作'
  },
  message: {
    type: String,
    default: '确定要执行此操作吗？'
  }
});

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel']);

function handleCancel() {
  emit('update:modelValue', false);
  emit('cancel');
}

function handleConfirm() {
  emit('update:modelValue', false);
  emit('confirm');
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
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.vm-dialog {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.98) 0%, rgba(255, 248, 250, 0.95) 100%);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-radius: 16px;
  padding: 24px;
  min-width: 320px;
  max-width: 400px;
  box-shadow:
    0 20px 60px rgba(251, 114, 153, 0.15),
    0 8px 24px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.7);
  text-align: center;
}

.vm-dialog__icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, rgba(239, 68, 68, 0.05) 100%);
  border-radius: 50%;
  border: 1px solid rgba(239, 68, 68, 0.15);
}

.vm-dialog__icon svg {
  width: 24px;
  height: 24px;
  color: #ef4444;
}

.vm-dialog__title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.vm-dialog__message {
  margin: 0 0 24px;
  font-size: 14px;
  line-height: 1.6;
  color: #666;
}

.vm-dialog__actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.vm-dialog__btn {
  flex: 1;
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  border: none;
}

.vm-dialog__btn--secondary {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.9) 0%, rgba(245, 245, 245, 0.85) 100%);
  color: #666;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.03),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

.vm-dialog__btn--secondary:hover {
  background: linear-gradient(145deg, rgba(255, 255, 255, 1) 0%, rgba(250, 250, 250, 0.95) 100%);
  transform: translateY(-1px);
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 1);
}

.vm-dialog__btn--danger {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: #fff;
  border: 1px solid rgba(239, 68, 68, 0.3);
  box-shadow:
    0 2px 8px rgba(239, 68, 68, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.vm-dialog__btn--danger:hover {
  background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
  transform: translateY(-1px);
  box-shadow:
    0 4px 16px rgba(239, 68, 68, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

/* Transition animations */
.vm-dialog-enter-active,
.vm-dialog-leave-active {
  transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.vm-dialog-enter-active .vm-dialog,
.vm-dialog-leave-active .vm-dialog {
  transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.vm-dialog-enter-from,
.vm-dialog-leave-to {
  opacity: 0;
}

.vm-dialog-enter-from .vm-dialog,
.vm-dialog-leave-to .vm-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>