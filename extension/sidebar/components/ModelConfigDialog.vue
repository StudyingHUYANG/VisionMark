<template>
  <Teleport to="body">
    <Transition name="vm-model-dialog">
      <div
        v-if="visible"
        class="vm-model-dialog-overlay"
        @click="handleOverlayClose"
      >
        <section
          class="vm-model-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vm-model-config-title"
          @click.stop
        >
          <header class="vm-model-dialog__header">
            <div class="vm-model-dialog__header-copy">
              <div class="vm-model-dialog__eyebrow">VisionMark API</div>
              <h3 id="vm-model-config-title" class="vm-model-dialog__title">自定义 API 设置</h3>
              <p class="vm-model-dialog__subtitle">
                连接你自己的模型配置。当前先支持 Qwen，后续可继续扩展 provider。
              </p>
            </div>
            <button
              class="vm-model-dialog__close"
              type="button"
              :disabled="isBusy"
              aria-label="关闭"
              @click="handleClose"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18" />
                <path d="M6 6 18 18" />
              </svg>
            </button>
          </header>

          <div class="vm-model-dialog__body">
            <section class="vm-model-dialog__hero">
              <div class="vm-model-dialog__status-card">
                <span class="vm-model-dialog__status-label">配置状态</span>
                <strong class="vm-model-dialog__status-value">{{ configStatusLabel }}</strong>
                <span v-if="configStatusMeta" class="vm-model-dialog__status-meta">{{ configStatusMeta }}</span>
              </div>
              <div class="vm-model-dialog__status-card">
                <span class="vm-model-dialog__status-label">API Key</span>
                <strong class="vm-model-dialog__status-value">{{ apiKeyStatusLabel }}</strong>
              </div>
              <div class="vm-model-dialog__status-card">
                <span class="vm-model-dialog__status-label">当前生效</span>
                <strong class="vm-model-dialog__status-value">{{ effectiveSourceLabel }}</strong>
              </div>
            </section>

            <div v-if="loadingConfig" class="vm-model-dialog__alert vm-model-dialog__alert--info">
              正在同步当前配置...
            </div>

            <div v-if="loadError" class="vm-model-dialog__alert vm-model-dialog__alert--error">
              {{ loadError }}
            </div>

            <div v-if="saveFeedback.message" :class="['vm-model-dialog__alert', feedbackClass(saveFeedback.type)]">
              {{ saveFeedback.message }}
            </div>

            <div v-if="testFeedback.message" :class="['vm-model-dialog__alert', feedbackClass(testFeedback.type)]">
              {{ testFeedback.message }}
            </div>

            <div class="vm-model-dialog__grid">
              <label class="vm-model-dialog__field">
                <span class="vm-model-dialog__field-label">Provider</span>
                <select v-model="form.provider" class="vm-model-dialog__input" :disabled="formDisabled">
                  <option
                    v-for="option in providerOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <label class="vm-model-dialog__field vm-model-dialog__field--wide">
                <span class="vm-model-dialog__field-label">Base URL</span>
                <input
                  v-model="form.baseUrl"
                  class="vm-model-dialog__input"
                  type="text"
                  :disabled="formDisabled"
                  placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                >
              </label>

              <label class="vm-model-dialog__field vm-model-dialog__field--wide">
                <span class="vm-model-dialog__field-label">Model Name</span>
                <input
                  v-model="form.modelName"
                  class="vm-model-dialog__input"
                  type="text"
                  :disabled="formDisabled"
                  placeholder="qwen-vl-max"
                >
              </label>

              <label class="vm-model-dialog__field vm-model-dialog__field--wide">
                <span class="vm-model-dialog__field-label">API Key</span>
                <input
                  v-model="form.apiKey"
                  class="vm-model-dialog__input"
                  type="password"
                  :disabled="formDisabled"
                  autocomplete="new-password"
                  placeholder="请输入 API Key"
                >
                <div class="vm-model-dialog__field-hint">
                  <span class="vm-model-dialog__badge" :class="{ 'vm-model-dialog__badge--active': hasApiKey }">
                    {{ hasApiKey ? '已配置' : '未配置' }}
                  </span>
                  <span>{{ apiKeyHint }}</span>
                </div>
              </label>

              <div class="vm-model-dialog__switch-row">
                <div class="vm-model-dialog__switch-copy">
                  <span class="vm-model-dialog__field-label">启用当前配置</span>
                  <p class="vm-model-dialog__switch-hint">
                    关闭后会保留配置，但不会作为当前用户的生效模型设置。
                  </p>
                </div>
                <button
                  class="vm-model-dialog__switch"
                  :class="{ 'vm-model-dialog__switch--active': form.isEnabled }"
                  type="button"
                  role="switch"
                  :aria-checked="String(form.isEnabled)"
                  :disabled="formDisabled"
                  @click="toggleEnabled"
                >
                  <span class="vm-model-dialog__switch-thumb" />
                </button>
              </div>
            </div>
          </div>

          <footer class="vm-model-dialog__footer">
            <button
              class="vm-model-dialog__btn vm-model-dialog__btn--ghost"
              type="button"
              :disabled="isBusy"
              @click="handleClose"
            >
              关闭
            </button>
            <button
              class="vm-model-dialog__btn vm-model-dialog__btn--secondary"
              type="button"
              :disabled="formDisabled"
              @click="handleTestConnection"
            >
              {{ testingConnection ? '测试中...' : '测试连接' }}
            </button>
            <button
              class="vm-model-dialog__btn vm-model-dialog__btn--primary"
              type="button"
              :disabled="formDisabled"
              @click="handleSave"
            >
              {{ savingConfig ? '保存中...' : '保存配置' }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:visible']);

const DEFAULT_CONFIG = Object.freeze({
  provider: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelName: 'qwen-vl-max',
  isEnabled: true
});

const providerOptions = Object.freeze([
  { label: 'Qwen', value: 'qwen' }
]);

const REQUEST_TIMEOUT_MS = 8000;
const API_BASE = window.LOCAL_CONFIG
  ? `${window.LOCAL_CONFIG.API_BASE}/${window.LOCAL_CONFIG.API_VERSION}`
  : 'http://localhost:8080/api/v1';

const form = reactive({
  provider: DEFAULT_CONFIG.provider,
  baseUrl: DEFAULT_CONFIG.baseUrl,
  modelName: DEFAULT_CONFIG.modelName,
  apiKey: '',
  isEnabled: DEFAULT_CONFIG.isEnabled
});

const configured = ref(false);
const hasApiKey = ref(false);
const effectiveSource = ref('none');
const hasCustomConfig = ref(false);
const loadingConfig = ref(false);
const savingConfig = ref(false);
const testingConnection = ref(false);
const loadError = ref('');
const saveFeedback = reactive({
  type: 'info',
  message: ''
});
const testFeedback = reactive({
  type: 'info',
  message: ''
});

let loadRequestId = 0;

const formDisabled = computed(() => loadingConfig.value || savingConfig.value || testingConnection.value);
const isBusy = computed(() => savingConfig.value || testingConnection.value);
const effectiveSourceLabel = computed(() => {
  if (effectiveSource.value === 'user_custom') return '自定义配置';
  if (effectiveSource.value === 'system_default') return '系统默认';
  return '暂无可用配置';
});
const configStatusLabel = computed(() => {
  if (effectiveSource.value === 'user_custom') return '已配置（自定义）';
  if (effectiveSource.value === 'system_default' && hasCustomConfig.value) return '已保存自定义配置';
  if (effectiveSource.value === 'system_default') return '已配置（系统默认）';
  return '未配置';
});
const configStatusMeta = computed(() => {
  if (effectiveSource.value === 'system_default' && hasCustomConfig.value) {
    return '当前生效：系统默认';
  }
  return '';
});
const apiKeyStatusLabel = computed(() => {
  if (!hasApiKey.value) return '未配置';
  if (effectiveSource.value === 'system_default' && !hasCustomConfig.value) return '系统默认 Key 可用';
  if (effectiveSource.value === 'system_default' && hasCustomConfig.value) return '已保存自定义 Key';
  return '已配置';
});
const apiKeyHint = computed(() => {
  if (!hasCustomConfig.value) {
    return effectiveSource.value === 'system_default'
      ? '当前使用系统默认 Key；不保存新 Key 时继续沿用默认配置。'
      : '首次保存前必须填写 API Key。';
  }

  if (effectiveSource.value === 'user_custom') {
    return '已保存自定义 Key；输入新值才会替换。';
  }

  return '当前使用系统默认 Key；已保存的自定义 Key 在重新启用后生效。';
});

function applyDefaultForm() {
  form.provider = DEFAULT_CONFIG.provider;
  form.baseUrl = DEFAULT_CONFIG.baseUrl;
  form.modelName = DEFAULT_CONFIG.modelName;
  form.apiKey = '';
  form.isEnabled = DEFAULT_CONFIG.isEnabled;
  configured.value = false;
  hasApiKey.value = false;
  effectiveSource.value = 'none';
  hasCustomConfig.value = false;
}

function clearFeedback() {
  saveFeedback.type = 'info';
  saveFeedback.message = '';
  testFeedback.type = 'info';
  testFeedback.message = '';
}

function feedbackClass(type) {
  if (type === 'success') return 'vm-model-dialog__alert--success';
  if (type === 'error') return 'vm-model-dialog__alert--error';
  return 'vm-model-dialog__alert--info';
}

function updateFeedback(target, type, message) {
  target.type = type;
  target.message = message;
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function handleClose() {
  if (isBusy.value) return;
  emit('update:visible', false);
}

function handleOverlayClose() {
  if (isBusy.value) return;
  handleClose();
}

function toggleEnabled() {
  if (formDisabled.value) return;
  form.isEnabled = !form.isEnabled;
}

function buildPayload(includeApiKey = false) {
  const payload = {
    provider: String(form.provider || '').trim(),
    baseUrl: String(form.baseUrl || '').trim(),
    modelName: String(form.modelName || '').trim(),
    isEnabled: Boolean(form.isEnabled)
  };

  if (includeApiKey) {
    payload.apiKey = String(form.apiKey || '').trim();
  } else {
    const trimmedApiKey = String(form.apiKey || '').trim();
    if (trimmedApiKey) payload.apiKey = trimmedApiKey;
  }

  return payload;
}

function validateCommonFields() {
  const payload = buildPayload(false);
  if (!payload.provider) return '请选择 Provider';
  if (!payload.baseUrl) return '请填写 Base URL';
  if (!payload.modelName) return '请填写 Model Name';
  return '';
}

function getAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['adskipper_token'], (storage) => {
      resolve(storage?.adskipper_token || '');
    });
  });
}

