class AnnotationUI {
  constructor(core) {
    this.core = core;
    this.init();
  }
  
  init() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        this.toggle();
      }
    });
  }
  
  toggle() {
    const existing = document.getElementById('adskipper-ui');
    if (existing) { existing.remove(); return; }
    
    const state = this.core.player.getState();
    if (!state.bvid) return alert('未识别到视频');
    
    const div = document.createElement('div');
    div.id = 'adskipper-ui';
    div.innerHTML = \`
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:rgba(30,30,40,0.95);border:1px solid #444;padding:20px;
                  border-radius:8px;z-index:99999;color:#fff;width:300px;font-family:sans-serif;">
        <h3 style="margin:0 0 15px 0;color:#FB7299">标记广告时段</h3>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#aaa">开始: </label>
          <input type="number" id="as-start" value="\${state.currentTime.toFixed(1)}" step="0.1" 
                 style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;color:#aaa">结束: </label>
          <input type="number" id="as-end" value="\${(state.currentTime+30).toFixed(1)}" step="0.1"
                 style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
        </div>
        <div style="margin-bottom:15px">
          <label style="font-size:12px;color:#aaa">类型: </label>
          <select id="as-type" style="width:100%;background:#333;border:1px solid #555;color:#fff;padding:5px">
            <option value="hard_ad">硬广</option>
            <option value="soft_ad">暗广/软广</option>
            <option value="intro_ad">片头广告</option>
          </select>
        </div>
        <button id="as-submit" style="width:100%;background:#FB7299;border:none;color:#fff;padding:10px;border-radius:4px;cursor:pointer">提交 (+10分)</button>
        <button onclick="this.parentElement.parentElement.remove()" style="width:100%;margin-top:8px;background:#444;border:none;color:#fff;padding:8px;border-radius:4px;cursor:pointer">取消</button>
        <div id="as-status" style="margin-top:10px;font-size:12px;text-align:center;color:#aaa"></div>
      </div>
    \`;
    document.body.appendChild(div);
    
    div.querySelector('#as-submit').onclick = async () => {
      const s = parseFloat(div.querySelector('#as-start').value);
      const e = parseFloat(div.querySelector('#as-end').value);
      const t = div.querySelector('#as-type').value;
      const status = div.querySelector('#as-status');
      
      if (e <= s) { status.textContent = '结束时间必须大于开始'; status.style.color='#ff6b6b'; return; }
      
      status.textContent = '提交中...';
      try {
        await this.core.submitAnnotation(s, e, t);
        status.textContent = '✓ 提交成功！';
        status.style.color = '#67c23a';
        setTimeout(() => div.remove(), 1000);
      } catch(err) {
        status.textContent = '✗ ' + err.message;
        status.style.color = '#ff6b6b';
      }
    };
  }
}

setTimeout(() => {
  if (window.adSkipper) new AnnotationUI(window.adSkipper);
}, 2000);