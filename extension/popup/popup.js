// 使用配置文件中的 API 地址（如果配置文件存在）
const API_BASE = window.LOCAL_CONFIG
  ? window.LOCAL_CONFIG.API_BASE + '/' + window.LOCAL_CONFIG.API_VERSION
  : 'http://localhost:8080/api/v1';

const NETWORK_ERROR_CODE = 'NETWORK_UNAVAILABLE';
const NETWORK_COOLDOWN_MS = 30000;
const NETWORK_TIMEOUT_MS = 6000;
const USER_CACHE_TTL_MS = 5000;

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

function createNetworkUnavailableError() {
  const error = new Error('Failed to fetch');
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
    console.warn('[Popup] Backend unreachable, pausing requests for 30s.', error);
    networkState.hasLoggedOffline = true;
  }
}

function markNetworkOnline() {
  if (networkState.wasOffline) {
    console.info('[Popup] Backend connection restored.');
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
  document.getElementById('auth-form').style.display = 'block';
  document.getElementById('user-panel').style.display = 'none';
}

// 显示用户面板并获取标注数量
async function showUserPanel(user) {
  document.getElementById('auth-form').style.display = 'none';
  document.getElementById('user-panel').style.display = 'block';
  document.getElementById('user-panel').classList.add('user-panel-active');

  document.getElementById('display-username').textContent = user.username;
  document.getElementById('display-points').textContent = user.points || 0;
  document.getElementById('display-tier').textContent = (user.tier || 'Bronze').toUpperCase();
  
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
    document.getElementById('display-tier').textContent = (user.tier || 'Bronze').toUpperCase();
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

// 刷新功能
async function refreshAllData() {
  const refreshBtn = document.getElementById('refresh-btn');
  const originalText = refreshBtn.innerHTML;
  refreshBtn.innerHTML = '🔄 刷新中...';
  refreshBtn.disabled = true;
  
  try {
    await refreshUserInfo();
    showError('✓ 数据已刷新');
  } catch(err) {
    showError('刷新失败: ' + err.message);
  } finally {
    setTimeout(() => {
      refreshBtn.innerHTML = originalText;
      refreshBtn.disabled = false;
    }, 1000);
  }
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
  // 绑定刷新按钮
  document.getElementById('refresh-btn').onclick = refreshAllData;

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
  // 直接打开历史页面
  chrome.tabs.create({
    url: chrome.runtime.getURL('history/history.html')
  });
}
