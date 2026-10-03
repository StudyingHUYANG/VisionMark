const router=require('express').Router();
const db=require('../database/db');
const {authenticateToken}=require('../middlewares/auth');
const {ApiError}=require('../middlewares/errors');
const {integer}=require('../middlewares/validation');
router.use(authenticateToken);
router.get('/overview',(req,res)=>res.json({code:200,msg:'success',data:{
  total_users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  total_annotations:db.prepare('SELECT COUNT(*) AS n FROM annotations').get().n,total_votes:0
}}));
router.get('/technical',(req,res)=>{
  const hours=integer(req.query.hours,'hours',24,720),userId=req.user.userId;
  const since=new Date(Date.now()-hours*3600000).toISOString();
  const tasks=db.prepare(`SELECT status,COUNT(*) AS count,AVG(duration_ms) AS avg_duration_ms,MAX(duration_ms) AS max_duration_ms FROM analysis_tasks WHERE user_id=? AND started_at>=? GROUP BY status`).all(userId,since);
  const stages=db.prepare(`SELECT s.stage,COUNT(*) AS count,AVG(s.duration_ms) AS avg_duration_ms,MAX(s.duration_ms) AS max_duration_ms FROM analysis_stages s JOIN analysis_tasks t ON t.id=s.task_id WHERE t.user_id=? AND t.started_at>=? GROUP BY s.stage`).all(userId,since);
  const failures=db.prepare(`SELECT error_code AS code,COUNT(*) AS count FROM analysis_tasks WHERE user_id=? AND started_at>=? AND error_code IS NOT NULL GROUP BY error_code`).all(userId,since);
  const models=db.prepare(`SELECT model,operation,status,error_code,COUNT(*) AS count,AVG(duration_ms) AS avg_duration_ms,MAX(duration_ms) AS max_duration_ms FROM model_calls WHERE user_id=? AND created_at>=? GROUP BY model,operation,status,error_code`).all(userId,since.replace('T',' ').slice(0,19));
  const requests=db.prepare(`SELECT route,method,status,SUM(count) AS count,SUM(total_ms)/SUM(count) AS avg_latency_ms,MAX(max_ms) AS max_latency_ms FROM request_metrics WHERE user_id=? AND bucket>=? GROUP BY route,method,status`).all(userId,since.slice(0,13));
  res.json({success:true,data:{scope:'current_user',hours,tasks,stages,failures,models,requests,queryLatency:requests.filter(r=>r.route.startsWith('/api/v1/search/'))}});
});
router.get('/user/contributions',(req,res)=>{
  if(req.query.user_id!==undefined&&Number(req.query.user_id)!==req.user.userId)throw new ApiError(403,'FORBIDDEN','只能查询自己的贡献');
  const page=integer(req.query.page,'page',1,100000),pageSize=integer(req.query.page_size,'page_size',10);
  const list=db.prepare(`SELECT a.id,v.bvid,a.annotation_type,a.created_at,a.content_json FROM annotations a JOIN videos v ON v.id=a.video_id WHERE a.submitter_id=? ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(req.user.userId,pageSize,(page-1)*pageSize);
  const total=db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE submitter_id=?').get(req.user.userId).n;
  res.json({code:200,msg:'success',data:{list,page,page_size:pageSize,total}});
});
router.get('/popular-videos',(req,res)=>res.json({code:200,msg:'success',data:db.prepare(`SELECT v.bvid,COUNT(a.id) AS annotation_count FROM videos v LEFT JOIN annotations a ON a.video_id=v.id GROUP BY v.bvid ORDER BY annotation_count DESC LIMIT 20`).all()}));
router.get('/top-users',(req,res)=>res.json({code:200,msg:'success',data:db.prepare('SELECT u.id,u.username,p.total_points FROM users u JOIN user_points p ON p.user_id=u.id ORDER BY p.total_points DESC LIMIT 10').all()}));
module.exports=router;
