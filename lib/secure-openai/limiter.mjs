import { createClient } from "redis";
let connected;
async function client() {
  if (!process.env.REDIS_URL) throw new Error("Redis unavailable");
  if (!connected) {
    const c=createClient({url:process.env.REDIS_URL,socket:{connectTimeout:3000,reconnectStrategy:false}});
    c.on("error",()=>{});
    connected=c.connect().then(()=>c).catch(e=>{connected=undefined;throw e});
  }
  const c=await connected;
  if(!c.isReady){connected=undefined;throw new Error("Redis unavailable")}
  return c;
}
export async function enforceGatewayQuota(hash,kind){
  if(!/^[0-9a-f]{64}$/.test(hash))throw new Error("Invalid identifier");
  const c=await client(),minute=Math.floor(Date.now()/60000),day=Math.floor(Date.now()/86400000);
  const entries=[
    {key:"oai:"+hash+":minute:"+minute,max:10,ttl:120},
    {key:"oai:"+hash+":day:"+day,max:100,ttl:172800},
    {key:"oai:global:day:"+day,max:300,ttl:172800},
  ];
  if(kind.startsWith("images/"))entries.push({key:"oai:images:day:"+day,max:20,ttl:172800});
  const tx=c.multi();
  for(const e of entries){tx.incr(e.key);tx.expire(e.key,e.ttl,"NX")}
  const result=await tx.exec();
  if(!Array.isArray(result)||result.length!==entries.length*2)throw new Error("Quota unavailable");
  return entries.every((e,i)=>typeof result[i*2]==="number"&&result[i*2]<=e.max);
}