async function apiRequest(endpoint, options = {}) {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('请先登录插件');
  }

  const controller = options.signal ? null : new AbortController();
  const timeoutId = setTimeout(() => {
    if (controller) controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      },
      signal: options.signal || (controller ? controller.signal : undefined)
    });

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;

    if (!response.ok) {
      throw new Error(data?.error || data?.message || '请求失败');
    }

    return data || {};
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadConfig(options = {}) {
  const requestId = ++loadRequestId;
  loadingConfig.value = true;
  loadError.value = '';

  if (!options.keepFeedback) {
    clearFeedback();
  }

  try {
    const result = await apiRequest('/model-config', { method: 'GET' });
    if (requestId !== loadRequestId) return;

    const incoming = result?.data || null;
    configured.value = Boolean(result?.configured);
    hasApiKey.value = Boolean(incoming?.hasApiKey);
    effectiveSource.value = typeof result?.effectiveSource === 'string' ? result.effectiveSource : 'none';
    hasCustomConfig.value = Boolean(result?.hasCustomConfig);

    form.provider = incoming?.provider || DEFAULT_CONFIG.provider;
    form.baseUrl = incoming?.baseUrl || DEFAULT_CONFIG.baseUrl;
    form.modelName = incoming?.modelName || DEFAULT_CONFIG.modelName;
    form.isEnabled = normalizeBoolean(incoming?.isEnabled, DEFAULT_CONFIG.isEnabled);
    form.apiKey = '';
  } catch (error) {
    if (requestId !== loadRequestId) return;

    configured.value = false;
    hasApiKey.value = false;
    effectiveSource.value = 'none';
    hasCustomConfig.value = false;
    applyDefaultForm();
    loadError.value = error?.message || '读取配置失败，请稍后重试';
  } finally {
    if (requestId === loadRequestId) {
      loadingConfig.value = false;
    }
  }
}

