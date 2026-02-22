const API_BASE = window.LOCAL_CONFIG
  ? window.LOCAL_CONFIG.API_BASE + '/' + window.LOCAL_CONFIG.API_VERSION
  : 'http://localhost:8080/api/v1';

// State
let allSegments = [];
let filteredSegments = [];
let currentPage = 1;
const pageSize = 20;

// Ad type labels
const typeLabels = {
  'hard_ad': '硬广',
  'soft_ad': '软广',
  'product_placement': '植入',
  'intro_ad': '片头',
  'mid_ad': '中段'
};

// Get token
async function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['adskipper_token'], (storage) => {
      resolve(storage.adskipper_token);
    });
  });
}

// Load all segments
async function loadSegments() {
  const token = await getToken();
  if (!token) {
    document.getElementById('segments-body').innerHTML =
      '<tr><td colspan="5" class="empty">请先登录插件</td></tr>';
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/segments/user`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        document.getElementById('segments-body').innerHTML =
          '<tr><td colspan="5" class="empty">后端API暂未实现（需要添加 GET /api/v1/segments/user 接口）</td></tr>';
        return;
      }
      throw new Error('加载失败');
    }

    const data = await response.json();
    allSegments = data.segments || [];
    filterAndRender();
    updateStats();

  } catch (error) {
    console.error('加载失败:', error);
    document.getElementById('segments-body').innerHTML =
      '<tr><td colspan="5" class="empty">加载失败: ' + error.message + '</td></tr>';
  }
}

// Filter and render
function filterAndRender() {
  const search = document.getElementById('search-input').value.toLowerCase();
  filteredSegments = allSegments.filter(seg =>
    seg.bvid && seg.bvid.toLowerCase().includes(search)
  );

  currentPage = 1;
  renderPage();
}

// Render current page
function renderPage() {
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageSegments = filteredSegments.slice(start, end);

  if (pageSegments.length === 0) {
    document.getElementById('segments-body').innerHTML =
      '<tr><td colspan="6" class="empty">暂无标注记录</td></tr>';
    return;
  }

  const html = pageSegments.map(seg => `
    <tr>
      <td><a href="https://www.bilibili.com/video/${seg.bvid}" target="_blank" class="bilibili-link">${seg.bvid}</a></td>
      <td>${seg.start_time.toFixed(1)}s - ${seg.end_time.toFixed(1)}s</td>
      <td><span class="type-badge type-${seg.ad_type.replace('_ad', '').replace('product_', '')}">${typeLabels[seg.ad_type] || seg.ad_type}</span></td>
      <td>${new Date(seg.created_at || Date.now()).toLocaleDateString()}</td>
      <td>
        <button class="btn-jump" onclick="jumpToVideo('${seg.bvid}', ${seg.start_time})">跳转</button>
        <button class="btn-delete" onclick="deleteSegment(${seg.id}, '${seg.bvid}')">删除</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('segments-body').innerHTML = html;
  updatePagination();
}

// Update pagination
function updatePagination() {
  const totalPages = Math.ceil(filteredSegments.length / pageSize);
  document.getElementById('page-info').textContent =
    `第 ${currentPage} / ${totalPages || 1} 页`;
  document.getElementById('prev-btn').disabled = currentPage <= 1;
  document.getElementById('next-btn').disabled = currentPage >= totalPages;
}

// Update stats
function updateStats() {
  document.getElementById('stats').textContent =
    `共 ${allSegments.length} 条标注`;
}

// Delete segment
async function deleteSegment(id, bvid) {
  if (!confirm(`确定要删除视频 ${bvid} 的这条标注吗？`)) return;

  const token = await getToken();
  try {
    const response = await fetch(`${API_BASE}/segments/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) throw new Error('删除失败');

    // Remove from local list
    allSegments = allSegments.filter(seg => seg.id !== id);
    filterAndRender();
    updateStats();

  } catch (error) {
    alert('删除失败: ' + error.message);
  }
}

// Jump to video with timestamp
function jumpToVideo(bvid, startTime) {
  chrome.tabs.create({
    url: `https://www.bilibili.com/video/${bvid}?t=${Math.floor(startTime)}`
  });
}
  if (!confirm(`确定要删除视频 ${bvid} 的这条标注吗？`)) return;

  const token = await getToken();
  try {
    const response = await fetch(`${API_BASE}/segments/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) throw new Error('删除失败');

    // Remove from local list
    allSegments = allSegments.filter(seg => seg.id !== id);
    filterAndRender();
    updateStats();

  } catch (error) {
    alert('删除失败: ' + error.message);
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  loadSegments();

  document.getElementById('search-input').addEventListener('input', filterAndRender);

  document.getElementById('prev-btn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderPage();
    }
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(filteredSegments.length / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      renderPage();
    }
  });
});
