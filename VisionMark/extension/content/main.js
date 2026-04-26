async requestAnalysis(bvid, token) {
      const url = VIDEO_ANALYSIS_BASE + "/video-analysis/analyze";
      console.log('[AdSkipper] 请求URL:', url);
      
      // 自动获取 Bilibili cookies（如果可用）
      let bilibiliCookies = null;
      try {
        if (window.VisionMarkCookieUtils?.getBilibiliCookiesForYtDlp) {
          bilibiliCookies = await window.VisionMarkCookieUtils.getBilibiliCookiesForYtDlp();
          if (bilibiliCookies) {
            console.log('[AdSkipper] 成功获取 Bilibili cookies，将用于视频下载');
          } else {
            console.log('[AdSkipper] 未获取到 Bilibili cookies，将使用无 cookies 模式');
          }
        }
      } catch (error) {
        console.warn('[AdSkipper] 获取 cookies 时出错:', error.message);
      }

      const requestBody = { bvid };
      if (bilibiliCookies) {
        requestBody.bilibili_cookies = bilibiliCookies;
      }

      console.log('[AdSkipper] 请求体:', JSON.stringify({ bvid })); // 注意：不记录 cookies 内容
      console.log('[AdSkipper] 注意：视频分析无超时限制');

      // 直接使用原生 fetch，不设置超时
      // 视频分析需要很长时间（下载、提取、AI分析），不能有超时限制
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(requestBody)
      });

      console.log('[AdSkipper] 响应状态:', res.status, res.statusText);

      let payload = null;
      try {
        payload = await res.json();
        console.log('[AdSkipper] 响应数据:', payload);
      } catch (error) {
        console.error('[AdSkipper] 解析JSON失败:', error);
        payload = null;
      }

      if (!res.ok) {
        const message = payload?.message || payload?.error || `分析失败（${res.status}）`;
        console.error('[AdSkipper] API错误:', message);
        throw new Error(message);
      }
      return payload;
    }