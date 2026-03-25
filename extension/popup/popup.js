// 使用配置文件中的 API 地址（如果配置文件存在）
const API_BASE = window.LOCAL_CONFIG
  ? window.LOCAL_CONFIG.API_BASE + '/' + window.LOCAL_CONFIG.API_VERSION
  : 'http://localhost:8080/api/v1';

const NETWORK_ERROR_CODE = 'NETWORK_UNAVAILABLE';
const NETWORK_COOLDOWN_MS = 30000;
const NETWORK_TIMEOUT_MS = 6000;
const USER_CACHE_TTL_MS = 5000;
const MODEL_DEFAULT_CONFIG = Object.freeze({
  provider: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelName: 'qwen-vl-max',
  isEnabled: true
});

const networkState = {
  offlineUntil: 0,
  hasLoggedOffline: false,
  wasOffline: false
};

const userInfoCache = {
  data: null,
  updatedAt: 0,
  pending: null
};

const modelConfigState = {
  configured: false,
  hasApiKey: false,
  hasCustomConfig: false,
  effectiveSource: 'none',
  loading: false,
  saving: false,
  testing: false,
  feedbackType: '',
  feedbackMessage: '',
  form: {
    provider: MODEL_DEFAULT_CONFIG.provider,
    baseUrl: MODEL_DEFAULT_CONFIG.baseUrl,
    modelName: MODEL_DEFAULT_CONFIG.modelName,
    apiKey: '',
    isEnabled: MODEL_DEFAULT_CONFIG.isEnabled
  }
};

function createNetworkUnavailableError() {
  const error = new Error('网络不可用，请稍后重试');
  error.code = NETWORK_ERROR_CODE;
  return error;
}

function isNetworkFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const message = String(error.message || '').toLowerCase();
  if (message.includes('failed to fetch') || message.includes('networkerror') || message.includes('load failed')) {
    return true;
  }
  return error instanceof TypeError;
}

function markNetworkOffline(error) {
  networkState.offlineUntil = Date.now() + NETWORK_COOLDOWN_MS;
  networkState.wasOffline = true;
  if (!networkState.hasLoggedOffline) {
    console.warn('[Popup] 后端不可达，暂停请求 30 秒。', error);
    networkState.hasLoggedOffline = true;
  }
}

function markNetworkOnline() {
  if (networkState.wasOffline) {
    console.info('[Popup] 后端连接已恢复');
  }
  networkState.offlineUntil = 0;
  networkState.hasLoggedOffline = false;
  networkState.wasOffline = false;
}

async function safeFetch(url, options = {}) {
  if (Date.now() < networkState.offlineUntil) {
    throw createNetworkUnavailableError();
  }

  const controller = options.signal ? null : new AbortController();
  const timeoutId = setTimeout(() => {
    if (controller) controller.abort();
  }, NETWORK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal || (controller ? controller.signal : undefined)
    });
    clearTimeout(timeoutId);
    markNetworkOnline();
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (isNetworkFailure(error)) {
      markNetworkOffline(error);
      throw createNetworkUnavailableError();
    }
    throw error;
  }
}

function resetUserInfoCache() {
  userInfoCache.data = null;
  userInfoCache.updatedAt = 0;
  userInfoCache.pending = null;
}

function formatTierLabel(tier) {
  const rawTier = String(tier || '').trim();
  if (!rawTier) return '青铜会员';

  const normalized = rawTier.toLowerCase();
  const tierMap = {
    bronze: '青铜会员',
    silver: '白银会员',
    gold: '黄金会员',
    platinum: '铂金会员',
    diamond: '钻石会员',
    admin: '管理员'
  };

  if (tierMap[normalized]) return tierMap[normalized];
  if (/[\u4e00-\u9fa5]/.test(rawTier)) return rawTier;
  return '普通会员';
}