async function handleSave() {
  const commonError = validateCommonFields();
  if (commonError) {
    updateFeedback(saveFeedback, 'error', commonError);
    return;
  }

  const requiresApiKey = !hasCustomConfig.value || !hasApiKey.value;
  if (requiresApiKey && !String(form.apiKey || '').trim()) {
    updateFeedback(saveFeedback, 'error', '首次保存前请先填写 API Key');
    return;
  }

  savingConfig.value = true;
  updateFeedback(saveFeedback, 'info', '');

  try {
    await apiRequest('/model-config', {
      method: 'POST',
      body: JSON.stringify(buildPayload(false))
    });

    form.apiKey = '';
    await loadConfig({ keepFeedback: true });
    updateFeedback(saveFeedback, 'success', '配置保存成功');
  } catch (error) {
    updateFeedback(saveFeedback, 'error', error?.message || '保存配置失败');
  } finally {
    savingConfig.value = false;
  }
}

async function handleTestConnection() {
  const commonError = validateCommonFields();
  if (commonError) {
    updateFeedback(testFeedback, 'error', commonError);
    return;
  }

  const trimmedApiKey = String(form.apiKey || '').trim();
  const canUseDefaultKey = effectiveSource.value === 'system_default' && !trimmedApiKey;

  if (!trimmedApiKey && !canUseDefaultKey) {
    updateFeedback(testFeedback, 'error', '请重新输入 API Key 以测试当前配置');
    return;
  }

  testingConnection.value = true;
  updateFeedback(testFeedback, 'info', '');

  try {
    const result = await apiRequest('/model-config/test', {
      method: 'POST',
      body: JSON.stringify({
        ...buildPayload(true),
        useDefaultKey: canUseDefaultKey
      })
    });

    const successMessage = result?.message || result?.reply || '连接成功';
    updateFeedback(testFeedback, 'success', successMessage);
  } catch (error) {
    updateFeedback(testFeedback, 'error', error?.message || '测试连接失败');
  } finally {
    testingConnection.value = false;
  }
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || !props.visible) return;
  if (isBusy.value) return;
  handleClose();
}

