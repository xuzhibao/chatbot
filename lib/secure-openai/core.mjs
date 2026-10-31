/**
 * Optional OpenAI-compatible API on the server.
 * Upstream URL is fixed; headers, endpoints and models are strictly controlled.
 */
import { createHash, timingSafeEqual } from "node:crypto";
const ORIGIN="https://api.openai.com";
const endpoints=Object.freeze({
  "chat/completions":{method:"POST",url:"/v1/chat/completions",bytes:384*1024},
  "responses":{method:"POST",url:"/v1/responses",bytes:384*1024},
  "images/generations":{method:"POST",url:"/v1/images/generations",bytes:32*1024},
  "images/edits":{method:"POST",url:"/v1/images/edits",bytes:3500000},
  "models":{method:"GET",url:null,bytes:0},
});
const modelRe=/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const sha=s=>createHash("sha256").update(s).digest();
function responseHeaders(cors={},extra={}){return {"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",...cors,...extra}}
const fail=(status,code,cors={})=>Response.json({error:{message:code,type:"gateway_error",code}},{status,headers:responseHeaders(cors)});
const inputError=(status,code)=>Object.assign(new Error(code),{status,code});
function environment(env){
  if(env.OAI_GATEWAY_ENABLED!=="1")return null;
  const upstream=env.OPENAI_API_KEY||"";
  const keys=(env.OAI_GATEWAY_KEYS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const models=(env.OAI_GATEWAY_MODELS||"").split(",").map(s=>s.trim()).filter(Boolean);
  if(upstream.length<24||keys.length===0||keys.length>16||keys.includes(upstream)||
     keys.some(s=>s.length<32||s.length>512)||models.length===0||models.length>50||
     models.some(s=>!modelRe.test(s)))return null;
  return {upstream,keys,models:new Set(models)};
}
function authenticate(request,keys){
  const match=/^Bearer ([^\s]{32,512})$/.exec(request.headers.get("authorization")||"");
  if(!match)return null;
  const proposed=sha(match[1]);let found=0;
  for(const secret of keys)found|=Number(timingSafeEqual(proposed,sha(secret)));
  return found?proposed.toString("hex"):null;
}
function corsFor(request,env){
  const origin=request.headers.get("origin");
  if(!origin)return {valid:true,headers:{}};
  const allow=(env.OAI_GATEWAY_ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean);
  if(!origin.startsWith("https://")||origin.includes("*")||!allow.includes(origin))return {valid:false,headers:{}};
  return {valid:true,headers:{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization, content-type",
    "Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Max-Age":"600","Vary":"Origin"}};
}
export function handlePreflight(request,env=process.env){
  const cors=corsFor(request,env);
  return cors.valid&&Object.keys(cors.headers).length>0
    ?new Response(null,{status:204,headers:responseHeaders(cors.headers)})
    :new Response(null,{status:403,headers:responseHeaders()});
}
export async function readLimited(request,max){
  const len=request.headers.get("content-length");
  if(len!==null&&(!/^\d+$/.test(len)||Number(len)>max))throw inputError(413,"payload_too_large");
  if(!request.body)throw inputError(400,"empty_body");
  const reader=request.body.getReader();const chunks=[];let count=0;
  try{for(;;){
    const {done,value}=await reader.read();if(done)break;count+=value.byteLength;
    if(count>max){await reader.cancel().catch(()=>{});throw inputError(413,"payload_too_large")}
    chunks.push(value);
  }}finally{reader.releaseLock()}
  const result=new Uint8Array(count);let p=0;
  for(const part of chunks){result.set(part,p);p+=part.byteLength}
  return result;
}
function allowed(model,models){
  if(typeof model!=="string"||!models.has(model))throw inputError(400,"model_not_allowed");
}
function jsonBody(bytes,kind,models){
  let data;
  try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
  catch{throw inputError(400,"invalid_json")}
  if(!data||Array.isArray(data)||typeof data!=="object")throw inputError(400,"invalid_json");
  allowed(data.model,models);
  if(kind==="chat/completions"){
    if(!Array.isArray(data.messages)||data.messages.length<1)throw inputError(400,"invalid_messages");
    const tokens=data.max_completion_tokens??data.max_tokens??4096;
    if(!Number.isInteger(tokens)||tokens<1||tokens>8192)throw inputError(400,"token_limit");
    if(data.max_completion_tokens===undefined&&data.max_tokens===undefined)data.max_completion_tokens=4096;
    data.store=false;
  }else if(kind==="responses"){
    if(data.input===undefined)throw inputError(400,"invalid_input");
    const tokens=data.max_output_tokens??4096;
    if(!Number.isInteger(tokens)||tokens<1||tokens>8192)throw inputError(400,"token_limit");
    data.max_output_tokens=tokens;data.store=false;
  }else{
    if(typeof data.prompt!=="string"||!data.prompt.trim()||data.prompt.length>16000)throw inputError(400,"invalid_prompt");
    if(data.n!==undefined&&data.n!==1)throw inputError(400,"image_count_limit");
    data.n=1;
  }
  return JSON.stringify(data);
}
function realImage(bytes,mime){
  if(mime==="image/png")return bytes.length>8&&[137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x);
  if(mime==="image/jpeg")return bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==="image/webp")return bytes.length>12&&String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP";
  return false;
}
async function imageBody(bytes,mime,models){
  let form;
  try{form=await new Request("https://internal.invalid",{method:"POST",headers:{"content-type":mime},body:bytes}).formData()}
  catch{throw inputError(400,"invalid_multipart")}
  allowed(form.get("model"),models);
  const fields=new Set(["model","prompt","size","quality","background","output_format","n","input_fidelity","moderation","user","mask"]);
  const out=new FormData();let files=0,images=0;
  for(const [name,value] of form.entries()){
    const image=/^image(\[(\d+)?\])?$/.test(name);
    if(!image&&!fields.has(name))throw inputError(400,"invalid_field");
    if(typeof value==="string"){
      if(image||name==="mask"||value.length>16000)throw inputError(400,"invalid_field");
      if(name==="n"&&value!=="1")throw inputError(400,"image_count_limit");
      out.append(name,value);
    }else{
      if(!image&&name!=="mask")throw inputError(400,"invalid_file");
      files++;if(image)images++;
      if(files>4||value.size===0||value.size>3000000)throw inputError(413,"file_size_limit");
      const raw=new Uint8Array(await value.arrayBuffer());
      if(!realImage(raw,value.type))throw inputError(400,"invalid_image_type");
      out.append(name,new Blob([raw],{type:value.type}),"upload."+value.type.split("/")[1]);
    }
  }
  if(images<1||typeof form.get("prompt")!=="string"||!String(form.get("prompt")).trim())throw inputError(400,"image_required");
  return out;
}
/**
 * quota(keyHash, endpoint) must enforce distributed request quotas and reject
 * on Redis errors. Injection is solely to enable deterministic unit tests.
 */
