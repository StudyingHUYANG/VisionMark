const { context } = require('../services/telemetry');
const sensitive = /authorization|cookie|password|api.?key|secret|token|headers|request|response|config/i;
function redact(value, seen = new WeakSet()) {
  if (value instanceof Error) return {name:value.name,code:/^[A-Z_0-9]+$/.test(value.code||'')?value.code:'UPSTREAM_ERROR'};
  if (typeof value === 'string') {
    const secrets=[...(context.getStore()?.secrets||[]), ...Object.entries(process.env).filter(([k])=>sensitive.test(k)).map(([,v])=>v)].filter(v=>typeof v==='string'&&v.length>=4);
    let result=value;
    for(const secret of secrets)result=result.split(secret).join('[REDACTED]');
    return result.replace(/Bearer\s+[^\s"',}]+/gi,'Bearer [REDACTED]')
      .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi,'$1[REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|cookie|authorization|SESSDATA|bili_jct)\s*[:=]\s*)[^\s,;}]+/gi,'$1[REDACTED]');
  }
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return '[Circular]';
  seen.add(value);
  if(Array.isArray(value))return value.map(v=>redact(v,seen));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redact(v,seen)]));
}
let installed=false;
function install(){
  if(installed)return;installed=true;
  for(const method of ['log','warn','error','info','debug']){
    const original=console[method].bind(console);
    console[method]=(...args)=>original(...args.map(arg=>redact(arg)));
  }
}
module.exports={install,redact};
