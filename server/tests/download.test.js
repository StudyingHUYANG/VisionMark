const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {Readable}=require('stream');
const Downloader=require('../services/bilibiliDownloader');
const {apiCookieHeader}=Downloader;
const {downloadError}=require('../services/downloadErrors');
const jar=[
 '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfixture-session',
 '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tfixture-csrf',
 '.bilibili.com.attacker.test\tTRUE\t/\tTRUE\t0\tevil\tvalue',
 '.bilibili.com\tTRUE\t/\tTRUE\t1\texpired\tvalue',
 'www.bilibili.com\tFALSE\t/\tTRUE\t0\twronghost\tvalue',
 '.bilibili.com\tTRUE\t/\tTRUE\t0\tinjected\tvalue;evil=yes'
].join('\n');
function fixture(t,http){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'visionmark-download-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cookies=path.join(dir,'cookies.txt');fs.writeFileSync(cookies,jar);
 return {dir,downloader:new Downloader({downloadDir:dir,cookiesPath:cookies,httpClient:http,sleep:async()=>{}})};
}
test('Netscape parsing forwards only matching, unexpired, safe API cookies',()=>{
 assert.equal(apiCookieHeader(jar),'SESSDATA=fixture-session; bili_jct=fixture-csrf');
});
test('authenticated API and atomic media download keep cookies away from CDN',async t=>{
 const seen=[];
 const {dir,downloader}=fixture(t,{async get(url,options){
  seen.push({url,options});
  if(url.includes('/view'))return {data:{code:0,data:{pages:[{cid:12}]}}};
  if(url.includes('/playurl'))return {data:{code:0,data:{durl:[{url:'https://cdn.example/video'}]}}};
  return {headers:{'content-length':'5'},data:Readable.from([Buffer.from('video')])};
 }});
 const output=await downloader.downloadVideo('https://www.bilibili.com/video/BV1234567890');
 assert.equal(fs.readFileSync(output,'utf8'),'video');assert.ok(!fs.existsSync(output+'.part'));
 assert.equal(seen[0].options.headers.Cookie,'SESSDATA=fixture-session; bili_jct=fixture-csrf');
 assert.equal(seen[1].options.headers.Cookie,seen[0].options.headers.Cookie);
 assert.equal(seen[2].options.headers.Cookie,undefined);
 assert.equal(seen[0].options.maxRedirects,0);
 await downloader.downloadVideo('https://www.bilibili.com/video/BV1234567890');assert.equal(seen.length,3);
});
test('HTTP and API risk denials are classified without automatic retries',async t=>{
 let calls=0;
 const {downloader}=fixture(t,{async get(){calls++;throw {response:{status:412}};}});
 await assert.rejects(downloader.getVideoInfo('BV1234567890'),e=>e.code==='VIDEO_ACCESS_RESTRICTED');assert.equal(calls,1);
 downloader.http={async get(){calls++;return {data:{code:-352}};}};
 await assert.rejects(downloader.getVideoInfo('BV1234567890'),e=>e.code==='VIDEO_ACCESS_RESTRICTED');assert.equal(calls,2);
});
test('transient API transport failures retry only once',async t=>{
 let calls=0;
 const {downloader}=fixture(t,{async get(){calls++;throw {code:'ECONNRESET'};}});
 await assert.rejects(downloader.getVideoInfo('BV1234567890'),e=>e.code==='DOWNLOAD_FAILED');assert.equal(calls,2);
});
test('truncated and broken streams never become completed cache files',async t=>{
 const {dir,downloader}=fixture(t,{async get(){return {headers:{'content-length':'10'},data:Readable.from([Buffer.from('short')])};}});
 const target=path.join(dir,'test.mp4');
 await assert.rejects(downloader.downloadFile('https://cdn.example/video',target));
 assert.ok(!fs.existsSync(target));assert.ok(!fs.existsSync(target+'.part'));
 downloader.http={async get(){return {headers:{},data:Readable.from((async function*(){yield Buffer.from('part');throw new Error('connection closed');})())};}};
 await assert.rejects(downloader.downloadFile('https://cdn.example/video',target));
 assert.ok(!fs.existsSync(target));assert.ok(!fs.existsSync(target+'.part'));
});
test('download errors are safe, actionable, and preserve typed failures',()=>{
 for(const [error,code] of [[{code:'ENOENT'},'DOWNLOAD_DEPENDENCY_MISSING'],[{message:'No module named yt_dlp'},'DOWNLOAD_DEPENDENCY_MISSING'],[{message:'HTTP Error 412: cookie=private'},'VIDEO_ACCESS_RESTRICTED'],[{code:'ETIMEDOUT'},'DOWNLOAD_TIMEOUT'],[{response:{status:403}},'VIDEO_LOGIN_REQUIRED']]){
  const result=downloadError(error);assert.equal(result.code,code);assert.ok(!result.message.includes('private'));assert.equal(downloadError(result),result);
 }
});
