const path=require('path');
require('dotenv').config({path:path.join(__dirname,'.env')});
require('dotenv').config({path:path.join(__dirname,'../.env')});
const express=require('express');
const cors=require('cors');
const http=require('http');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const config=require('./config');
const db=require('./database/db');
const {authenticateToken}=require('./middlewares/auth');
const {ApiError,requestContext,errorHandler,asyncRoute}=require('./middlewares/errors');
const {text}=require('./middlewares/validation');
const telemetry=require('./services/telemetry');
const tasks=require('./services/taskStore');
require('./utils/safeLogger').install();
const ProgressWebSocketServer=require('./websocket');
function createServer(options={}) {
  const app=express(),server=http.createServer(app);
  const progressServer=new ProgressWebSocketServer(server);
  // A failed second launch must not interrupt tasks owned by the live server.
  server.once('listening',()=>tasks.recoverInterrupted());
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(cors({origin:config.CORS_ORIGIN==='*'?'*':config.CORS_ORIGIN.split(',').map(s=>s.trim()),exposedHeaders:['X-Request-ID']}));
  app.use(express.json({limit:'256kb'}));
  app.use(telemetry.requests);
  app.get('/api/v1/health',(req,res)=>{
    db.prepare('SELECT 1').get();
    res.json({ok:true,database:'ready',schemaVersion:db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,uptimeSeconds:Math.floor(process.uptime())});
  });
  function credentials(body,register=false) {
    const username=text(body?.username,'username',64);
    if(typeof body?.password!=='string'||Buffer.byteLength(body.password)>72||body.password.length<(register?8:1))throw new ApiError(400,'INVALID_CREDENTIALS','密码长度不合法（注册至少 8 字符，最多 72 字节）');
    return {username,password:body.password};
  }
  app.post('/api/v1/auth/login',asyncRoute(async(req,res)=>{
    const {username,password}=credentials(req.body);
    const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if(!user||!await bcrypt.compare(password,user.password_hash))throw new ApiError(401,'LOGIN_FAILED','用户名或密码错误');
    const points=db.prepare('SELECT * FROM user_points WHERE user_id=?').get(user.id);
    const token=jwt.sign({userId:user.id,username:user.username},config.JWT_SECRET,{expiresIn:'7d',algorithm:'HS256'});
    res.json({token,username:user.username,points:points?.total_points||0,tier:points?.tier||'bronze'});
  }));
  app.post('/api/v1/auth/register',asyncRoute(async(req,res)=>{
    const {username,password}=credentials(req.body,true);
    const hash=await bcrypt.hash(password,10);
    db.transaction(()=>{
      if(db.prepare('SELECT id FROM users WHERE username=?').get(username))throw new ApiError(409,'USERNAME_EXISTS','用户名已存在');
      const id=db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(username,hash).lastInsertRowid;
      db.prepare('INSERT INTO user_points(user_id) VALUES(?)').run(id);
    })();
    res.status(201).json({success:true,message:'注册成功'});
  }));
  app.get('/api/v1/auth/me',authenticateToken,(req,res)=>{
    const points=db.prepare('SELECT * FROM user_points WHERE user_id=?').get(req.user.userId);
    res.json({username:req.user.username,userId:req.user.userId,points:points?.total_points||0,tier:points?.tier||'bronze'});
  });
  app.use('/api/v1/model-config',require('./routes/modelConfig'));
  app.use('/api/v1/stats',require('./routes/stats'));
  app.use('/api/v1/segments',require('./routes/segments'));
  app.get('/api/v1/video-view',(req,res,next)=>{
    req.url='/video-view'+(req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'');
    require('./routes/segments')(req,res,next);
  });
  const analysis=require('./routes/videoAnalysis')(progressServer,options);
  app.use('/video-analysis',analysis);
  app.use('/api/v1/video-analysis',analysis);
  app.use('/api/v1/search',options.searchRouter||require('./routes/search'));
  app.use((req,res,next)=>next(new ApiError(404,'NOT_FOUND','接口不存在')));
  app.use(errorHandler);
  server.on('close',()=>progressServer.close());
  return {app,server,progressServer};
}
if(require.main===module){
  const {server,progressServer}=createServer();
  server.on('error',error=>{
    console.error(JSON.stringify({event:'startup_failed',code:error.code==='EADDRINUSE'?'PORT_IN_USE':'STARTUP_FAILED',port:config.PORT}));
    progressServer.close();process.exitCode=1;
  });
  server.listen(config.PORT,config.HOST,()=>console.log(`[Server] http://${config.HOST}:${server.address().port}`));
  function shutdown(){progressServer.close();server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
module.exports={createServer};
