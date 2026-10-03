const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function searchHarness(initialToken,status=200){
 let token=initialToken,listener,mount,unmount,nextTimer=0;
 const requests=[],timers=new Map();
 const source=fs.readFileSync(path.join(__dirname,'sidebar/components/SemanticSearch.vue'),'utf8')
   .split('<script setup>')[1].split('</script>')[0].replace(/import .*? from 'vue';/,'');
 const context={ref:value=>({value}),computed:fn=>({get value(){return fn();}}),
  defineProps:()=>({bvid:'BV1234567890'}),defineEmits:()=>()=>{},
  onMounted:fn=>mount=fn,onUnmounted:fn=>unmount=fn,watch:()=>{},
  window:{API_BASE:'http://localhost:8080/api/v1'},URL,
  chrome:{storage:{local:{get(keys,callback){callback({adskipper_token:token});}},onChanged:{addListener(fn){listener=fn;},removeListener(fn){if(listener===fn)listener=null;}}}},
  setInterval:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearInterval:id=>timers.delete(id),
  console:{error(){}},async fetch(url,options){requests.push({url,options});return {status,ok:status===200,async json(){return {status:'pending',frames:[]};}}}
 };
 vm.createContext(context);vm.runInContext(source+'\nglobalThis.api={pollVectorProgress,fetchFramesList,searchError};',context);
 return {requests,timers,api:context.api,mount:()=>mount(),unmount:()=>unmount(),change(value){token=value;listener?.({adskipper_token:{newValue:value}},'local');},hasListener:()=>!!listener};
}
test('signed-out search does not send API requests or keep a polling timer',async()=>{
 const h=searchHarness();h.mount();await flush();
 assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);assert.match(h.api.searchError.value,/登录/);
});
test('search attaches login token, stops on 401 and does not retry rejected token',async()=>{
 const h=searchHarness('stale-token',401);h.mount();await flush();
 assert.ok(h.requests.length>0);assert.ok(h.requests.every(r=>r.options.headers.Authorization==='Bearer stale-token'));
 assert.equal(h.timers.size,0);
 const count=h.requests.length;await h.api.pollVectorProgress();await h.api.fetchFramesList();assert.equal(h.requests.length,count);
});
test('login resumes status polling and logout/unmount stops it',async()=>{
 const h=searchHarness();h.mount();await flush();h.change('new-token');await flush();
 assert.ok(h.requests.some(r=>r.url.includes('/status?')&&r.options.headers.Authorization==='Bearer new-token'));
 assert.equal(h.timers.size,1);h.change(undefined);assert.equal(h.timers.size,0);
 h.unmount();assert.equal(h.hasListener(),false);
});
test('segment loading skips anonymous requests and includes token when signed in',async()=>{
 const text=fs.readFileSync(path.join(__dirname,'content/main.js'),'utf8');
 const method=text.slice(text.indexOf('    async loadSegments(bvid) {'),text.indexOf('    normalizeSegment(',text.indexOf('    async loadSegments(bvid) {')));
 const requests=[];
 const context={sidebarState:null,API_BASE:'http://localhost:8080/api/v1',console:{error(){}},chrome:{storage:{local:{get(keys,callback){callback({});}}}}};
 vm.createContext(context);vm.runInContext('globalThis.Core=class {'+method+'}',context);
 const core=new context.Core();core.getPage=()=>1;core.getToken=async()=>undefined;
 core.safeFetch=async(url,options)=>{requests.push({url,options});return {ok:false,status:418};};
 await core.loadSegments('BV1234567890');assert.equal(requests.length,0);
 core.getToken=async()=>'session-token';await core.loadSegments('BV1234567890');
 assert.equal(requests.length,1);assert.equal(requests[0].options.headers.Authorization,'Bearer session-token');
});