/** @param {Request} request @param {string} kind @param {{quota?: (hash: string, kind: string) => Promise<boolean>, env?: NodeJS.ProcessEnv, fetchUpstream?: typeof fetch}} [options] */
export async function handleGateway(request,kind,{quota,env=process.env,fetchUpstream=fetch}={}){
  const endpoint=endpoints[kind];if(!endpoint)return fail(404,"not_found");
  if(request.method==="OPTIONS")return handlePreflight(request,env);
  if(request.method!==endpoint.method)return fail(405,"method_not_allowed");
  const cors=corsFor(request,env);
  if(!cors.valid)return fail(403,"origin_not_allowed");
  const headers=cors.headers;
  const cfg=environment(env);if(!cfg)return fail(503,"gateway_unavailable",headers);
  const hash=authenticate(request,cfg.keys);if(!hash)return fail(401,"invalid_api_key",headers);
  if(typeof quota!=="function")return fail(503,"quota_unavailable",headers);
  try{if(!(await quota(hash,kind)))return fail(429,"rate_limit_exceeded",headers)}
  catch{return fail(503,"quota_unavailable",headers)}
  if(kind==="models")return Response.json({object:"list",data:[...cfg.models].map(id=>({id,object:"model",created:0,owned_by:"gateway"}))},
    {headers:responseHeaders(headers)});
  const type=request.headers.get("content-type")||"";
  if(kind==="images/edits"?!/^multipart\/form-data;\s*boundary=/i.test(type):!/^application\/json(?:\s*;|$)/i.test(type))
    return fail(415,"content_type_not_supported",headers);
  let body;
  try{const data=await readLimited(request,endpoint.bytes);
    body=kind==="images/edits"?await imageBody(data,type,cfg.models):jsonBody(data,kind,cfg.models);
  }catch(error){return fail(Number.isInteger(error?.status)?error.status:400,typeof error?.code==="string"?error.code:"invalid_request",headers)}
  const outgoingHeaders=new Headers({authorization:"Bearer "+cfg.upstream});
  if(typeof body==="string")outgoingHeaders.set("content-type","application/json");
  const timeout=kind.startsWith("images/")?285000:115000;
  try{
    const upstream=await fetchUpstream(ORIGIN+endpoint.url,{method:"POST",headers:outgoingHeaders,body,
      redirect:"error",cache:"no-store",signal:AbortSignal.any([request.signal,AbortSignal.timeout(timeout)])});
    if(!upstream.ok){
      await upstream.body?.cancel().catch(()=>{});
      return fail(upstream.status===429?429:upstream.status>=500?502:400,"upstream_error",headers);
    }
    const replyType=upstream.headers.get("content-type")||"";
    if(!/^(application\/json|text\/event-stream|image\/(png|jpeg|webp))\b/i.test(replyType)){
      await upstream.body?.cancel().catch(()=>{});return fail(502,"upstream_type",headers);
    }
    return new Response(upstream.body,{status:200,headers:responseHeaders(headers,{"Content-Type":replyType,
      ...(replyType.startsWith("text/event-stream")?{"X-Accel-Buffering":"no"}:{})})});
  }catch{return fail(502,"upstream_unavailable",headers)}
}