watch(() => props.visible, (visible) => {
  if (visible) {
    loadConfig();
    return;
  }

  loadError.value = '';
  clearFeedback();
  form.apiKey = '';
  configured.value = false;
  hasApiKey.value = false;
  effectiveSource.value = 'none';
  hasCustomConfig.value = false;
});

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<style scoped>
.vm-model-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at top, rgba(251, 114, 153, 0.18), transparent 34%),
    rgba(20, 24, 38, 0.42);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.vm-model-dialog {
  width: min(680px, 100%);
  max-height: min(88vh, 920px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 24px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(255, 247, 250, 0.92) 100%),
    var(--vm-gradient-soft);
  border: 1px solid rgba(255, 255, 255, 0.75);
  box-shadow:
    0 36px 90px rgba(251, 114, 153, 0.18),
    0 12px 32px rgba(15, 23, 42, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
  color: var(--vm-text-primary);
  font-family: var(--vm-font-family);
}

.vm-model-dialog__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 24px 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.38) 100%);
  border-bottom: 1px solid rgba(251, 114, 153, 0.1);
}

.vm-model-dialog__header-copy {
  min-width: 0;
}

.vm-model-dialog__eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(251, 114, 153, 0.82);
  font-weight: 700;
  margin-bottom: 8px;
}

.vm-model-dialog__title {
  margin: 0;
  font-size: 28px;
  line-height: 1.1;
  color: #2b2f38;
}

.vm-model-dialog__subtitle {
  margin: 10px 0 0;
  font-size: 14px;
  line-height: 1.7;
  color: rgba(51, 51, 51, 0.7);
}

.vm-model-dialog__close {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(251, 114, 153, 0.12);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.76);
  color: rgba(51, 51, 51, 0.7);
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, color 0.2s ease;
}

.vm-model-dialog__close:hover:not(:disabled) {
  transform: translateY(-1px);
  color: var(--vm-color-primary);
  box-shadow: 0 12px 24px rgba(251, 114, 153, 0.12);
}

.vm-model-dialog__close:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.vm-model-dialog__body {
  padding: 20px 24px 24px;
  overflow-y: auto;
}

.vm-model-dialog__hero {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.vm-model-dialog__status-card {
  padding: 16px;
  border-radius: 16px;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 246, 249, 0.86) 100%);
  border: 1px solid rgba(251, 114, 153, 0.1);
  box-shadow: 0 12px 24px rgba(251, 114, 153, 0.06);
}

.vm-model-dialog__status-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: rgba(102, 102, 102, 0.9);
}

.vm-model-dialog__status-value {
  display: block;
  font-size: 15px;
  line-height: 1.5;
  color: #2b2f38;
}

.vm-model-dialog__status-meta {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: rgba(102, 102, 102, 0.92);
}

.vm-model-dialog__alert {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid transparent;
}

.vm-model-dialog__alert--info {
  background: rgba(25, 118, 210, 0.08);
  border-color: rgba(25, 118, 210, 0.12);
  color: #1f4f82;
}

.vm-model-dialog__alert--success {
  background: rgba(34, 197, 94, 0.09);
  border-color: rgba(34, 197, 94, 0.18);
  color: #166534;
}

