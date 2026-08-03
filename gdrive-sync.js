/* ============================================================================
   gdrive-sync.js — Google Drive sync layer for the Section H tools
   Shared by Project_Tracker.html and Part13_Data_Tool_v2.html.

   • Scope: drive.file — the tools can ONLY see files they created themselves.
   • One JSON file per tool, kept in the folder "Section H Tools" in your Drive.
   • Requires https (GitHub Pages). Opened from your hard drive, sync is skipped
     and the tools fall back to local-only storage, exactly as before.

   ---------------------------------------------------------------------------
   v2 — RECORD-LEVEL MERGE (2026-08-01)

   v1 synced wholesale: a pull deleted every local record and replaced it with
   the Drive copy. If the desktop held project 26020 and the iPad held 26022,
   there was no correct answer — one device's work was always destroyed.

   v2 merges record by record instead:
     • every record carries `updatedAt`; on a clash the newer one wins
     • a record on only one side is KEPT, never deleted
     • deletes travel as tombstones, so a delete doesn't get resurrected
     • every push does read-modify-write: if Drive changed since our last
       pull we merge first, then write — so a save can't clobber the other
       device, and the "Drive is newer, overwrite?" prompt is gone

   Records MUST be keyed by something both devices agree on (a job number, or
   a collision-proof id). A per-device counter (1,2,3…) is NOT safe as a key —
   both devices will mint the same id for different records.
   ========================================================================== */
