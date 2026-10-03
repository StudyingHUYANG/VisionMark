const express = require('express');
const fs = require('fs');
const { authenticateToken } = require('../middlewares/auth');
const { ApiError, asyncRoute } = require('../middlewares/errors');
const validate = require('../middlewares/validation');
const tasks = require('../services/taskStore');
const { createAnalysisService } = require('../services/analysisService');
function createVideoAnalysisRouter(progressServer = null, options = {}) {
  const router = express.Router();
  const service = createAnalysisService({ ...options, progressServer });
  router.use(authenticateToken);
  function input(req) {
    const bvid = validate.bvid(req.body?.bvid);
    const cookies = req.body.bilibili_cookies;
    if (cookies !== undefined && (typeof cookies !== 'string' || cookies.length > 32768)) throw new ApiError(400,'INVALID_PARAMETER','Cookie 必须为不超过 32768 字符的字符串');
    return { bvid, cookies };
  }
  // Existing clients await the final result. Duplicate requests share one execution.
  router.post('/analyze', asyncRoute(async (req,res) => {
    const {bvid,cookies}=input(req);
    const job=service.start(req.user.userId,bvid,cookies);
    if (!job.promise) throw new ApiError(409,'TASK_RUNNING','任务仍在运行，请查询状态');
    res.json({success:true,taskId:job.task.id,reused:job.reused,data:await job.promise});
  }));
  router.post('/tasks', (req,res) => {
    const {bvid,cookies}=input(req);
    const job=service.start(req.user.userId,bvid,cookies);
    res.status(202).json({success:true,reused:job.reused,data:tasks.publicTask(job.task)});
  });
  router.get('/tasks/:id', (req,res) => {
    const row=tasks.byId(req.user.userId,req.params.id);
    if (!row) throw new ApiError(404,'TASK_NOT_FOUND','任务不存在');
    res.json({success:true,data:{...tasks.publicTask(row),result:row.result_json?JSON.parse(row.result_json):null}});
  });
  router.get('/status/:bvid', (req,res) => {
    const bvid=validate.bvid(req.params.bvid);
    res.json({success:true,data:tasks.publicTask(tasks.latest(req.user.userId,bvid)) || {bvid,status:'idle',stage:'idle',percent:0,message:'等待分析',detail:null,startedAt:null,updatedAt:null,finishedAt:null}});
  });
  router.get('/vector-progress', (req,res) => {
    const row=tasks.latest(req.user.userId,validate.bvid(req.query.bvid));
    res.json(row?.vector_json?JSON.parse(row.vector_json):{status:'idle',percent:0,message:'等待检索索引'});
  });
  router.post('/batch', asyncRoute(async(req,res) => {
    const videos=req.body?.videos;
    if (!Array.isArray(videos)||!videos.length||videos.length>5) throw new ApiError(400,'INVALID_PARAMETER','videos 必须包含 1 至 5 个视频');
    videos.forEach(v=>validate.bvid(v?.bvid));
    const results=[];
    for (const video of videos) {
      try {
        const job=service.start(req.user.userId,video.bvid);
        if (!job.promise) throw new ApiError(409,'TASK_RUNNING','任务运行中');
        results.push({success:true,taskId:job.task.id,data:await job.promise});
      } catch (error) {
        results.push({success:false,bvid:video.bvid,code:error instanceof ApiError?error.code:'ANALYSIS_FAILED',error:error instanceof ApiError?error.message:'视频分析失败'});
      }
    }
    res.json({success:true,data:results});
  }));
  router.get('/segments/:videoId/debug', (req,res) => {
    const bvid=validate.bvid(req.params.videoId);
    if (!tasks.latest(req.user.userId,bvid)) throw new ApiError(404,'TASK_NOT_FOUND','任务不存在');
    const {getLatestDebugArtifact}=require('../services/segmentPipeline/debugArtifactWriter');
    const artifact=getLatestDebugArtifact(bvid);
    if (!artifact) throw new ApiError(404,'ARTIFACT_NOT_FOUND','未找到调试产物');
    const content=artifact.content||{};
    res.json({videoId:bvid,evidence:content.evidence||null,candidateCuts:content.candidateCuts||[],finalSegments:content.finalSegments||[],mode:content.mode||'fallback',confidence:content.confidence||'low'});
  });
  router.get('/material-frames/:bvid/:runId/:fileName', (req,res,next) => {
    validate.bvid(req.params.bvid);
    const {resolveMaterialFramePath}=require('../services/materialExtractionService');
    let file;
    try { file=resolveMaterialFramePath(req.params); } catch { throw new ApiError(400,'INVALID_PARAMETER','代表帧路径不合法'); }
    if (!fs.existsSync(file)) throw new ApiError(404,'FRAME_NOT_FOUND','代表帧不存在或已清理');
    res.setHeader('Cache-Control','private, max-age=86400');
    res.sendFile(file,error=>{if(error)next(error);});
  });
  router.post('/extract-keyframes', (req,res) => {
    validate.bvid(req.body?.bvid);
    throw new ApiError(501,'NOT_IMPLEMENTED','独立关键帧接口尚未实现，请使用视频分析接口');
  });
  return router;
}
module.exports=createVideoAnalysisRouter;
