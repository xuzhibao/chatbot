"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
export default function ImageStudio(){
  const [model,setModel]=useState(""),[prompt,setPrompt]=useState(""),[image,setImage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{fetch("/api/secure-image",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("Not signed in");return r.json()}).then(d=>setModel(d.model||"")).catch(()=>setError("Please sign in"))},[]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!prompt.trim())return;
    setBusy(true);setError("");setImage("");
    try{
      const r=await fetch("/api/secure-image",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({prompt})});
      if(!r.ok)throw Error("Image request failed ("+r.status+")");
      const obj=await r.json();const raw=obj?.data?.[0]?.b64_json;
      if(typeof raw!=="string"||raw.length<100)throw Error("No image returned");
      setImage("data:image/png;base64,"+raw);
    }catch(err){setError(err instanceof Error?err.message:"Request failed")}finally{setBusy(false)}
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-8">
    <nav className="flex justify-between"><h1 className="text-2xl font-semibold">Image Studio</h1><Link href="/" className="underline">Back to chat</Link></nav>
    <p>Server-side image generation; provider credentials are never sent to the browser.</p>
    <p className="text-sm opacity-70">Model: {model||"Unavailable"}</p>
    <form onSubmit={submit} className="space-y-3"><label htmlFor="prompt" className="block">Prompt</label>
      <textarea id="prompt" required maxLength={8000} value={prompt} onChange={e=>setPrompt(e.target.value)} className="min-h-36 w-full rounded-lg border bg-background p-3"/>
      <button type="submit" disabled={busy||!model||!prompt.trim()} className="rounded-lg border px-5 py-2 disabled:opacity-50">{busy?"Generating...":"Generate image"}</button>
    </form>
    {error&&<p role="alert" className="text-red-500">{error}</p>}
    {image&&<img src={image} alt="Generated result" className="w-full rounded-lg"/>}
  </main>;
}