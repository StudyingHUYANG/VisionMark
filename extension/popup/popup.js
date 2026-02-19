// 使用配置文件中的 API 地址（如果配置文件存在）
const API_BASE = window.LOCAL_CONFIG
  ? window.LOCAL_CONFIG.API_BASE + '/' + window.LOCAL_CONFIG.API_VERSION
  : 'http://localhost:3000/api/v1';

// 统一的API请求函数
async function apiRequest(endpoint, options = {}) {
  try {
    const token = localStorage.getItem('adskipper_token');
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    
    const res = await fetch(API_BASE + endpoint, {
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
    console.error('API Error:', err);
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

function showLoginForm() {
  document.getElementById('auth-form').style.display = 'block';
  document.getElementById('user-panel').style.display = 'none';
}

function showUserPanel(user) {
  document.getElementById('auth-form').style.display = 'none';
  document.getElementById('user-panel').style.display = 'block';
  document.getElementById('user-panel').classList.add('user-panel-active');

  document.getElementById('display-username').textContent = user.username;
  document.getElementById('display-points').textContent = user.points || 0;
  document.getElementById('display-tier').textContent = (user.tier || 'Bronze').toUpperCase();
}

// 刷新用户积分
async function refreshUserInfo() {
  try {
    const user = await apiRequest('/auth/me');
    // 更新localStorage
    localStorage.setItem('adskipper_user', JSON.stringify(user));
    // 更新显示
    document.getElementById('display-points').textContent = user.points || 0;
    document.getElementById('display-tier').textContent = (user.tier || 'Bronze').toUpperCase();
    console.log('[Popup] 积分已刷新:', user.points);
  } catch(err) {
    console.error('[Popup] 刷新积分失败:', err);
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
      localStorage.setItem('adskipper_user', JSON.stringify(data));
      // 同步到 chrome.storage.local 供 content script 使用
      chrome.storage.local.set({ adskipper_token: data.token }, () => {
        console.log('[Popup] Token已同步到chrome.storage.local');
      });
      showUserPanel(data);
    } else {
      showError('✓ 注册成功，请登录');
      toggleMode();
    }
  } catch(err) {
    showError(err.message || '网络错误，请检查后端是否启动 (localhost:3000)');
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
  // 同时清理 chrome.storage.local
  chrome.storage.local.remove(['adskipper_token']);
  showLoginForm();
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  const isLoggedIn = await checkAuth();

  // 如果已登录，刷新最新积分
  if (isLoggedIn) {
    refreshUserInfo();
  }

  document.getElementById('submit-btn').onclick = handleAuth;
  document.getElementById('switch-text').onclick = toggleMode;
  document.getElementById('logout-btn').onclick = logout;

  document.getElementById('password').onkeypress = (e) => {
    if (e.key === 'Enter') handleAuth();
  };

  // 检查后端健康状态
  apiRequest('/health')
    .then(() => console.log('后端连接正常'))
    .catch(() => showError('警告：无法连接后端，请确保localhost:3000运行中'));
});