function showPanel(panelId) {
  document.getElementById('auth-form').style.display = panelId === 'auth-form' ? 'block' : 'none';
  document.getElementById('user-panel').style.display = panelId === 'user-panel' ? 'block' : 'none';
  document.getElementById('model-config-panel').style.display = panelId === 'model-config-panel' ? 'block' : 'none';
  document.body.classList.toggle('popup-mode-model-config', panelId === 'model-config-panel');
}

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('adskipper_user') || '{}');
  } catch (error) {
    return {};
  }
}

// 统一的API请求函数
async function apiRequest(endpoint, options = {}) {
  try {
    const token = localStorage.getItem('adskipper_token');
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    
    const res = await safeFetch(API_BASE + endpoint, {
      ...options,
      headers
    });
    
    // 检查Content-Type
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('服务器返回格式错误（可能后端未启动）');
    }
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  } catch(err) {
    if (err.code !== NETWORK_ERROR_CODE) {
      console.error('API Error:', err);
    }
    throw err;
  }
}

// 检查登录状态
async function checkAuth() {
  const token = localStorage.getItem('adskipper_token');
  if (!token) {
    showLoginForm();
    return false;
  }

  try {
    // 简单检查token是否过期（可选）
    const user = JSON.parse(localStorage.getItem('adskipper_user') || '{}');
    if (user.username) {
      showUserPanel(user);
      return true;
    }
  } catch(e) {
    localStorage.removeItem('adskipper_token');
    localStorage.removeItem('adskipper_user');
  }
  showLoginForm();
  return false;
}

async function getCurrentUserInfo(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && userInfoCache.data && (now - userInfoCache.updatedAt) < USER_CACHE_TTL_MS) {
    return userInfoCache.data;
  }

  if (!forceRefresh && userInfoCache.pending) {
    return userInfoCache.pending;
  }

  userInfoCache.pending = apiRequest('/auth/me')
    .then((data) => {
      userInfoCache.data = data;
      userInfoCache.updatedAt = Date.now();
      return data;
    })
    .finally(() => {
      userInfoCache.pending = null;
    });

  return userInfoCache.pending;
}

function showLoginForm() {
  showPanel('auth-form');
}

// 显示用户面板并获取标注数量
async function showUserPanel(user) {
  showPanel('user-panel');
  document.getElementById('user-panel').classList.add('user-panel-active');

  document.getElementById('display-username').textContent = user.username;
  document.getElementById('display-points').textContent = user.points || 0;
  document.getElementById('display-tier').textContent = formatTierLabel(user.tier);
  
  // 确保登录后面板使用最新跳过模式状态
  loadSkipModeSetting();

  // 获取并显示用户标注数量
  await loadUserContributionCount();
}

// 加载用户标注数量
async function loadUserContributionCount() {
  try {
    // 首先获取当前用户的ID
    const userInfo = await getCurrentUserInfo();
    const userId = await getUserIdByUsername(userInfo.username);
    
    if (userId) {
      // 调用用户贡献API获取标注总数
      const response = await safeFetch(`${API_BASE}/stats/user/contributions?user_id=${userId}&page_size=1`);
      if (response.ok) {
        const data = await response.json();
        if (data.code === 200) {
          document.getElementById('display-count').textContent = data.data.total || 0;
          console.log('[Popup] 标注数量已更新:', data.data.total);
        }
      }
    }
  } catch(err) {
    if (err.code !== NETWORK_ERROR_CODE) {
      console.error('[Popup] 获取标注数量失败:', err);
    }
    document.getElementById('display-count').textContent = '0';
  }
}

