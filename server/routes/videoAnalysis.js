/**
 * 视频分析API路由
 * 提供视频分析相关的API接口
 */

const express = require('express');
const router = express.Router();
const VideoAnalyzer = require('../services/videoAnalyzer');
const { authenticateToken } = require('../middlewares/auth.js');
const path = require('path');
const Database = require('better-sqlite3');

// 创建视频分析器实例
const videoAnalyzer = new VideoAnalyzer();

// 连接数据库（和server.js保持一致的路径）
const db = new Database(path.join(__dirname, '../database', 'app.db'));
db.pragma('journal_mode = WAL');

/**
 * 将时间格式 MM:SS 或 HH:MM:SS 转换为秒数
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  if (typeof timeStr === 'number') return timeStr;

  // 处理可能包含的中文冒号
  const normalizedTime = timeStr.replace(/：/g, ':');
  const parts = normalizedTime.split(':').map(p => parseFloat(p));
  
  // HH:MM:SS
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  // MM:SS
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  // SS
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

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
 * GET /api/v1/videos/:bvid/details
 * 获取视频详情，包括所有标注信息、标注密度分析和广告类型分布
 */
router.get('/:bvid/details', async (req, res) => {
  try {
    const { bvid } = req.params;

    if (!bvid) {
      return res.status(400).json({ 
        code: 400, 
        msg: 'bvid参数不能为空' 
      });
    }

    // 1. 获取视频基本信息和所有标注
    const videoInfo = db.prepare(`SELECT v.id, v.bvid, v.cid, v.page FROM videos v WHERE v.bvid = ?`).get(bvid);

    if (!videoInfo) {
      return res.status(404).json({ 
        code: 404, 
        msg: '视频不存在' 
      });
    }

    // 获取所有标注信息
    const segments = db.prepare(`
      SELECT 
        s.id,
        s.start_time,
        s.end_time,
        s.ad_type,
        s.contributor_id,
        s.is_active,
        datetime(s.created_at, 'localtime') as created_at,
        u.username as contributor_name,
        up.total_points as contributor_points,
        up.tier as contributor_tier
      FROM ad_segments s
      JOIN videos v ON s.video_id = v.id
      LEFT JOIN users u ON s.contributor_id = u.id
      LEFT JOIN user_points up ON u.id = up.user_id
      WHERE v.bvid = ? AND s.is_active = 1
      ORDER BY s.start_time ASC
    `).all(bvid);

    // 2. 标注密度分析
    const densityAnalysis = analyzeAnnotationDensity(segments);

    // 3. 广告类型分布
    const typeDistribution = db.prepare(`
      SELECT 
        ad_type,
        COUNT(*) as count
      FROM ad_segments s
      JOIN videos v ON s.video_id = v.id
      WHERE v.bvid = ? AND s.is_active = 1 AND s.ad_type IS NOT NULL
      GROUP BY ad_type
      ORDER BY count DESC
    `).all(bvid);

    // 4. 构建响应数据
    const responseData = {
      video_info: {
        bvid: videoInfo.bvid,
        cid: videoInfo.cid,
        page: videoInfo.page,
        total_annotations: segments.length
      },
      annotations: segments.map(seg => ({
        id: seg.id,
        start_time: seg.start_time,
        end_time: seg.end_time,
        duration: seg.end_time - seg.start_time,
        ad_type: seg.ad_type,
        contributor: {
          id: seg.contributor_id,
          username: seg.contributor_name,
          points: seg.contributor_points,
          tier: seg.contributor_tier
        },
        created_at: seg.created_at
      })),
      density_analysis: densityAnalysis,
      type_distribution: typeDistribution.map(item => ({
        ad_type: item.ad_type,
        count: item.count
      }))
    };

    res.status(200).json({
      code: 200,
      msg: 'success',
      data: responseData
    });

  } catch (error) {
    console.error('[API] 获取视频详情失败:', error);
    res.status(500).json({
      code: 500,
      msg: '服务器内部错误',
      error: error.message
    });
  }
});

/**
 * 分析标注密度
 * @param {Array} segments - 标注数组
 * @returns {Object} 密度分析结果
 */
function analyzeAnnotationDensity(segments) {
  if (segments.length === 0) {
    return {
      total_segments: 0,
      density_per_minute: 0,
      peak_density_intervals: [],
      average_segment_duration: 0,
      coverage_percentage: 0
    };
  }

  // 计算视频总时长（基于最后一个标注的结束时间）
  const maxEndTime = Math.max(...segments.map(s => s.end_time));
  const videoDuration = maxEndTime > 0 ? maxEndTime : 600; // 默认10分钟
  
  // 计算平均每分钟标注数量
  const densityPerMinute = (segments.length / videoDuration) * 60;
  
  // 计算平均标注时长
  const totalSegmentDuration = segments.reduce((sum, seg) => sum + (seg.end_time - seg.start_time), 0);
  const averageSegmentDuration = totalSegmentDuration / segments.length;
  
  // 计算覆盖百分比（标注总时长占视频总时长的比例）
  const coveragePercentage = (totalSegmentDuration / videoDuration) * 100;
  
  // 分析密度峰值（每30秒为一个区间）
  const interval = 30; // 30秒区间
  const intervals = Math.ceil(videoDuration / interval);
  const densityIntervals = [];
  
  for (let i = 0; i < intervals; i++) {
    const startTime = i * interval;
    const endTime = (i + 1) * interval;
    const segmentCount = segments.filter(seg => 
      (seg.start_time >= startTime && seg.start_time < endTime) ||
      (seg.end_time > startTime && seg.end_time <= endTime) ||
      (seg.start_time <= startTime && seg.end_time >= endTime)
    ).length;
    
    if (segmentCount > 0) {
      densityIntervals.push({
        start_time: startTime,
        end_time: endTime,
        segment_count: segmentCount,
        density: segmentCount / interval
      });
    }
  }
  
  // 按密度排序，取前3个峰值区间
  const peakDensityIntervals = densityIntervals
    .sort((a, b) => b.density - a.density)
    .slice(0, 3);

  return {
    total_segments: segments.length,
    video_duration: videoDuration,
    density_per_minute: parseFloat(densityPerMinute.toFixed(2)),
    peak_density_intervals: peakDensityIntervals,
    average_segment_duration: parseFloat(averageSegmentDuration.toFixed(2)),
    coverage_percentage: parseFloat(coveragePercentage.toFixed(2))
  };
}

module.exports = router;