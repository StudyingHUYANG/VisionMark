// Load settings on page load
document.addEventListener('DOMContentLoaded', () => {
  // Load skip mode
  chrome.storage.local.get(['skip_mode', 'skip_types'], (storage) => {
    const mode = storage.skip_mode || 'auto';
    updateSkipModeUI(mode);

    // Load ad type preferences
    const types = storage.skip_types || ['hard_ad', 'soft_ad', 'product_placement'];
    document.getElementById('type-hard').checked = types.includes('hard_ad');
    document.getElementById('type-soft').checked = types.includes('soft_ad');
    document.getElementById('type-placement').checked = types.includes('product_placement');
    document.getElementById('type-intro').checked = types.includes('intro_ad');
    document.getElementById('type-mid').checked = types.includes('mid_ad');
  });

  // Bind skip mode buttons
  document.getElementById('mode-auto').onclick = () => setSkipMode('auto');
  document.getElementById('mode-manual').onclick = () => setSkipMode('manual');

  // Save button
  document.getElementById('save-btn').onclick = saveSettings;
});

function updateSkipModeUI(mode) {
  const autoBtn = document.getElementById('mode-auto');
  const manualBtn = document.getElementById('mode-manual');

  if (mode === 'auto') {
    autoBtn.classList.add('active');
    manualBtn.classList.remove('active');
  } else {
    autoBtn.classList.remove('active');
    manualBtn.classList.add('active');
  }
}

function setSkipMode(mode) {
  chrome.storage.local.set({ skip_mode: mode }, () => {
    updateSkipModeUI(mode);
  });
}

function saveSettings() {
  const skipTypes = [];
  if (document.getElementById('type-hard').checked) skipTypes.push('hard_ad');
  if (document.getElementById('type-soft').checked) skipTypes.push('soft_ad');
  if (document.getElementById('type-placement').checked) skipTypes.push('product_placement');
  if (document.getElementById('type-intro').checked) skipTypes.push('intro_ad');
  if (document.getElementById('type-mid').checked) skipTypes.push('mid_ad');

  chrome.storage.local.set({ skip_types: skipTypes }, () => {
    const btn = document.getElementById('save-btn');
    btn.textContent = '✓ 已保存';
    setTimeout(() => btn.textContent = '保存设置', 1500);
  });
}
