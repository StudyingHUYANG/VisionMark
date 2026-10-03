const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const worker=fs.readFileSync(path.join(__dirname,'background.js'),'utf8');
const content=fs.readFileSync(path.join(__dirname,'content/utils.js'),'utf8');
const sender={id:'extension-id',url:'https://www.bilibili.com/video/BV1234567890',frameId:0,tab:{id:7}};
function setup({source=sender,fail=false,cookies=[]}={}){
 let handler;const calls=[];
 const chrome={runtime:{id:'extension-id',onMessage:{addListener(fn){handler=fn;}}},cookies:{
  async getAllCookieStores(){return [{id:'incognito-store',tabIds:[7]},{id:'other-store',tabIds:[9]}];},
  async getAll(options){calls.push(options);if(fail)throw new Error('sensitive details');return cookies;}
 }};
 vm.runInNewContext(worker,{chrome,URL});
 const bridge=message=>new Promise(resolve=>handler(message,source,resolve));
 const window={};const logs=[];
 vm.runInNewContext(content,{chrome:{runtime:{sendMessage:bridge}},window,console:{log:(...args)=>logs.push(args)}});
 return {api:window.VisionMarkCookieUtils,bridge,calls,logs,handler};
}
const session={domain:'.bilibili.com',hostOnly:false,path:'/',secure:true,session:true,name:'SESSDATA',value:'fixture-secret'};
test('content script without cookies API gets a login cookie through the worker',async()=>{
 const {api,calls,logs}=setup({cookies:[session]});
 const jar=await api.getBilibiliCookiesForYtDlp();
 assert.ok(jar.includes('.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfixture-secret'));
 assert.equal(calls[0].storeId,'incognito-store');assert.equal(calls[0].domain,'bilibili.com');
 assert.ok(!JSON.stringify(logs).includes('fixture-secret'));
 assert.equal(await api.isUserLoggedInToBilibili(),true);
});
test('worker rejects other extensions, unrelated sites and subframes',async()=>{
 for(const source of [{...sender,id:'other'},{...sender,url:'https://evil.test/video/123'},{...sender,frameId:1},{...sender,tab:{id:undefined}}]){
  const {bridge,calls}=setup({source,cookies:[session]});
  const response=await bridge({type:'VISIONMARK_BILIBILI_COOKIES'});
  assert.equal(response.ok,false);assert.equal(calls.length,0);
 }
});
test('expired, partitioned, unrelated-domain and malformed cookies are excluded',async()=>{
 const {api}=setup({cookies:[session,{...session,name:'old',expirationDate:1},{...session,name:'wrong',domain:'.bilibili.com.evil.test'},{...session,name:'partition',partitionKey:{topLevelSite:'https://elsewhere.test'}},{...session,name:'injection',value:'bad\nvalue'}]});
 const jar=await api.getBilibiliCookiesForYtDlp();
 assert.ok(!/old|wrong|partition|injection/.test(jar));
});
test('missing cookies is distinct from permission or worker failure',async()=>{
 const {api}=setup();assert.equal(await api.getBilibiliCookiesForYtDlp(),null);assert.equal(await api.isUserLoggedInToBilibili(),false);
 await assert.rejects(setup({fail:true}).api.getBilibiliCookiesForYtDlp(),/权限/);
 const window={};vm.runInNewContext(content,{chrome:{runtime:{async sendMessage(){throw new Error('no receiver');}}},window});
 await assert.rejects(window.VisionMarkCookieUtils.getBilibiliCookiesForYtDlp(),/重新加载/);
});
test('manifest registers the worker and cookie host permission',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
 assert.equal(manifest.background.service_worker,'background.js');
 assert.ok(manifest.permissions.includes('cookies'));
 assert.ok(manifest.host_permissions.includes('https://*.bilibili.com/*'));
});