// 通过用户名获取用户ID（辅助函数）
async function getUserIdByUsername(username) {
  try {
    // 这里需要一个获取用户ID的API，暂时通过查询用户表实现
    // 或者可以在登录时将用户ID也存储到localStorage中
    const token = localStorage.getItem('adskipper_token');
    if (!token) return null;
    
    // 尝试从登录响应中获取用户ID（如果之前存储了的话）
    const storedUser = JSON.parse(localStorage.getItem('adskipper_user') || '{}');
    if (storedUser.userId) {
      return storedUser.userId;
    }
    
    // 如果没有存储userId，则需要通过API获取
    // 这里假设登录API返回的用户信息包含userId
    const loginData = await getCurrentUserInfo();
    // 注意：当前的/auth/me API不返回userId，我们需要修改它或者添加新的端点
    
    return null;
  } catch(err) {
    if (err.code !== NETWORK_ERROR_CODE) {
      console.error('获取用户ID失败:', err);
    }
    return null;
  }
}

// 刷新用户信息（包括积分和标注数量）
async function refreshUserInfo() {
  try {
    const user = await getCurrentUserInfo(true);
    // 更新localStorage
    localStorage.setItem('adskipper_user', JSON.stringify(user));
    // 更新显示
    document.getElementById('display-points').textContent = user.points || 0;
    document.getElementById('display-tier').textContent = formatTierLabel(user.tier);
    console.log('[Popup] 积分已刷新:', user.points);
    
    // 同时刷新标注数量
    await loadUserContributionCount();
  } catch(err) {
    if (err.code !== NETWORK_ERROR_CODE) {
      console.error('[Popup] 刷新用户信息失败:', err);
    }
  }
}

function showError(msg) {
  const err = document.getElementById('error-msg');
  err.textContent = msg;
  err.style.display = 'block';
  setTimeout(() => err.style.display = 'none', 4000);
}