.vm-model-dialog__alert--error {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.18);
  color: #b42318;
}

.vm-model-dialog__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.vm-model-dialog__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vm-model-dialog__field--wide {
  grid-column: 1 / -1;
}

.vm-model-dialog__field-label {
  font-size: 13px;
  font-weight: 600;
  color: #444;
}

.vm-model-dialog__input {
  width: 100%;
  min-height: 46px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(251, 114, 153, 0.12);
  background: rgba(255, 255, 255, 0.9);
  color: #222;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}

.vm-model-dialog__input:focus {
  border-color: rgba(251, 114, 153, 0.42);
  box-shadow: 0 0 0 4px rgba(251, 114, 153, 0.12);
}

.vm-model-dialog__input:disabled {
  cursor: not-allowed;
  opacity: 0.7;
  background: rgba(248, 248, 248, 0.88);
}

.vm-model-dialog__field-hint {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: rgba(102, 102, 102, 0.92);
}

.vm-model-dialog__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 9px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
  font-weight: 700;
}

.vm-model-dialog__badge--active {
  background: rgba(251, 114, 153, 0.12);
  color: #be185d;
}

.vm-model-dialog__switch-row {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px;
  border-radius: 18px;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 248, 250, 0.85) 100%);
  border: 1px solid rgba(251, 114, 153, 0.08);
}

.vm-model-dialog__switch-copy {
  min-width: 0;
}

.vm-model-dialog__switch-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(102, 102, 102, 0.92);
}

.vm-model-dialog__switch {
  position: relative;
  width: 58px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.4);
  cursor: pointer;
  transition: background 0.2s ease, box-shadow 0.2s ease;
}

.vm-model-dialog__switch--active {
  background: linear-gradient(135deg, #fb7299 0%, #ff8fa3 100%);
  box-shadow: 0 8px 20px rgba(251, 114, 153, 0.3);
}

.vm-model-dialog__switch:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.vm-model-dialog__switch-thumb {
  position: absolute;
  top: 3px;
  left: 4px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.16);
  transition: transform 0.2s ease;
}

.vm-model-dialog__switch--active .vm-model-dialog__switch-thumb {
  transform: translateX(24px);
}

.vm-model-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 18px 24px 24px;
  border-top: 1px solid rgba(251, 114, 153, 0.08);
  background: rgba(255, 255, 255, 0.66);
}

.vm-model-dialog__btn {
  min-width: 112px;
  min-height: 44px;
  padding: 10px 18px;
  border-radius: 14px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}

.vm-model-dialog__btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.vm-model-dialog__btn:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.vm-model-dialog__btn--ghost {
  background: rgba(255, 255, 255, 0.76);
  color: #475569;
  border-color: rgba(148, 163, 184, 0.18);
}

.vm-model-dialog__btn--secondary {
  background: rgba(251, 114, 153, 0.08);
  color: #be185d;
  border-color: rgba(251, 114, 153, 0.12);
}

.vm-model-dialog__btn--primary {
  background: linear-gradient(135deg, #fb7299 0%, #ff8fa3 100%);
  color: #fff;
  box-shadow: 0 12px 24px rgba(251, 114, 153, 0.24);
}

.vm-model-dialog-enter-active,
.vm-model-dialog-leave-active {
  transition: opacity 0.22s ease;
}

.vm-model-dialog-enter-active .vm-model-dialog,
.vm-model-dialog-leave-active .vm-model-dialog {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.vm-model-dialog-enter-from,
.vm-model-dialog-leave-to {
  opacity: 0;
}

.vm-model-dialog-enter-from .vm-model-dialog,
.vm-model-dialog-leave-to .vm-model-dialog {
  opacity: 0;
  transform: translateY(16px) scale(0.98);
}

@media (max-width: 720px) {
  .vm-model-dialog-overlay {
    padding: 12px;
  }

  .vm-model-dialog {
    max-height: 94vh;
    border-radius: 20px;
  }

  .vm-model-dialog__header,
  .vm-model-dialog__body,
  .vm-model-dialog__footer {
    padding-left: 16px;
    padding-right: 16px;
  }

  .vm-model-dialog__title {
    font-size: 24px;
  }

  .vm-model-dialog__hero,
  .vm-model-dialog__grid {
    grid-template-columns: 1fr;
  }

  .vm-model-dialog__footer {
    flex-wrap: wrap;
  }

  .vm-model-dialog__btn {
    flex: 1 1 calc(50% - 6px);
  }
}
</style>
