/**
 * 视频分析API路由
 * 提供视频分析相关的API接口
 */

const express = require('express');
const router = express.Router();
const VideoAnalyzer = require('../services/videoAnalyzer');
const { authenticateToken } = require('../middlewares/auth.js');

// 创建视频分析器实例
const videoAnalyzer = new VideoAnalyzer();

/**
 * POST /api/v1/video-analysis/analyze
 * 分析单个视频
 */
router.post('/analyze', authenticateToken, async (req, res) => {
  try {
    const { bvid } = req.body;

    if (!bvid) {
      return res.status(400).json({ error: '缺少bvid参数' });
    }

    console.log(`[API] 开始分析视频: ${bvid}`);

    // 构建B站视频URL
    const videoUrl = `https://www.bilibili.com/video/${bvid}`;

    // 调用新的 VideoAnalyzer
    const result = await videoAnalyzer.analyzeVideo(videoUrl, true);

    // 转换数据格式以适配前端
    const adaptedData = {
      bvid: result.bvid,
      title: result.analysis.title,
      tags: result.analysis.tags,
      summary: result.analysis.summary,
      transcript: result.analysis.transcript,
      // 将 segments 映射为 ad_segments
      ad_segments: result.analysis.segments ? result.analysis.segments.map(seg => ({
        start_time: parseTimeToSeconds(seg.start_time),
        end_time: parseTimeToSeconds(seg.end_time),
        description: seg.description,
        highlight: seg.highlight,
        ad_type: seg.highlight ? 'hard_ad' : 'soft_ad' // 根据 highlight 判断广告类型
      })) : [],
      knowledge_points: result.analysis.knowledge_points || [],
      hot_words: result.analysis.hot_words || [],
      analyzed_at: result.analyzed_at
    };

    res.json({
      success: true,
      data: adaptedData
    });
  } catch (error) {
    console.error('[API] 视频分析失败:', error);
    res.status(500).json({
      error: '视频分析失败',
      message: error.message
    });
  }
});

/**
 * 将时间格式 MM:SS 转换为秒数
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  if (typeof timeStr === 'number') return timeStr;

  const parts = timeStr.split(':');
  if (parts.length === 2) {
    const mins = parseInt(parts[0]);
    const secs = parseInt(parts[1]);
    return mins * 60 + secs;
  }
  return 0;
}

/**
 * POST /api/v1/video-analysis/batch
 * 批量分析视频
 */
router.post('/batch', authenticateToken, async (req, res) => {
  try {
    const { videos } = req.body;

    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'videos参数必须是非空数组' });
    }

    console.log(`[API] 开始批量分析 ${videos.length} 个视频`);

    const results = [];
    for (const video of videos) {
      try {
        const videoUrl = `https://www.bilibili.com/video/${video.bvid}`;
        const result = await videoAnalyzer.analyzeVideo(videoUrl, true);

        // 转换数据格式
        const adaptedData = {
          bvid: result.bvid,
          title: result.analysis.title,
          tags: result.analysis.tags,
          summary: result.analysis.summary,
          ad_segments: result.analysis.segments ? result.analysis.segments.map(seg => ({
            start_time: parseTimeToSeconds(seg.start_time),
            end_time: parseTimeToSeconds(seg.end_time),
            description: seg.description,
            highlight: seg.highlight,
            ad_type: seg.highlight ? 'hard_ad' : 'soft_ad'
          })) : [],
          knowledge_points: result.analysis.knowledge_points || [],
          hot_words: result.analysis.hot_words || []
        };

        results.push({ success: true, data: adaptedData });
      } catch (error) {
        results.push({ bvid: video.bvid, success: false, error: error.message });
      }
    }

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error('[API] 批量分析失败:', error);
    res.status(500).json({
      error: '批量分析失败',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/video-analysis/status/:bvid
 * 获取视频分析状态（如果实现了任务队列）
 */
router.get('/status/:bvid', authenticateToken, (req, res) => {
  // TODO: 实现任务状态查询
  res.json({
    status: 'not_implemented',
    message: '任务状态查询功能待实现'
  });
});

/**
 * POST /api/v1/video-analysis/extract-keyframes
 * 提取视频关键帧
 */
router.post('/extract-keyframes', authenticateToken, async (req, res) => {
  try {
    const { bvid, cid, interval = 10 } = req.body;

    if (!bvid) {
      return res.status(400).json({ error: '缺少bvid参数' });
    }

    // TODO: 实现关键帧提取功能
    res.json({
      success: true,
      message: '关键帧提取功能待实现',
      data: {
        bvid,
        interval,
        keyframes: []
      }
    });
  } catch (error) {
    console.error('[API] 关键帧提取失败:', error);
    res.status(500).json({
      error: '关键帧提取失败',
      message: error.message
    });
  }
});

/**
 * 将时间格式 MM:SS 转换为秒数
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  if (typeof timeStr === 'number') return timeStr;

  const parts = timeStr.split(':');
  if (parts.length === 2) {
    const mins = parseInt(parts[0]);
    const secs = parseInt(parts[1]);
    return mins * 60 + secs;
  }
  return 0;
}

module.exports = router;