async function handleAuth() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const isLogin = document.getElementById('submit-btn').textContent === '登录';
  
  if (!username || !password) {
    showError('请填写用户名和密码');
    return;
  }
  
  const btn = document.getElementById('submit-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = isLogin ? '登录中...' : '注册中...';
  
  try {
    const endpoint = isLogin ? '/auth/login' : '/auth/register';
    const data = await apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    
    if (isLogin) {
      localStorage.setItem('adskipper_token', data.token);
      // 存储完整的用户信息，包括userId
      localStorage.setItem('adskipper_user', JSON.stringify({
        username: data.username,
        points: data.points || 0,
        tier: data.tier || 'bronze',
        userId: data.userId || null // 如果登录API返回userId的话
      }));
      // 同步到 chrome.storage.local 供 content script 使用
      chrome.storage.local.set({ adskipper_token: data.token }, () => {
        console.log('[Popup] Token已同步到chrome.storage.local');
      });
      userInfoCache.data = data;
      userInfoCache.updatedAt = Date.now();
      userInfoCache.pending = null;
      showUserPanel(data);
    } else {
      showError('✓ 注册成功，请登录');
      toggleMode();
    }
  } catch(err) {
    showError(err.message || '网络错误，请检查后端是否启动 (localhost:8080)');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function toggleMode() {
  const btn = document.getElementById('submit-btn');
  const switchText = document.getElementById('switch-text');
  const isLogin = btn.textContent === '登录';
  
  if (isLogin) {
    btn.textContent = '注册';
    switchText.textContent = '已有账号？登录';
  } else {
    btn.textContent = '登录';
    switchText.textContent = '还没有账号？立即注册';
  }
}

function logout() {
  localStorage.removeItem('adskipper_token');
  localStorage.removeItem('adskipper_user');
  resetUserInfoCache();
  resetModelConfigForm();
  setModelConfigFeedback('', '');
  // 同时清理 chrome.storage.local
  chrome.storage.local.remove(['adskipper_token']);
  showLoginForm();
}

// 加载跳过模式设置
function loadSkipModeSetting() {
  chrome.storage.local.get(['skip_mode'], (storage) => {
    const mode = storage.skip_mode || 'auto';
    updateSkipModeUI(mode);
  });
}

// 更新跳过模式 UI
function updateSkipModeUI(mode) {
  const autoBtn = document.getElementById('user-mode-auto');
  const manualBtn = document.getElementById('user-mode-manual');
  if (!autoBtn || !manualBtn) return;

  autoBtn.classList.toggle('active', mode === 'auto');
  manualBtn.classList.toggle('active', mode === 'manual');
}

// 设置跳过模式
function setSkipMode(mode) {
  chrome.storage.local.set({ skip_mode: mode }, () => {
    console.log('[Popup] 跳过模式已设置为:', mode);
    updateSkipModeUI(mode);
  });
}

function getModelConfigElements() {
  return {
    panel: document.getElementById('model-config-panel'),
    provider: document.getElementById('model-provider'),
    baseUrl: document.getElementById('model-base-url'),
    modelName: document.getElementById('model-name'),
    apiKey: document.getElementById('model-api-key'),
    toggle: document.getElementById('model-enabled-toggle'),
    headerStatePill: document.getElementById('model-enabled-state-pill'),
    status: document.getElementById('model-config-status'),
    statusMeta: document.getElementById('model-config-status-meta'),
    apiKeyStatus: document.getElementById('model-api-key-status'),
    effectiveSource: document.getElementById('model-effective-source'),
    apiKeyBadge: document.getElementById('model-api-key-badge'),
    apiKeyHint: document.getElementById('model-api-key-hint'),
    feedback: document.getElementById('model-config-feedback'),
    testBtn: document.getElementById('model-test-btn'),
    saveBtn: document.getElementById('model-save-btn'),
    backBtn: document.getElementById('model-config-back')
  };
}

function resetModelConfigForm() {
  modelConfigState.configured = false;
  modelConfigState.hasApiKey = false;
  modelConfigState.hasCustomConfig = false;
  modelConfigState.effectiveSource = 'none';
  modelConfigState.form.provider = MODEL_DEFAULT_CONFIG.provider;
  modelConfigState.form.baseUrl = MODEL_DEFAULT_CONFIG.baseUrl;
  modelConfigState.form.modelName = MODEL_DEFAULT_CONFIG.modelName;
  modelConfigState.form.apiKey = '';
  modelConfigState.form.isEnabled = MODEL_DEFAULT_CONFIG.isEnabled;
}

function setModelConfigFeedback(type, message) {
  modelConfigState.feedbackType = type || '';
  modelConfigState.feedbackMessage = message || '';
}

function getModelConfigStatusLabel() {
  if (modelConfigState.effectiveSource === 'user_custom') return '已配置（自定义）';
  if (modelConfigState.effectiveSource === 'system_default' && modelConfigState.hasCustomConfig) {
    return '已保存自定义配置';
  }
  if (modelConfigState.effectiveSource === 'system_default') return '已配置（系统默认）';
  return '未配置';
}

function getModelConfigStatusMeta() {
  if (modelConfigState.effectiveSource === 'system_default' && modelConfigState.hasCustomConfig) {
    return '当前生效：系统默认';
  }
  return '';
}

function getModelConfigEffectiveSourceLabel() {
  if (modelConfigState.effectiveSource === 'user_custom') return '自定义配置';
  if (modelConfigState.effectiveSource === 'system_default') return '系统默认';
  return '暂无可用配置';
}

function getModelConfigApiKeyStatusLabel() {
  if (!modelConfigState.hasApiKey) return '未配置';
  if (modelConfigState.effectiveSource === 'system_default' && !modelConfigState.hasCustomConfig) return '系统默认 Key 可用';
  if (modelConfigState.effectiveSource === 'system_default' && modelConfigState.hasCustomConfig) return '已保存自定义 Key';
  return '已配置';
}

function getModelConfigApiKeyHint() {
  if (!modelConfigState.hasCustomConfig) {
    return modelConfigState.effectiveSource === 'system_default'
      ? '当前使用系统默认 Key；不保存新 Key 时继续沿用默认配置。'
      : '首次保存前必须填写 API Key。';
  }

  if (modelConfigState.effectiveSource === 'user_custom') {
    return '已保存自定义 Key；输入新值才会替换。';
  }

  return '当前使用系统默认 Key；已保存的自定义 Key 在重新启用后生效。';
}

function renderModelConfigPanel() {
  const elements = getModelConfigElements();
  if (!elements.panel) return;

  const formDisabled = modelConfigState.loading || modelConfigState.saving || modelConfigState.testing;
  const isBusy = modelConfigState.saving || modelConfigState.testing;
  const trimmedApiKey = String(modelConfigState.form.apiKey || '').trim();
  const testingSystemDefault = modelConfigState.effectiveSource === 'system_default' && !trimmedApiKey;

  elements.provider.value = modelConfigState.form.provider;
  elements.baseUrl.value = modelConfigState.form.baseUrl;
  elements.modelName.value = modelConfigState.form.modelName;
  elements.apiKey.value = modelConfigState.form.apiKey;

  elements.panel.dataset.source = modelConfigState.effectiveSource;
  elements.panel.dataset.configured = String(modelConfigState.configured);
  elements.panel.dataset.custom = String(modelConfigState.hasCustomConfig);
  elements.panel.dataset.enabled = String(modelConfigState.form.isEnabled);

  elements.status.textContent = getModelConfigStatusLabel();
  elements.statusMeta.textContent = getModelConfigStatusMeta();
  elements.statusMeta.style.display = elements.statusMeta.textContent ? 'block' : 'none';
  elements.apiKeyStatus.textContent = getModelConfigApiKeyStatusLabel();
  elements.effectiveSource.textContent = getModelConfigEffectiveSourceLabel();
  elements.apiKeyBadge.textContent = modelConfigState.hasApiKey ? '已配置' : '未配置';
  elements.apiKeyBadge.classList.toggle('active', modelConfigState.hasApiKey);
  elements.apiKeyHint.textContent = getModelConfigApiKeyHint();

  if (elements.headerStatePill) {
    let stateLabel = '待配置';
    let isInactive = true;

    if (modelConfigState.hasCustomConfig) {
      stateLabel = modelConfigState.form.isEnabled ? '当前启用' : '已暂停';
      isInactive = !modelConfigState.form.isEnabled;
    } else if (modelConfigState.effectiveSource === 'system_default') {
      stateLabel = '默认兜底';
      isInactive = false;
    }

    elements.headerStatePill.textContent = stateLabel;
    elements.headerStatePill.classList.toggle('inactive', isInactive);
  }

  elements.toggle.classList.toggle('active', modelConfigState.form.isEnabled);
  elements.toggle.setAttribute('aria-checked', String(modelConfigState.form.isEnabled));

  elements.provider.disabled = formDisabled;
  elements.baseUrl.disabled = formDisabled;
  elements.modelName.disabled = formDisabled;
  elements.apiKey.disabled = formDisabled;
  elements.toggle.disabled = formDisabled;
  elements.testBtn.disabled = formDisabled;
  elements.saveBtn.disabled = formDisabled;
  elements.backBtn.disabled = isBusy;

  elements.testBtn.textContent = modelConfigState.testing
    ? '测试中...'
    : testingSystemDefault
      ? '测试默认连接'
      : '测试连接';
  elements.saveBtn.textContent = modelConfigState.saving
    ? '保存中...'
    : modelConfigState.hasCustomConfig
      ? '保存配置'
      : '保存为自定义配置';

  elements.feedback.className = 'panel-feedback';
  elements.feedback.textContent = '';
  if (modelConfigState.feedbackMessage) {
    elements.feedback.classList.add(`panel-feedback--${modelConfigState.feedbackType || 'info'}`);
    elements.feedback.textContent = modelConfigState.feedbackMessage;
  }
}

function openModelConfigPanel() {
  showPanel('model-config-panel');
  renderModelConfigPanel();
  loadModelConfig();
}

function closeModelConfigPanel() {
  const user = getStoredUser();
  if (user.username) {
    showPanel('user-panel');
  } else {
    showLoginForm();
  }
}

function validateModelConfigFields() {
  if (!String(modelConfigState.form.provider || '').trim()) return '请选择 Provider';
  if (!String(modelConfigState.form.baseUrl || '').trim()) return '请填写 Base URL';
  if (!String(modelConfigState.form.modelName || '').trim()) return '请填写 Model Name';
  return '';
}

function buildModelConfigPayload(includeApiKey = false) {
  const payload = {
    provider: String(modelConfigState.form.provider || '').trim(),
    baseUrl: String(modelConfigState.form.baseUrl || '').trim(),
    modelName: String(modelConfigState.form.modelName || '').trim(),
    isEnabled: Boolean(modelConfigState.form.isEnabled)
  };

  const trimmedApiKey = String(modelConfigState.form.apiKey || '').trim();
  if (includeApiKey) {
    payload.apiKey = trimmedApiKey;
  } else if (trimmedApiKey) {
    payload.apiKey = trimmedApiKey;
  }

  return payload;
}

async function loadModelConfig(options = {}) {
  modelConfigState.loading = true;
  if (!options.keepFeedback) {
    setModelConfigFeedback('info', '正在同步当前配置...');
  }
  renderModelConfigPanel();

  try {
    const result = await apiRequest('/model-config', { method: 'GET' });
    const incoming = result?.data || null;

    modelConfigState.configured = Boolean(result?.configured);
    modelConfigState.hasCustomConfig = Boolean(result?.hasCustomConfig);
    modelConfigState.effectiveSource = typeof result?.effectiveSource === 'string' ? result.effectiveSource : 'none';
    modelConfigState.hasApiKey = Boolean(incoming?.hasApiKey);
    modelConfigState.form.provider = incoming?.provider || MODEL_DEFAULT_CONFIG.provider;
    modelConfigState.form.baseUrl = incoming?.baseUrl || MODEL_DEFAULT_CONFIG.baseUrl;
    modelConfigState.form.modelName = incoming?.modelName || MODEL_DEFAULT_CONFIG.modelName;
    modelConfigState.form.apiKey = '';
    modelConfigState.form.isEnabled = typeof incoming?.isEnabled === 'boolean'
      ? incoming.isEnabled
      : MODEL_DEFAULT_CONFIG.isEnabled;

    if (!options.keepFeedback) {
      setModelConfigFeedback('', '');
    }
  } catch (error) {
    resetModelConfigForm();
    setModelConfigFeedback('error', error.message || '读取配置失败，请稍后重试');
  } finally {
    modelConfigState.loading = false;
    renderModelConfigPanel();
  }
}

async function handleModelConfigSave() {
  const validationError = validateModelConfigFields();
  if (validationError) {
    setModelConfigFeedback('error', validationError);
    renderModelConfigPanel();
    return;
  }

  const requiresApiKey = !modelConfigState.hasCustomConfig || !modelConfigState.hasApiKey;
  if (requiresApiKey && !String(modelConfigState.form.apiKey || '').trim()) {
    setModelConfigFeedback('error', '首次保存前请先填写 API Key');
    renderModelConfigPanel();
    return;
  }

  modelConfigState.saving = true;
  setModelConfigFeedback('', '');
  renderModelConfigPanel();

  try {
    await apiRequest('/model-config', {
      method: 'POST',
      body: JSON.stringify(buildModelConfigPayload(false))
    });

    modelConfigState.form.apiKey = '';
    await loadModelConfig({ keepFeedback: true });
    setModelConfigFeedback('success', '配置保存成功');
  } catch (error) {
    setModelConfigFeedback('error', error.message || '保存配置失败');
  } finally {
    modelConfigState.saving = false;
    renderModelConfigPanel();
  }
}

async function handleModelConfigTest() {
  const validationError = validateModelConfigFields();
  if (validationError) {
    setModelConfigFeedback('error', validationError);
    renderModelConfigPanel();
    return;
  }

  const trimmedApiKey = String(modelConfigState.form.apiKey || '').trim();
  const useDefaultKey = modelConfigState.effectiveSource === 'system_default' && !trimmedApiKey;

  if (!trimmedApiKey && !useDefaultKey) {
    setModelConfigFeedback('error', '请重新输入 API Key 以测试当前配置');
    renderModelConfigPanel();
    return;
  }

  modelConfigState.testing = true;
  setModelConfigFeedback('', '');
  renderModelConfigPanel();

  try {
    const result = await apiRequest('/model-config/test', {
      method: 'POST',
      body: JSON.stringify({
        ...buildModelConfigPayload(true),
        useDefaultKey
      })
    });

    setModelConfigFeedback('success', result?.message || result?.reply || '连接成功');
  } catch (error) {
    setModelConfigFeedback('error', error.message || '测试连接失败');
  } finally {
    modelConfigState.testing = false;
    renderModelConfigPanel();
  }
}

function handleModelConfigInputChange() {
  const elements = getModelConfigElements();
  modelConfigState.form.provider = elements.provider.value;
  modelConfigState.form.baseUrl = elements.baseUrl.value;
  modelConfigState.form.modelName = elements.modelName.value;
  modelConfigState.form.apiKey = elements.apiKey.value;
}

function toggleModelConfigEnabled() {
  if (modelConfigState.loading || modelConfigState.saving || modelConfigState.testing) return;
  modelConfigState.form.isEnabled = !modelConfigState.form.isEnabled;
  renderModelConfigPanel();
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  const isLoggedIn = await checkAuth();

  // 如果已登录，刷新最新积分和标注数量
  if (isLoggedIn) {
    refreshUserInfo();
  }

  // 加载跳过模式设置
  loadSkipModeSetting();

  document.getElementById('submit-btn').onclick = handleAuth;
  document.getElementById('switch-text').onclick = toggleMode;
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('history-btn').onclick = openHistoryPage;
  document.getElementById('model-config-btn').onclick = openModelConfigPanel;
  document.getElementById('model-config-back').onclick = closeModelConfigPanel;
  document.getElementById('model-enabled-toggle').onclick = toggleModelConfigEnabled;
  document.getElementById('model-test-btn').onclick = handleModelConfigTest;
  document.getElementById('model-save-btn').onclick = handleModelConfigSave;
  document.getElementById('model-provider').onchange = handleModelConfigInputChange;
  document.getElementById('model-base-url').oninput = handleModelConfigInputChange;
  document.getElementById('model-name').oninput = handleModelConfigInputChange;
  document.getElementById('model-api-key').oninput = handleModelConfigInputChange;
  renderModelConfigPanel();

  // 绑定登录后面板的跳过模式切换按钮
  document.getElementById('user-mode-auto').onclick = () => setSkipMode('auto');
  document.getElementById('user-mode-manual').onclick = () => setSkipMode('manual');

  document.getElementById('password').onkeypress = (e) => {
    if (e.key === 'Enter') handleAuth();
  };

  // 检查后端健康状态
  apiRequest('/health')
    .then(() => console.log('后端连接正常'))
    .catch(() => showError('警告：无法连接后端，请确保localhost:8080运行中'));
});

// 打开标注历史页面
function openHistoryPage() {
  // 向当前活动的标签页发送消息，显示标注标记
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {action: 'showSegmentMarkers'}, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Popup] 发送消息失败:', chrome.runtime.lastError);
          showError('请在B站视频页面使用此功能');
        } else {
          // 显示成功提示
          const btn = document.getElementById('history-btn');
          btn.textContent = '✓ 标记已显示';
          setTimeout(() => btn.textContent = '📊 查看标注历史', 2000);
        }
      });
    }
  });
}
