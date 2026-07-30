/* ============================================================================
   gdrive-sync.js — Google Drive sync layer for the Section H tools
   Shared by Project_Tracker.html and Part13_Data_Tool_v2.html.

   • Scope: drive.file — the tools can ONLY see files they created themselves.
   • One JSON file per tool, kept in the folder "Section H Tools" in your Drive.
   • Requires https (GitHub Pages). Opened from your hard drive, sync is skipped
     and the tools fall back to local-only storage, exactly as before.
   ========================================================================== */
(function(){
"use strict";
if(window.GSync) return;

const SCOPE="https://www.googleapis.com/auth/drive.file";
const FOLDER="Section H Tools";
let cfg=null, token=null, tokenExp=0, tokenClient=null, waiters=[];
let fileId=null, folderId=null, lastPulled=null, dirty=false, busy=false, timer=null;
let status="off", statusTxt="Drive: not connected";

const lsG=k=>{ try{return localStorage.getItem(k)}catch(e){return null} };
const lsS=(k,v)=>{ try{localStorage.setItem(k,v)}catch(e){} };
function clientId(){ return String(window.GSYNC_CLIENT_ID||lsG("gsync_client_id")||"").trim(); }
function pulledKey(){ return "gsync_pulled_"+cfg.app; }
function httpsOK(){ return location.protocol==="https:"; }

/* ---------------- status bar ---------------- */
function bar(){
  let el=document.getElementById("gsyncBar");
  if(!el){
    el=document.createElement("span"); el.id="gsyncBar";
    el.style.cssText="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#e5e7eb";
    const host=document.querySelector("header")||document.body;
    host.appendChild(el);
  }
  return el;
}
function setStatus(s,t){ status=s; statusTxt=t; paint(); }
function paint(){
  const el=bar(); const dot={off:"#6b7280",err:"#f87171",ok:"#4ade80",busy:"#fbbf24",dirty:"#fb923c"}[status]||"#6b7280";
  const b=(lbl,fn,title)=>'<button onclick="'+fn+'" title="'+(title||"")+'" style="background:#374151;color:#fff;border:1px solid #4b5563;border-radius:6px;padding:4px 8px;font-size:11.5px;cursor:pointer">'+lbl+'</button>';
  let btns="";
  if(!httpsOK()) btns=b("Drive setup","GSync.help()","Sync needs the hosted (https) version");
  else if(!clientId()) btns=b("Set up Drive","GSync.setup()");
  else if(status==="off"||status==="err") btns=b("Connect Drive","GSync.connect()")+b("⚙","GSync.setup()","Change client ID");
  else btns=b("Sync now","GSync.push(true)")+b("⤓ Load Drive","GSync.pull(true)","Replace this device's data with the Drive copy");
  el.innerHTML='<span style="color:'+dot+'">●</span><span>'+statusTxt+'</span>'+btns;
}

/* ---------------- auth ---------------- */
function loadGIS(cb){
  if(window.google&&window.google.accounts&&window.google.accounts.oauth2) return cb();
  const s=document.createElement("script");
  s.src="https://accounts.google.com/gsi/client"; s.async=true;
  s.onload=cb; s.onerror=()=>setStatus("err","Drive: sign-in script blocked");
  document.head.appendChild(s);
}
function withToken(interactive,cb){
  if(token&&Date.now()<tokenExp-60000) return cb(null,token);
  const cid=clientId();
  if(!cid){ setStatus("err","Drive: client ID not set"); return cb("no-client-id"); }
  loadGIS(()=>{
    try{
      if(!tokenClient) tokenClient=google.accounts.oauth2.initTokenClient({client_id:cid,scope:SCOPE,
        callback:r=>{ const w=waiters; waiters=[];
          if(r&&r.access_token){ token=r.access_token; tokenExp=Date.now()+(Number(r.expires_in||3600)*1000); w.forEach(f=>f(null,token)); }
          else { setStatus("err","Drive: sign-in cancelled"); w.forEach(f=>f("auth")); } },
        error_callback:()=>{ const w=waiters; waiters=[]; setStatus("err","Drive: sign-in failed"); w.forEach(f=>f("auth")); }});
      waiters.push(cb);
      tokenClient.requestAccessToken({prompt: interactive?"":"none"});
    }catch(e){ setStatus("err","Drive: "+e.message); cb("init"); }
  });
}

/* ---------------- drive REST ---------------- */
function api(url,opts,cb,retried){
  withToken(false,(e,tk)=>{
    if(e) return cb(e);
    opts=opts||{}; opts.headers=Object.assign({Authorization:"Bearer "+tk},opts.headers||{});
    fetch(url,opts).then(r=>{
      if(r.status===401&&!retried){ token=null; return api(url,opts,cb,true); }
      if(!r.ok) return r.text().then(t=>cb("http "+r.status+" "+t.slice(0,120)));
      const ct=r.headers.get("content-type")||"";
      return (ct.includes("json")? r.json():r.text()).then(d=>cb(null,d));
    }).catch(err=>cb(err.message||"network"));
  });
}
function findFolder(cb){
  if(folderId) return cb(null,folderId);
  const q=encodeURIComponent("name='"+FOLDER+"' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  api("https://www.googleapis.com/drive/v3/files?q="+q+"&fields=files(id)&spaces=drive",null,(e,d)=>{
    if(e) return cb(e);
    if(d.files&&d.files.length){ folderId=d.files[0].id; return cb(null,folderId); }
    api("https://www.googleapis.com/drive/v3/files?fields=id",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name:FOLDER,mimeType:"application/vnd.google-apps.folder"})},(e2,d2)=>{
        if(e2) return cb(e2); folderId=d2.id; cb(null,folderId); });
  });
}
function findFile(cb){
  /* always re-read modifiedTime — a cached id must never let us skip the
     "is the Drive copy newer?" check, or another device's work gets overwritten */
  if(fileId) return meta((e,d)=>{
    if(!e&&d) return cb(null,fileId,d.modifiedTime);
    fileId=null; findFile(cb);            /* file moved/deleted → look again */
  });
  const q=encodeURIComponent("name='"+cfg.fileName+"' and trashed=false");
  api("https://www.googleapis.com/drive/v3/files?q="+q+"&fields=files(id,modifiedTime)&spaces=drive",null,(e,d)=>{
    if(e) return cb(e);
    if(d.files&&d.files.length){ fileId=d.files[0].id; return cb(null,fileId,d.files[0].modifiedTime); }
    cb(null,null);
  });
}
function meta(cb){
  if(!fileId) return cb(null,null);
  api("https://www.googleapis.com/drive/v3/files/"+fileId+"?fields=id,modifiedTime",null,cb);
}
function upload(payload,cb){
  if(fileId){
    return api("https://www.googleapis.com/upload/drive/v3/files/"+fileId+"?uploadType=media&fields=id,modifiedTime",
      {method:"PATCH",headers:{"Content-Type":"application/json"},body:payload},cb);
  }
  findFolder((e,fid)=>{
    if(e) return cb(e);
    const bd="gsyncbd"+Date.now();
    const m=JSON.stringify({name:cfg.fileName,parents:[fid],mimeType:"application/json"});
    const body="--"+bd+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+m
      +"\r\n--"+bd+"\r\nContent-Type: application/json\r\n\r\n"+payload+"\r\n--"+bd+"--";
    api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime",
      {method:"POST",headers:{"Content-Type":"multipart/related; boundary="+bd},body},(e2,d)=>{
        if(e2) return cb(e2); fileId=d.id; cb(null,d); });
  });
}
function download(cb){
  api("https://www.googleapis.com/drive/v3/files/"+fileId+"?alt=media",null,cb);
}

