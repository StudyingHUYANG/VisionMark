(function() {
  if (window.adSkipper) return;
  
  class AdSkipperCore {
    constructor() {
      this.player = new BilibiliPlayerController();
      this.segments = [];
      this.lastSkipTime = 0;
      this.cache = new Map();
    }

    async init() {
      console.log('[AdSkipper] 初始化...');
      const ok = await this.player.init();
      if (!ok) return;
      
      this.player.onCidChange = (bvid, cid) => this.loadSegments(bvid, cid);
      this.player.onTimeUpdate = (t) => this.checkSkip(t);
      
      if (this.player.currentBvid) {
        await this.loadSegments(this.player.currentBvid, this.player.currentCid);
      }
      
      window.adSkipper = this;
      this.showToast('广告跳过插件已加载（测试版）', 'info');
    }

    async loadSegments(bvid, cid) {
      if (!bvid || !cid) return;
      const key = `${bvid}-${cid}`;
      
      // 本地缓存
      const cached = localStorage.getItem(`seg_${key}`);
      if (cached) {
        this.segments = JSON.parse(cached);
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/segments?bvid=${bvid}&cid=${cid}`);
        const data = await res.json();
        this.segments = data.segments || [];
        localStorage.setItem(`seg_${key}`, JSON.stringify(this.segments));
        console.log(`[AdSkipper] 加载 ${this.segments.length} 个广告段`);
      } catch(e) {
        console.error('加载失败:', e);
        this.segments = [];
      }
    }

    checkSkip(currentTime) {
      if (!this.segments.length || Date.now() - this.lastSkipTime < 500) return;
      
      const ad = this.segments.find(s => 
        currentTime >= s.start_time && 
        currentTime < s.end_time - 0.5
      );
      
      if (ad) {
        this.player.skipTo(ad.end_time);
        this.lastSkipTime = Date.now();
        const dur = (ad.end_time - ad.start_time).toFixed(1);
        this.showToast(`已跳过 ${dur} 秒广告`, 'success');
        this.reportSkip(ad.id);
      }
    }

    async submitAnnotation(start, end, type) {
      const state = this.player.getState();
      const body = {
        bvid: state.bvid,
        cid: state.cid,
        start_time: start,
        end_time: end,
        ad_type: type
      };
      
      const res = await fetch(`${API_BASE}/segments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      
      if (!res.ok) throw new Error('提交失败');
      
      // 刷新缓存
      localStorage.removeItem(`seg_${state.bvid}-${state.cid}`);
      await this.loadSegments(state.bvid, state.cid);
      return await res.json();
    }

    reportSkip(id) {
      fetch(`${API_BASE}/segments/${id}/skip`, {method: 'POST'}).catch(()=>{});
    }

    showToast(msg, type='info') {
      const t = document.createElement('div');
      t.style.cssText = \`position:fixed;top:80px;left:50%;transform:translateX(-50%);
        background:\${type==='success'?'#67c23a':'#333'};color:#fff;padding:10px 20px;
        border-radius:4px;z-index:99999;font-size:14px;transition:opacity 0.3s;\`;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 3000);
    }
  }

  new AdSkipperCore().init();
})();