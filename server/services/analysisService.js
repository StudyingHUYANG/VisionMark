const db = require('../database/db');
const tasks = require('./taskStore');
const { ApiError } = require('../middlewares/errors');
const { getLatestEnabledUserModelConfig, buildEffectiveModelConfig } = require('./modelConfigService');
const telemetry = require('./telemetry');
function createAnalysisService({ analyzerFactory, progressServer } = {}) {
  const running = new Map();
  function emit(userId, progress) { progressServer?.sendProgressToUser(userId, progress); }
  function start(userId, bvid, cookies) {
    const userConfig = getLatestEnabledUserModelConfig(userId);
    const runtimeModelConfig = buildEffectiveModelConfig(userConfig);
    if (!runtimeModelConfig.apiKey) throw new ApiError(422, 'MODEL_NOT_CONFIGURED', '请先配置模型 API Key');
    const { task, reused } = tasks.claim(userId,bvid);
    if (reused) return { task, reused, promise: running.get(task.id) };
    const promise = Promise.resolve().then(() => telemetry.context.run({userId,taskId:task.id, secrets:[runtimeModelConfig.apiKey,cookies].filter(Boolean)}, async () => {
      try {
        // Never give the analyzer a raw WebSocket server: only scoped callbacks may publish.
        const analyzer = analyzerFactory ? analyzerFactory() : new (require('./videoAnalyzer'))();
        const result = await analyzer.analyzeVideo(`https://www.bilibili.com/video/${bvid}`,true,userConfig,{
          bilibiliCookies:cookies,
          onProgress: p => emit(userId,tasks.update(task.id,{ stage:p.stage,percent:p.percent,message:p.message })),
          onVectorProgress: (percent,status) => {
            const safeStatus = ['pending','extracting','embedding','committing','ready','failed','running','completed'].includes(status) ? status : 'running';
            db.prepare('UPDATE analysis_tasks SET vector_json=? WHERE id=?').run(JSON.stringify({status:safeStatus,percent:Math.max(0,Math.min(100,Number(percent)||0)),message:safeStatus==='failed'?'索引失败，请重试':safeStatus==='ready'?'检索索引已就绪':'索引处理中'}),task.id);
          }
        });
        if (result.bvid !== bvid || !result.analysis) throw new Error('Invalid analyzer result');
        const adaptedData = persistResult(userId, result, runtimeModelConfig, task.id);
        emit(userId,tasks.publicTask(tasks.byId(userId,task.id)));
        return adaptedData;
      } catch (error) {
        const errorCode = telemetry.classifyError(error);
        const message = require('./downloadErrors').messages[errorCode] || '视频分析失败，请凭 taskId 排查或重试';
        const progress = tasks.update(task.id,{status:'failed',stage:'failed',errorCode,message});
        emit(userId,progress);
        console.error(JSON.stringify({event:'analysis_failed',taskId:task.id,code:errorCode}));
        const failure = new ApiError(502,errorCode,message);
        failure.taskId = task.id;
        throw failure;
      } finally { running.delete(task.id); }
    }));
    running.set(task.id,promise);
    promise.catch(() => {}); // Background tasks must not create unhandled rejections.
    return { task,reused:false,promise };
  }
  return {start,running};
}
function persistResult(userId,result,runtimeModelConfig,taskId) {
    const adaptedData = {
      bvid: result.bvid,
      title: result.analysis.title,
      tags: result.analysis.tags,
      summary: result.analysis.summary,
      transcript: result.analysis.transcript,
      transcript_segments: result.analysis.transcript_segments || [],
      visual_cuts: result.analysis.visual_cuts || [],
      visual_cut_stats: result.analysis.visual_cut_stats || null,
      keyword_cuts: result.analysis.keyword_cuts || [],
      candidateCuts: result.analysis.candidateCuts || [],
      segmentPipeline: result.analysis.segmentPipeline || null,
      segments: result.analysis.final_segments || [],
      material_extraction: result.analysis.material_extraction || null,
      material_clips: result.analysis.material_clips || [],
      // 将 segments 映射为 ad_segments
      ad_segments: result.analysis.segments ? result.analysis.segments.map(seg => ({
        start_time: parseTimeToSeconds(seg.start_time),
        end_time: parseTimeToSeconds(seg.end_time),
        description: seg.description,
        highlight: seg.highlight,
        ad_type: seg.highlight ? 'hard_ad' : 'soft_ad' // 根据 highlight 判断内容类型
      })) : [],
      knowledge_points: result.analysis.knowledge_points || [],
      hot_words: result.analysis.hot_words || [],
      analyzed_at: result.analyzed_at
    };


  db.transaction(() => {
    let video = db.prepare('SELECT id FROM videos WHERE bvid=?').get(result.bvid);
    if (!video) video={id:db.prepare('INSERT INTO videos(bvid) VALUES(?)').run(result.bvid).lastInsertRowid};
    const normalizedContent = {
      meta: {
        bvid: result.bvid,
        title: result.analysis.title || null
    },
      content_analysis: {
        summary: result.analysis.summary || null,
        transcript: result.analysis.transcript || null,
        transcript_segments: result.analysis.transcript_segments || [],
        knowledge_points: result.analysis.knowledge_points || [],
        hot_words: result.analysis.hot_words || [],
        tags: result.analysis.tags || [],
        visual_cuts: result.analysis.visual_cuts || [],
        visual_cut_stats: result.analysis.visual_cut_stats || null,
        keyword_cuts: result.analysis.keyword_cuts || [],
        candidateCuts: result.analysis.candidateCuts || [],
        segmentPipeline: result.analysis.segmentPipeline || null,
        segments: result.analysis.final_segments || [],
        material_extraction: result.analysis.material_extraction || null,
        material_clips: result.analysis.material_clips || [],
        analyzed_at: result.analyzed_at || null,
        ad_segments: result.analysis.segments
          ? result.analysis.segments.map(seg => ({
              start_time: parseTimeToSeconds(seg.start_time),
              end_time: parseTimeToSeconds(seg.end_time),
              ad_type: seg.highlight ? 'hard_ad' : 'soft_ad',
              description: seg.description || null,
              highlight: !!seg.highlight
            }))
          : []
      }
    };

    db.prepare(`
      INSERT INTO annotations (
        video_id,
        source_type,
        submitter_id,
        submitter_name,
        parent_id,
        annotation_type,
        title,
        summary,
        transcript,
        score,
        content_json,
        model_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      video.id,
      'AI',
      userId,
      'AI',
      null,
      'full_analysis',
      adaptedData.title || null,
      adaptedData.summary || null,
      adaptedData.transcript || null,
      null,
      JSON.stringify(normalizedContent),
      runtimeModelConfig.visionModel
    );

    tasks.update(taskId,{status:'completed',stage:'completed',percent:100,message:'分析完成',result:adaptedData});
  })();
  return adaptedData;
}
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


module.exports = { createAnalysisService };