/* ---------------- public API ---------------- */
const GSync={
  init(c){ cfg=c; lastPulled=lsG(pulledKey());
    if(!httpsOK()){ setStatus("off","Local file — Drive sync off"); return; }
    setStatus("off","Drive: not connected"); paint();
    if(clientId()) setTimeout(()=>GSync.pull(false,true),400);   /* silent auto-pull on open */
    window.addEventListener("pagehide",()=>{ if(dirty) GSync.push(true,true); });
    document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden"&&dirty) GSync.push(true,true); });
  },
  touch(){ if(!cfg||!httpsOK()) return; dirty=true;
    if(status==="ok"||status==="dirty"){ setStatus("dirty","Drive: unsaved changes"); }
    clearTimeout(timer); timer=setTimeout(()=>GSync.push(false),4000);
  },
  connect(){ withToken(true,e=>{ if(e) return; setStatus("busy","Drive: connected — checking…"); GSync.pull(false); }); },
  setup(){
    const cur=clientId();
    const v=prompt("Paste your Google OAuth Client ID\n(Google Cloud Console → Credentials → OAuth client ID for Web application).\nSee GOOGLE_DRIVE_SETUP.md for the steps.",cur||"");
    if(v==null) return;
    lsS("gsync_client_id",v.trim()); token=null; tokenClient=null;
    if(v.trim()) GSync.connect(); else setStatus("off","Drive: client ID cleared");
  },
  help(){ alert("Drive sync needs the hosted version of these tools (an https:// address, e.g. your GitHub Pages URL).\n\nOpened straight from your hard drive, the tools still work — they just save locally on this device only."); },
  /* pull: replace local state with the Drive copy. force=true asks first. silent=no error noise */
  pull(force,silent){
    if(busy) return; busy=true;
    if(force&&!confirm("Replace this device's data with the copy in Google Drive?\n\nAnything on this device that hasn't been synced will be lost.")){ busy=false; return; }
    setStatus("busy","Drive: loading…");
    findFile((e,id,mod)=>{
      if(e){ busy=false; return setStatus(silent?"off":"err","Drive: "+(silent?"not connected":e)); }
      if(!id){ busy=false; setStatus("ok","Drive: no file yet — will create on save"); if(dirty) GSync.push(false); return; }
      download((e2,data)=>{
        busy=false;
        if(e2) return setStatus("err","Drive: "+e2);
        try{
          const j=(typeof data==="string")? JSON.parse(data):data;
          if(!j||!j.state) throw new Error("unexpected file contents");
          if(!force&&dirty&&lastPulled&&mod&&mod!==lastPulled){
            if(!confirm("Google Drive has a newer copy (saved "+new Date(mod).toLocaleString()+", likely another device) and this device has unsaved changes.\n\nOK = use the Drive copy (lose local changes)\nCancel = keep this device's data and overwrite Drive on the next save"))
              { setStatus("dirty","Drive: keeping this device's data"); return; }
          }
          cfg.setState(j.state);
          lastPulled=mod||null; lsS(pulledKey(),lastPulled||""); dirty=false;
          setStatus("ok","Drive: loaded "+new Date().toLocaleTimeString()+(j.device?" (from "+j.device+")":""));
        }catch(err){ setStatus("err","Drive: "+err.message); }
      });
    });
  },
  /* push: write local state to Drive. manual=user clicked. quiet=page unloading */
  push(manual,quiet){
    if(busy||!cfg) return;
    if(!clientId()) return setStatus("err","Drive: client ID not set");
    busy=true; if(!quiet) setStatus("busy","Drive: saving…");
    const write=()=>{
      const payload=JSON.stringify({app:cfg.app,savedAt:new Date().toISOString(),device:cfg.device||"a device",state:cfg.getState()});
      upload(payload,(e,d)=>{
        busy=false;
        if(e) return setStatus("err","Drive: "+e);
        dirty=false; lastPulled=d&&d.modifiedTime||null; lsS(pulledKey(),lastPulled||"");
        setStatus("ok","Drive: saved "+new Date().toLocaleTimeString());
      });
    };
    findFile((e,id,mod)=>{
      if(e){ busy=false; return setStatus("err","Drive: "+e); }
      if(id&&lastPulled&&mod&&mod!==lastPulled&&!quiet){
        if(!confirm("Google Drive has a newer copy (saved "+new Date(mod).toLocaleString()+" — probably another device).\n\nOK = overwrite Drive with this device's data\nCancel = leave Drive alone (use “⤓ Load Drive” to pull it instead)"))
          { busy=false; return setStatus("dirty","Drive: not saved — Drive copy is newer"); }
      }
      write();
    });
  },
  _t:{ set st(v){status=v}, get st(){return status}, get dirty(){return dirty}, set dirty(v){dirty=v},
       get lastPulled(){return lastPulled}, set lastPulled(v){lastPulled=v},
       setTok(t,ms){token=t;tokenExp=Date.now()+(ms||3600000)}, get fileId(){return fileId}, set fileId(v){fileId=v},
       get cfg(){return cfg} }
};
window.GSync=GSync;
})();
