const {test,after,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawnSync}=require('child_process');
const {once}=require('events');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'visionmark-backend-'));
process.env.DB_PATH=path.join(dir,'test.db');
process.env.JWT_SECRET='test-secret-only-'.repeat(4);
process.env.QWEN_API_KEY='';
const {createServer}=require('../server');
const db=require('../database/db');
const tasks=require('../services/taskStore');
const telemetry=require('../services/telemetry');
const {redact}=require('../utils/safeLogger');
const WebSocket=require('ws');
const BV='BV1234567890',OTHER='BV0987654321';
let server,progressServer,base,alice,bob,taskId,release,calls=0;
let gate=Promise.resolve();
let fail=false;
let failureError=null;
const analyzerFactory=()=>({async analyzeVideo(url,audio,config,options){
  calls++;
  options.onProgress({stage:'download',percent:25,message:'下载中'});
  await telemetry.modelCall('fake-model','chat.completions',async()=>{});
  await gate;
  if(fail)throw failureError || Object.assign(new Error('Bearer should-never-leak apiKey=private'),{status:429});
  options.onProgress({stage:'model',percent:90,message:'模型完成'});
  options.onVectorProgress(100,'ready','done');
  return {bvid:url.split('/').at(-1),analysis:{title:'测试视频',summary:'摘要',segments:[{start_time:'00:01',end_time:'00:05',description:'片段'}],final_segments:[{start:1,end:5,description:'证据'}]},analyzed_at:new Date().toISOString()};
}});
async function api(url,{token,method='GET',body}={}){
 const response=await fetch(base+url,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json(),requestId:response.headers.get('x-request-id')};
}
async function register(name){
 assert.equal((await api('/api/v1/auth/register',{method:'POST',body:{username:name,password:'test-password'}})).status,201);
 return (await api('/api/v1/auth/login',{method:'POST',body:{username:name,password:'test-password'}})).body.token;
}
async function configure(token){return api('/api/v1/model-config',{token,method:'POST',body:{provider:'qwen',apiKey:'private-test-key',baseUrl:'https://example.invalid/v1',modelName:'fake-model'}});}
before(async()=>{
 ({server,progressServer}=createServer({analyzerFactory}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 base=`http://127.0.0.1:${server.address().port}`;
 alice=await register('alice');bob=await register('bob');
});
after(async()=>{release?.();progressServer.close();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('health, migrations and unified auth/JSON validation',async()=>{
 const health=await api('/api/v1/health');assert.equal(health.body.schemaVersion,2);assert.equal(health.body.database,'ready');
 db.migrate();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,2);
 for(const url of ['/api/v1/segments?bvid='+BV,'/api/v1/stats/overview','/api/v1/model-config','/video-analysis/status/'+BV]){
  const r=await api(url);assert.equal(r.status,401);assert.equal(r.body.code,'AUTH_REQUIRED');assert.equal(r.body.requestId,r.requestId);
 }
 const invalid=await api('/api/v1/segments?bvid=../../bad',{token:alice});assert.equal(invalid.status,400);
 const response=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});
 assert.equal(response.status,400);assert.equal((await response.json()).code,'INVALID_JSON');
 const forged=require('jsonwebtoken').sign({userId:99999},process.env.JWT_SECRET);
 assert.equal((await api('/api/v1/auth/me',{token:forged})).status,401);
});
test('model configuration validation, key redaction and missing-key diagnostics',async()=>{
 const r=await api('/video-analysis/analyze',{token:alice,method:'POST',body:{bvid:BV}});
 assert.equal(r.status,422);assert.equal(r.body.code,'MODEL_NOT_CONFIGURED');assert.equal(calls,0);
 const bad=await api('/api/v1/model-config',{token:alice,method:'POST',body:{apiKey:'private',baseUrl:'file:///tmp/model',modelName:'x'}});assert.equal(bad.status,400);
 assert.equal((await configure(alice)).status,200);await configure(bob);
 const config=await api('/api/v1/model-config',{token:alice});assert.equal(config.body.data.hasApiKey,true);assert.ok(!JSON.stringify(config.body).includes('private-test-key'));
 const mismatch=await api('/api/v1/model-config/test',{token:alice,method:'POST',body:{baseUrl:'https://example.invalid',modelName:'x',useDefaultKey:true}});assert.equal(mismatch.status,400);
});
test('duplicate tasks share execution, progress and task IDs are user isolated',async()=>{
 gate=new Promise(r=>{release=r;});
 const first=await api('/video-analysis/tasks',{token:alice,method:'POST',body:{bvid:BV}});
 assert.equal(first.status,202);taskId=first.body.data.taskId;
 const second=await api('/video-analysis/tasks',{token:alice,method:'POST',body:{bvid:BV}});
 assert.equal(second.body.reused,true);assert.equal(second.body.data.taskId,taskId);assert.equal(calls,1);
 const busy=await api('/video-analysis/tasks',{token:bob,method:'POST',body:{bvid:BV}});assert.equal(busy.status,409);
 assert.equal((await api('/video-analysis/tasks/'+taskId,{token:bob})).status,404);
 assert.equal((await api('/video-analysis/status/'+BV,{token:bob})).body.data.status,'idle');
 assert.equal((await api('/video-analysis/status/'+BV,{token:alice})).body.data.stage,'download');
 release();gate=Promise.resolve();
 for(let i=0;i<50;i++){
  const status=await api('/video-analysis/tasks/'+taskId,{token:alice});
  if(status.body.data.status==='completed'){assert.equal(status.body.data.result.title,'测试视频');return;}
  await new Promise(r=>setTimeout(r,10));
 }
 assert.fail('task did not complete');
});
test('result persistence, batch persistence and legacy segment responses',async()=>{
 const r=await api('/api/v1/segments?bvid='+BV,{token:alice});assert.equal(r.body.ai_title,'测试视频');assert.equal(r.body.segments[0].start_time,1);assert.equal(r.body.final_segments.length,1);
 assert.equal((await api('/api/v1/video-view?bvid='+BV,{token:alice})).body.data.title,'测试视频');
 const batch=await api('/video-analysis/batch',{token:alice,method:'POST',body:{videos:[{bvid:OTHER}]}});assert.equal(batch.body.data[0].success,true);
 assert.equal(tasks.latest(1,OTHER).status,'completed');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE source_type='AI'").get().n,2);
 const bad=await api('/video-analysis/batch',{token:alice,method:'POST',body:{videos:[null]}});assert.equal(bad.status,400);
});
test('annotation validation, deletion permissions and stats use annotations table',async()=>{
 const invalid=await api('/api/v1/segments',{token:alice,method:'POST',body:{bvid:BV,start_time:5,end_time:1}});assert.equal(invalid.status,400);
 const saved=await api('/api/v1/segments',{token:alice,method:'POST',body:{bvid:BV,start_time:5,end_time:8}});assert.equal(saved.status,200);
 assert.equal((await api('/api/v1/segments/'+saved.body.id,{token:bob,method:'DELETE'})).status,403);
 assert.equal((await api('/api/v1/segments/'+saved.body.id,{token:alice,method:'DELETE'})).status,200);
 assert.equal((await api('/api/v1/stats/overview',{token:alice})).body.data.total_annotations,2);
 assert.equal((await api('/api/v1/stats/user/contributions?page=-1',{token:alice})).status,400);
});
test('failure diagnostics, model metrics, query latency and secret scrubbing',async()=>{
 fail=true;const r=await api('/video-analysis/analyze',{token:alice,method:'POST',body:{bvid:BV}});fail=false;
 assert.equal(r.status,502);assert.equal(r.body.code,'UPSTREAM_RATE_LIMITED');assert.ok(!JSON.stringify(r.body).includes('private'));
 await api('/api/v1/search/semantic?bvid=invalid&q=test',{token:alice});
 const stats=await api('/api/v1/stats/technical',{token:alice});
 assert.ok(stats.body.data.models[0].count>=1);assert.ok(stats.body.data.stages.length);assert.equal(stats.body.data.failures[0].code,'UPSTREAM_RATE_LIMITED');assert.ok(stats.body.data.queryLatency.length);
 const other=await api('/api/v1/stats/technical',{token:bob});assert.equal(other.body.data.models.length,0);
 assert.equal(redact({apiKey:'secret',nested:{cookie:'personal'}}).nested.cookie,'[REDACTED]');
 assert.ok(!redact('Bearer abcdef ?token=abcdef').includes('abcdef'));
 assert.ok(!JSON.stringify(redact(new Error('private'))).includes('private'));
 assert.equal(telemetry.classifyError({name:'APIConnectionTimeoutError'}),'UPSTREAM_TIMEOUT');
});
test('WebSocket rejects unauthenticated peers and scopes subscriptions to user and video',async()=>{
 const root=base.replace('http','ws');
 const unauth=new WebSocket(root);const closed=once(unauth,'close');await closed;
 assert.equal(unauth.readyState,WebSocket.CLOSED);
 async function socket(token,bvid){
  const ws=new WebSocket(`${root}/?token=${token}${bvid?'&bvid='+bvid:''}`);
  const messages=[];ws.on('message',m=>messages.push(JSON.parse(m)));await once(ws,'open');
  return {ws,messages};
 }
 const peers=await Promise.all([socket(alice,BV),socket(alice,OTHER),socket(bob,BV),socket(alice)]);
 await new Promise(r=>setTimeout(r,30));peers.forEach(p=>p.messages.length=0);
 progressServer.sendProgressToUser(1,{bvid:BV,status:'running',percent:40,stage:'download'});
 await new Promise(r=>setTimeout(r,30));assert.equal(peers[0].messages.length,1);
 for(const peer of peers.slice(1))assert.equal(peer.messages.length,0);
 peers.forEach(p=>p.ws.terminate());
});
test('migration preserves legacy rows and rolls back a failed upgrade',()=>{
 const Database=require('better-sqlite3');
 const legacy=new Database(':memory:');
 legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL);
 INSERT INTO users VALUES(7,'legacy-user','existing-hash');`);
 db.migrate(legacy);db.migrate(legacy);
 assert.equal(legacy.prepare('SELECT username FROM users WHERE id=7').get().username,'legacy-user');
 assert.equal(legacy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,2);
 legacy.close();
 const broken=new Database(':memory:');
 broken.exec('CREATE TABLE analysis_tasks(id TEXT)');
 assert.throws(()=>db.migrate(broken));
 assert.equal(broken.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,1);
 assert.equal(broken.prepare("SELECT name FROM sqlite_master WHERE name='model_calls'").get(),undefined);
 broken.close();
});
test('model connectivity uses bounded real HTTP calls and records provider failures',async()=>{
 const http=require('http');let rejected=false;
 const upstream=http.createServer((req,res)=>{
  req.resume();res.setHeader('Content-Type','application/json');
  if(rejected){res.statusCode=401;res.end(JSON.stringify({error:{message:'secret-upstream-diagnostic'}}));}
  else res.end(JSON.stringify({choices:[{message:{content:'upstream private content'}}]}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 try{
  const body={apiKey:'test-local-only',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,modelName:'local-test'};
  const ok=await api('/api/v1/model-config/test',{token:alice,method:'POST',body});
  assert.equal(ok.status,200);assert.ok(!JSON.stringify(ok.body).includes('private'));
  rejected=true;
  const bad=await api('/api/v1/model-config/test',{token:alice,method:'POST',body});
  assert.equal(bad.status,502);assert.equal(bad.body.code,'MODEL_AUTH_FAILED');assert.ok(!JSON.stringify(bad.body).includes('secret-upstream'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE model='local-test'").get().n,2);
 }finally{await new Promise(r=>upstream.close(r));}
});
test('indexing lock and recovery keep retries from racing shared index files',()=>{
 const bvid='BV2222222222',task=tasks.claim(1,bvid).task;
 tasks.update(task.id,{status:'completed',stage:'completed',percent:100,message:'done'});
 db.prepare('UPDATE analysis_tasks SET vector_json=? WHERE id=?').run(JSON.stringify({status:'embedding'}),task.id);
 assert.throws(()=>tasks.claim(1,bvid),error=>error.code==='INDEX_BUSY');
 tasks.recoverInterrupted();
 const retry=tasks.claim(1,bvid);assert.equal(retry.reused,false);
 tasks.update(retry.task.id,{status:'failed',stage:'failed',message:'test cleanup'});
});
test('fresh process preserves results and recovers interrupted tasks without duplicate execution',()=>{
 const active=tasks.claim(1,'BV1111111111').task;
 const child=spawnSync(process.execPath,['-e',`
 const {createServer}=require('./server');
 const instance=createServer({searchRouter:require('express').Router()});
 const db=require('./database/db');const tasks=require('./services/taskStore');
 instance.server.listen(0,'127.0.0.1',()=>{
 const row=tasks.byId(1,${JSON.stringify(active.id)});
 if(row.error_code!=='SERVER_RESTARTED'||row.status!=='failed')process.exit(2);
 if(!db.prepare("SELECT id FROM annotations WHERE title='测试视频'").get())process.exit(3);
 if(!db.prepare("SELECT result_json FROM analysis_tasks WHERE status='completed'").get().result_json)process.exit(4);
 instance.progressServer.close();instance.server.close(()=>db.close());
 });
 `],{cwd:path.resolve(__dirname,'..'),env:process.env,encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 assert.equal(tasks.byId(1,active.id).status,'failed');
});

test('startup reports port/config errors and local signing keys survive a new process',()=>{
 const cwd=path.resolve(__dirname,'..');
 const pending=tasks.claim(1,'BV3333333333').task;
 const occupied=spawnSync(process.execPath,['server.js'],{cwd,env:{...process.env,DB_PATH:process.env.DB_PATH,PORT:String(server.address().port),HOST:'127.0.0.1'},encoding:'utf8',timeout:10000});
 assert.equal(tasks.byId(1,pending.id).status,'running');
 tasks.update(pending.id,{status:'failed',stage:'failed',message:'test cleanup'});
 assert.equal(occupied.status,1,occupied.stderr);assert.ok(occupied.stderr.includes('PORT_IN_USE'),occupied.stderr);
 const invalid=spawnSync(process.execPath,['-e',"require('./config')"],{cwd,env:{...process.env,PORT:'invalid'},encoding:'utf8'});
 assert.notEqual(invalid.status,0);assert.ok(invalid.stderr.includes('CONFIG_PORT_INVALID'));
 const env={...process.env,JWT_SECRET:'',NODE_ENV:'development',DB_PATH:path.join(dir,'persistent','local.db')};
 const code="process.stdout.write(require('crypto').createHash('sha256').update(require('./config').JWT_SECRET).digest('hex'))";
 const first=spawnSync(process.execPath,['-e',code],{cwd,env,encoding:'utf8'});
 const second=spawnSync(process.execPath,['-e',code],{cwd,env,encoding:'utf8'});
 assert.equal(first.status,0);assert.equal(second.status,0);assert.equal(first.stdout,second.stdout);
});

test('legacy short JWT secrets fall back locally while production remains strict',()=>{
 const cwd=path.resolve(__dirname,'..');
 const env={...process.env,JWT_SECRET:'legacy-short-key',NODE_ENV:'development',DB_PATH:path.join(dir,'legacy-secret','local.db')};
 const code="const c=require('./config');if(c.JWT_SECRET.length<32||c.JWT_SECRET===process.env.JWT_SECRET)process.exit(2);process.stdout.write(require('crypto').createHash('sha256').update(c.JWT_SECRET).digest('hex'))";
 const first=spawnSync(process.execPath,['-e',code],{cwd,env,encoding:'utf8'});
 const second=spawnSync(process.execPath,['-e',code],{cwd,env,encoding:'utf8'});
 assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);
 assert.equal(first.stdout,second.stdout);assert.ok(!first.stderr.includes(env.JWT_SECRET));
 const unsetMode=spawnSync(process.execPath,['-e',code],{cwd,env:{...env,NODE_ENV:''},encoding:'utf8'});
 assert.equal(unsetMode.status,0);assert.equal(unsetMode.stdout,first.stdout);
 const production=spawnSync(process.execPath,['-e',"require('./config')"],{cwd,env:{...env,NODE_ENV:'production'},encoding:'utf8'});
 assert.notEqual(production.status,0);assert.ok(production.stderr.includes('CONFIG_JWT_SECRET_TOO_SHORT'));
 const valid=spawnSync(process.execPath,['-e',"if(require('./config').JWT_SECRET!==process.env.JWT_SECRET)process.exit(2)"],{cwd,env:{...env,JWT_SECRET:'valid-production-secret-'.repeat(3),NODE_ENV:'production'},encoding:'utf8'});
 assert.equal(valid.status,0);
});

test('wrapped yt-dlp HTTP 412 returns an actionable error and persistent task ID',async()=>{
 fail=true;failureError=new Error('视频下载失败: yt-dlp退出码 1: HTTP Error 412: Precondition Failed private-cookie-value');
 let response;
 try {response=await api('/video-analysis/analyze',{token:alice,method:'POST',body:{bvid:BV}});}
 finally {fail=false;failureError=null;}
 assert.equal(response.status,502);
 assert.equal(response.body.code,'VIDEO_ACCESS_RESTRICTED');
 assert.ok(response.body.message.includes('412'));
 assert.ok(response.body.taskId);
 assert.ok(!JSON.stringify(response.body).includes('private-cookie-value'));
 const persisted=tasks.byId(1,response.body.taskId);
 assert.equal(persisted.error_code,'VIDEO_ACCESS_RESTRICTED');
 assert.equal(persisted.message,response.body.message);
});
