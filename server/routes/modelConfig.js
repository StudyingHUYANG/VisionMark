const router=require('express').Router();
const db=require('../database/db');
const {authenticateToken}=require('../middlewares/auth');
const {ApiError,asyncRoute}=require('../middlewares/errors');
const {text}=require('../middlewares/validation');
const {getModelConfigState,getSystemDefaultModelConfig}=require('../services/modelConfigService');
const telemetry=require('../services/telemetry');
router.use(authenticateToken);
function validate(body) {
  const provider=body.provider===undefined?'qwen':body.provider;
  if(provider!=='qwen')throw new ApiError(400,'UNSUPPORTED_PROVIDER','当前仅支持 qwen');
  const baseUrl=text(body.baseUrl,'baseUrl',2048),modelName=text(body.modelName,'modelName',200);
  let url;
  try{url=new URL(baseUrl);}catch{throw new ApiError(400,'INVALID_MODEL_URL','模型地址必须为 HTTP(S) URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
    throw new ApiError(400,'INVALID_MODEL_URL','模型地址不允许凭据、查询参数或片段');
  if(body.apiKey!==undefined&&(typeof body.apiKey!=='string'||body.apiKey.length>4096))throw new ApiError(400,'INVALID_PARAMETER','apiKey 格式不合法');
  for(const key of ['isEnabled','useDefaultKey'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw new ApiError(400,'INVALID_PARAMETER',`${key} 必须为布尔值`);
  return {provider,baseUrl,modelName,apiKey:body.apiKey?.trim()||'',isEnabled:body.isEnabled!==false};
}
router.get('/',(req,res)=>res.json(getModelConfigState(req.user.userId)));
router.post('/',(req,res)=>{
  const c=validate(req.body),userId=req.user.userId;
  const existing=db.prepare('SELECT api_key FROM user_api_configs WHERE user_id=? AND provider=?').get(userId,c.provider);
  const key=c.apiKey||existing?.api_key;
  if(!key)throw new ApiError(400,'MODEL_KEY_REQUIRED','新建配置时必须提供 apiKey');
  db.prepare(`INSERT INTO user_api_configs(user_id,provider,api_key,base_url,model_name,is_enabled) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,provider) DO UPDATE SET api_key=excluded.api_key,base_url=excluded.base_url,model_name=excluded.model_name,is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
    .run(userId,c.provider,key,c.baseUrl,c.modelName,c.isEnabled?1:0);
  res.json({success:true,message:'配置保存成功'});
});
router.post('/test',asyncRoute(async(req,res)=>{
  const c=validate(req.body),defaults=getSystemDefaultModelConfig();
  const stored=db.prepare('SELECT api_key FROM user_api_configs WHERE user_id=? AND provider=?').get(req.user.userId,c.provider);
  // A system/stored key may only be sent to its configured endpoint.
  let key=c.apiKey;
  if(!key&&req.body.useDefaultKey){
    if(c.baseUrl.replace(/\/$/,'')!==defaults.baseUrl.replace(/\/$/,''))throw new ApiError(400,'MODEL_ENDPOINT_MISMATCH','默认密钥只能用于默认模型地址');
    key=defaults.apiKey;
  }
  if(!key&&stored){
    const saved=db.prepare('SELECT base_url FROM user_api_configs WHERE user_id=? AND provider=?').get(req.user.userId,c.provider);
    if(c.baseUrl!==saved.base_url)throw new ApiError(400,'MODEL_ENDPOINT_MISMATCH','使用已保存密钥时必须保留模型地址');
    key=stored.api_key;
  }
  if(!key)throw new ApiError(422,'MODEL_NOT_CONFIGURED','请先配置模型 API Key');
  await telemetry.context.run({userId:req.user.userId,secrets:[key]},async()=>{
    try{
      const OpenAI=require('openai');
      const client=telemetry.instrumentClient(new OpenAI({apiKey:key,baseURL:c.baseUrl,timeout:15000,maxRetries:0}));
      await client.chat.completions.create({model:c.modelName,messages:[{role:'user',content:'请只回复：连接成功'}],max_tokens:20});
      res.json({success:true,message:'连接成功'});
    }catch(error){throw new ApiError(502,telemetry.classifyError(error),'模型连接失败，请检查地址、模型名和密钥');}
  });
}));
module.exports=router;
