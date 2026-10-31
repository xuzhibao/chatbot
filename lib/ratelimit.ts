import { createHash } from "node:crypto";
import { createClient } from "redis";
import { isProductionEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";
let connected: Promise<ReturnType<typeof createClient>> | undefined;
async function redis() {
  if (!process.env.REDIS_URL) throw new Error("Missing Redis");
  if (!connected) {
    const client=createClient({url:process.env.REDIS_URL,socket:{connectTimeout:3000,reconnectStrategy:false}});
    client.on("error",()=>{});
    connected=client.connect().then(()=>client).catch(e=>{connected=undefined;throw e});
  }
  const client=await connected;
  if(!client.isReady){connected=undefined;throw new Error("Redis unavailable")}
  return client;
}
export async function checkIpRateLimit(ip: string | undefined) {
  if (!isProductionEnvironment) return;
  try{
    const c=await redis(),hour=Math.floor(Date.now()/3600000),day=Math.floor(Date.now()/86400000);
    const entries=[{key:"chat:global:"+day,max:300,ttl:172800}];
    if(ip)entries.push({key:"chat:ip:"+createHash("sha256").update(ip).digest("hex")+":"+hour,max:30,ttl:7200});
    const tx=c.multi();for(const e of entries){tx.incr(e.key);tx.expire(e.key,e.ttl,"NX")}
    const values=await tx.exec();
    if(!Array.isArray(values)||values.length!==entries.length*2||entries.some((e,i)=>typeof values[i*2]!=="number"||values[i*2]>e.max))throw new Error("Exceeded quota");
  }catch{
    throw new ChatbotError("rate_limit:chat");
  }
}