(function(){
"use strict";
if(window.GSync) return;

const SCOPE="https://www.googleapis.com/auth/drive.file";
const FOLDER="Section H Tools";
const TOMB_TTL=180*24*3600*1000;   /* forget deletions after 180 days */
const SNAP_KEEP=5;                 /* rolling local safety snapshots */
let cfg=null, token=null, tokenExp=0, tokenClient=null, waiters=[];
let fileId=null, folderId=null, lastPulled=null, dirty=false, busy=false, timer=null;
let status="off", statusTxt="Drive: not connected";

const lsG=k=>{ try{return localStorage.getItem(k)}catch(e){return null} };
const lsS=(k,v)=>{ try{localStorage.setItem(k,v)}catch(e){} };
const lsD=k=>{ try{localStorage.removeItem(k)}catch(e){} };
/* strip anything iOS/mail clients like to add: spaces, newlines, quotes,
   zero-width chars, smart quotes, a stray "Client ID:" prefix */
function cleanId(v){
  return String(v==null?"":v)
    .replace(/[\u200B-\u200D\uFEFF]/g,"")
    .replace(/^[\s\S]*?client\s*id\s*[:=]\s*/i,"")
    .replace(/["'\u2018\u2019\u201C\u201D<>]/g,"")
    .replace(/\s+/g,"")
    .trim();
}
function idLooksValid(v){ return /^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(v); }
function clientId(){ return cleanId(window.GSYNC_CLIENT_ID||lsG("gsync_client_id")||""); }
/* let a link carry the ID to another device: ...html?gsync=<client-id> */
function idFromURL(){
  const m=(location.search+location.hash).match(/[?&#]gsync=([^&#]+)/);
  if(!m) return null;
  const v=cleanId(decodeURIComponent(m[1]));
  try{ history.replaceState(null,"",location.pathname); }catch(e){}
  return v||null;
}
function pulledKey(){ return "gsync_pulled_"+cfg.app; }
function snapKey(){ return "gsync_snap_"+cfg.app; }
function httpsOK(){ return location.protocol==="https:"; }

/* ============================================================================
   MERGE UTILITIES — used by the tools, and unit-testable on their own
   ========================================================================== */
const ts=v=>{ const n=Date.parse(v||""); return isFinite(n)?n:0; };

/* A collision-proof record id. Never use a per-device counter for anything
   that syncs — two devices mint the same number for different records. */
function newId(){
  return Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
}

/* Merge two {key: record} maps plus their tombstones.
   Each record should carry `updatedAt` (ISO). Missing = treated as oldest.
   Returns {map, tombs, changed} — `changed` is true if the local side gained
   or lost anything, i.e. the merged result differs from what we had locally. */
function mergeMaps(localMap, remoteMap, localTombs, remoteTombs, stampKey){
  localMap=localMap||{}; remoteMap=remoteMap||{};
  localTombs=localTombs||{}; remoteTombs=remoteTombs||{};
  const SK=stampKey||"updatedAt";
  const now=Date.now();
  const map={}, tombs={};
  /* union of every tombstone, newest wins, expired ones dropped */
  for(const k of new Set([...Object.keys(localTombs),...Object.keys(remoteTombs)])){
    const t=Math.max(ts(localTombs[k]),ts(remoteTombs[k]));
    if(t && now-t < TOMB_TTL) tombs[k]=new Date(t).toISOString();
  }
  for(const k of new Set([...Object.keys(localMap),...Object.keys(remoteMap)])){
    const l=localMap[k], r=remoteMap[k];
    /* newer side wins; a side that doesn't have it at all never "wins" */
    let rec, when;
    if(l&&r){ if(ts(r[SK])>ts(l[SK])){ rec=r; when=ts(r[SK]); } else { rec=l; when=ts(l[SK]); } }
    else if(l){ rec=l; when=ts(l[SK]); }
    else { rec=r; when=ts(r[SK]); }
    if(!rec) continue;
    /* a deletion only wins if it happened AFTER the surviving edit —
       otherwise the record was re-created or edited since, so it stays */
    if(tombs[k] && ts(tombs[k])>=when) continue;
    if(tombs[k]) delete tombs[k];
    map[k]=rec;
  }
  const before=JSON.stringify(localMap), after=JSON.stringify(map);
  return {map, tombs, changed: before!==after};
}

/* Merge flat app-level settings (goal, page, etc). Each side may carry a
   `settingsAt` stamp; newest wins wholesale. Local wins if neither stamped. */
function mergeSettings(local, remote, localAt, remoteAt){
  return ts(remoteAt)>ts(localAt) ? remote : local;
}

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
  else if(status==="off"||status==="err") btns=b("Connect Drive","GSync.connect()")+b("⚙","GSync.setup()","Check / change the Client ID")+b("🔗","GSync.shareLink()","Copy a setup link for another device");
  else btns=b("Sync now","GSync.push(true)")
      +b("↺","GSync.restore()","Undo — roll this device back to a snapshot taken before a sync")
      +b("⤓","GSync.loadDriveCopy()","Discard this device's data and take the Drive copy (rarely needed — syncing already merges)")
      +b("🔗","GSync.shareLink()","Copy a setup link for another device");
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

/* ============================================================================
   GENERIC FILES — for real attachments (Word templates) kept alongside the
   state JSON in the same "Section H Tools" folder.

   Remember the scope: drive.file means the app can only ever see files IT
   created. A .docx dragged into the folder by hand is invisible to us, which
   is why templates are uploaded through the app rather than discovered.
   ========================================================================== */
function b64ToBytes(b64){
  const bin=atob(b64), n=bin.length, out=new Uint8Array(n);
  for(let i=0;i<n;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function bytesToB64(buf){
  const b=new Uint8Array(buf); let s=""; const CH=0x8000;
  for(let i=0;i<b.length;i+=CH) s+=String.fromCharCode.apply(null,b.subarray(i,i+CH));
  return btoa(s);
}
function apiRaw(url,method,body,ctype,cb,retried){
  withToken(false,(e,tk)=>{
    if(e) return cb(e);
    const h={Authorization:"Bearer "+tk};
    if(ctype) h["Content-Type"]=ctype;
    fetch(url,{method:method,headers:h,body:body}).then(r=>{
      if(r.status===401&&!retried){ token=null; return apiRaw(url,method,body,ctype,cb,true); }
      if(!r.ok) return r.text().then(t=>cb("http "+r.status+" "+t.slice(0,140)));
      return r.json().then(d=>cb(null,d));
    }).catch(err=>cb(err.message||"network"));
  });
}
function _findNamed(name,cb){
  const q=encodeURIComponent("name='"+String(name).replace(/'/g,"\\'")+"' and trashed=false");
  api("https://www.googleapis.com/drive/v3/files?q="+q+"&fields=files(id,name,modifiedTime)&spaces=drive",null,(e,d)=>{
    if(e) return cb(e);
    cb(null,(d.files&&d.files.length)? d.files[0] : null);
  });
}

/* ---------------- local safety snapshots ----------------
   Taken before every merge and every hard restore. Purely local, so a bad
   merge — or a mistaken "Load Drive" — is always recoverable on the device
   it happened on, without touching Drive. */
function snapshot(label){
  try{
    const list=JSON.parse(lsG(snapKey())||"[]");
    list.unshift({at:new Date().toISOString(), label:label||"", state:cfg.getState()});
    while(list.length>SNAP_KEEP) list.pop();
    lsS(snapKey(),JSON.stringify(list));
  }catch(e){}
}

/* ---------------- apply a remote state ----------------
   Merge if the tool provides mergeState; otherwise fall back to the old
   wholesale replace so an un-migrated tool still works. */
function applyRemote(remoteState, hard){
  if(hard || typeof cfg.mergeState!=="function"){ cfg.setState(remoteState); return true; }
  return cfg.mergeState(remoteState)!==false;
}

/* ============================================================================
   public API
   ========================================================================== */
const GSync={
  init(c){ cfg=c; lastPulled=lsG(pulledKey());
    const fromUrl=idFromURL();
    if(fromUrl){ if(idLooksValid(fromUrl)){ lsS("gsync_client_id",fromUrl); token=null; tokenClient=null; }
                 else setTimeout(()=>alert("The Client ID in that link looks incomplete:\n"+fromUrl),300); }
    if(!httpsOK()){ setStatus("off","Local file — Drive sync off"); return; }
    const stored=clientId();
    if(stored&&!idLooksValid(stored)){ setStatus("err","Drive: client ID looks wrong — tap ⚙"); paint(); return; }
    setStatus("off","Drive: not connected"); paint();
    if(clientId()) setTimeout(()=>GSync.pull(false,true),400);   /* silent auto-merge on open */
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
    const v=prompt("Paste your Google OAuth Client ID — the whole string, ending in .apps.googleusercontent.com\n(Google Cloud Console → Clients → your Web application client.)",cur||"");
    if(v==null) return;
    const id=cleanId(v);
    if(!id){ lsS("gsync_client_id",""); token=null; tokenClient=null; return setStatus("off","Drive: client ID cleared"); }
    if(!idLooksValid(id)){
      alert("That doesn't look like a complete Client ID.\n\nWhat you entered ("+id.length+" characters):\n"+id.slice(0,60)+(id.length>60?"…":"")
        +"\n\nIt should look like:\n1234567890-abc123def456.apps.googleusercontent.com\n\nMost likely the copy was cut short. Tip: on a phone or tablet, open this page with the ID in the link instead:\n"
        +location.origin+location.pathname+"?gsync=YOUR-CLIENT-ID");
      return;
    }
    lsS("gsync_client_id",id); token=null; tokenClient=null;
    GSync.connect();
  },
  /* build a link that carries the ID to another device */
  shareLink(){
    const id=clientId();
    if(!idLooksValid(id)) return alert("Set a valid Client ID on this device first.");
    const url=location.origin+location.pathname+"?gsync="+encodeURIComponent(id);
    try{ navigator.clipboard.writeText(url); alert("Setup link copied to the clipboard — email it to yourself and open it on the other device:\n\n"+url); }
    catch(e){ prompt("Copy this link and open it on the other device:",url); }
  },
  help(){ alert("Drive sync needs the hosted version of these tools (an https:// address, e.g. your GitHub Pages URL).\n\nOpened straight from your hard drive, the tools still work — they just save locally on this device only."); },

  /* ---- pull: merge the Drive copy into this device (never deletes local work)
     hard=true  → replace local wholesale (only from GSync.loadDriveCopy())
     silent=true→ no error noise (used by the auto-pull on open)            ---- */
  pull(hard,silent,done){
    if(busy){ if(done) done("busy"); return; }
    busy=true;
    setStatus("busy",hard?"Drive: loading…":"Drive: syncing…");
    findFile((e,id,mod)=>{
      if(e){ busy=false; if(done) done(e); return setStatus(silent?"off":"err","Drive: "+(silent?"not connected":e)); }
      if(!id){ busy=false; setStatus("ok","Drive: no file yet — will create on save"); if(done) done(null,false); else if(dirty) GSync.push(false); return; }
      download((e2,data)=>{
        busy=false;
        if(e2){ if(done) done(e2); return setStatus("err","Drive: "+e2); }
        try{
          const j=(typeof data==="string")? JSON.parse(data):data;
          if(!j||!j.state) throw new Error("unexpected file contents");
          snapshot(hard?"before Load Drive":"before merge");
          applyRemote(j.state,hard);
          lastPulled=mod||null; lsS(pulledKey(),lastPulled||"");
          /* a merge can leave us holding records Drive doesn't have yet —
             stay dirty so the debounced push writes them back */
          if(hard) dirty=false;
          setStatus(dirty?"dirty":"ok",(hard?"Drive: loaded ":"Drive: synced ")+new Date().toLocaleTimeString()+(j.device?" (with "+j.device+")":""));
          if(done) done(null,true);
        }catch(err){ setStatus("err","Drive: "+err.message); if(done) done(err.message); }
      });
    });
  },

  /* ---- push: read-modify-write. If Drive moved since our last pull we merge
     it in FIRST, then write the union. No more overwrite prompt — and no way
     for one device's save to erase the other's projects.                  ---- */
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
      const stale = id && mod && mod!==lastPulled;
      if(!stale) return write();
      /* Drive changed under us — merge before writing so we never clobber it */
      download((e2,data)=>{
        if(e2){ busy=false; return setStatus("err","Drive: "+e2); }
        try{
          const j=(typeof data==="string")? JSON.parse(data):data;
          if(j&&j.state){ snapshot("before merge (on save)"); applyRemote(j.state,false); }
          lastPulled=mod;
        }catch(err){ /* unreadable remote — keep ours rather than lose it */ }
        write();
      });
    });
  },

  /* explicit, deliberate "throw away this device's copy and take Drive's" */
  loadDriveCopy(){
    if(!confirm("Replace this device's data with the copy in Google Drive?\n\nNormal syncing already merges both devices — you only need this to deliberately discard what's on this device.\n\nA snapshot is taken first, so you can undo it with ↺.")) return;
    GSync.pull(true,false);
  },

  /* roll back to a local snapshot — the undo for a bad merge or a bad restore */
  restore(){
    let list=[]; try{ list=JSON.parse(lsG(snapKey())||"[]"); }catch(e){}
    if(!list.length) return alert("No snapshots on this device yet.\n\nOne is taken automatically before every sync that changes your data.");
    const menu=list.map((s,i)=>(i+1)+") "+new Date(s.at).toLocaleString()+(s.label?" — "+s.label:"")).join("\n");
    const pick=prompt("Roll this device back to a snapshot?\n\n"+menu+"\n\nType a number (1–"+list.length+"), or Cancel.\nThis only changes this device — nothing is written to Drive until your next save.");
    if(pick==null) return;
    const n=parseInt(pick,10);
    if(!(n>=1&&n<=list.length)) return alert("Not a valid number.");
    snapshot("before rollback");
    cfg.setState(list[n-1].state);
    dirty=true;
    setStatus("dirty","Drive: rolled back — save to push it to Drive");
  },
  snapshots(){ try{ return JSON.parse(lsG(snapKey())||"[]"); }catch(e){ return []; } },

  /* ---- generic Drive files (Word templates) ---- */
  ready(){ return httpsOK() && !!clientId(); },

  /* create or overwrite <name> in the Section H Tools folder */
  putFile(name, b64, mime, cb){
    if(!GSync.ready()) return cb("Drive isn't connected on this device.");
    mime = mime || "application/octet-stream";
    findFolder((e,fid)=>{
      if(e) return cb(e);
      _findNamed(name,(e2,found)=>{
        if(e2) return cb(e2);
        const bytes=b64ToBytes(b64);
        if(found&&found.id){
          return apiRaw("https://www.googleapis.com/upload/drive/v3/files/"+found.id
            +"?uploadType=media&fields=id,name,modifiedTime","PATCH",
            new Blob([bytes],{type:mime}), mime, cb);
        }
        const bd="gsyncbin"+Date.now();
        const meta=JSON.stringify({name:name,parents:[fid],mimeType:mime});
        const body=new Blob([
          "--"+bd+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+meta+"\r\n",
          "--"+bd+"\r\nContent-Type: "+mime+"\r\n\r\n", bytes, "\r\n--"+bd+"--"
        ]);
        apiRaw("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime",
          "POST", body, "multipart/related; boundary="+bd, cb);
      });
    });
  },
  /* has the file changed since we cached it? cheap — metadata only */
  fileMeta(id, cb){
    if(!GSync.ready()) return cb("offline");
    api("https://www.googleapis.com/drive/v3/files/"+id+"?fields=id,name,modifiedTime",null,cb);
  },
  /* file contents as base64 — arrayBuffer, never text, or the zip is corrupted */
  getFileB64(id, cb){
    if(!GSync.ready()) return cb("offline");
    withToken(false,(e,tk)=>{
      if(e) return cb(e);
      fetch("https://www.googleapis.com/drive/v3/files/"+id+"?alt=media",
            {headers:{Authorization:"Bearer "+tk}})
        .then(r=>{
          if(!r.ok) return r.text().then(t=>cb("http "+r.status+" "+t.slice(0,140)));
          return r.arrayBuffer().then(buf=>cb(null,bytesToB64(buf)));
        }).catch(err=>cb(err.message||"network"));
    });
  },
  trashFile(id, cb){
    if(!GSync.ready()) return cb&&cb("offline");
    apiRaw("https://www.googleapis.com/drive/v3/files/"+id,"PATCH",
      JSON.stringify({trashed:true}),"application/json", cb||function(){});
  },
  /* Look for a file by name in the folder. Exposed so a template dropped
     into the Drive folder by hand can be adopted — the tool used to know only
     about templates uploaded through its own button, so a file put there
     directly was invisible and the Generate button stayed disabled. */
  findNamed(name, cb){
    /* the bare name below resolves to the module-level function, not to this
       method — shorthand methods create no binding for their own name — but
       the alias makes that impossible to misread later */
    if(!GSync.ready()) return cb("Drive isn't connected on this device.");
    return _findNamed(name, cb);
  },
  folderName(){ return FOLDER; },

  /* shared merge helpers, exposed for the tools (and the test harness) */
  mergeMaps, mergeSettings, newId, ts,

  _t:{ set st(v){status=v}, get st(){return status}, get dirty(){return dirty}, set dirty(v){dirty=v},
       get lastPulled(){return lastPulled}, set lastPulled(v){lastPulled=v},
       setTok(t,ms){token=t;tokenExp=Date.now()+(ms||3600000)}, get fileId(){return fileId}, set fileId(v){fileId=v},
       get cfg(){return cfg} }
};
window.GSync=GSync;
if(typeof module!=="undefined"&&module.exports) module.exports=GSync;   /* for tests */
})();
