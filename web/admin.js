document.querySelectorAll('form').forEach(function(f){ f.addEventListener('submit', function(e){ e.preventDefault(); }); });
const API = window.API_BASE || '';
const TK='thingino_admin_token';
const tok=()=>localStorage.getItem(TK)||'';
const $=id=>document.getElementById(id);
const short=s=>s?String(s).slice(0,8):'';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ipExpanded=new Set();
let cpop=null;   // the open confirm popover, if any; declared here so refresh() below can drop it
// Origin flag for an ISO 3166-1 alpha-2 code (two regional-indicator codepoints, so no
// image assets). Cloudflare's pseudo-codes ("XX" unknown, "T1" Tor) and anything else
// non-alphabetic render as the bare code instead of a bogus flag.
const flag=cc=>{ if(!cc||!/^[A-Za-z]{2}$/.test(cc)) return esc(cc||'');
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c=>c.codePointAt(0)+127397)); };
const geo=cc=>cc?`<span class="me-1" title="${esc(cc)}">${flag(cc)}</span>`:'';
const ipcell=(full,bucket,cc)=>{ const f=full||'', b=bucket||full||''; return `${geo(cc)}<code class="ipc" data-full="${esc(f)}" data-bucket="${esc(b)}" style="cursor:pointer" title="${esc(I18N.t('title_ip_toggle'))}">${esc(ipExpanded.has(f)?b:f)}</code>`; };
function buildAction(b){ const id=esc(b.build_id);
  if(['queued','running','cancelling'].includes(b.state)) return ` <a href="#" class="bact text-danger ms-1" data-act="cancel" data-id="${id}" title="${esc(I18N.t('title_cancel_build'))}">✕</a>`;
  if(['done','failed'].includes(b.state)) return ` <a href="#" class="bact text-secondary small ms-1" data-act="expire" data-id="${id}" title="${esc(I18N.t('title_remove_artifact'))}">${I18N.t('act_remove')}</a>`;
  return ''; }
// Run id, linked to its Actions run so a failed build is one click from its logs. The
// repo comes from the API (config.js is rewritten at deploy time, so it can't hold it).
// An expired build's run was deleted by the reaper, so that one stays plain text.
let ghRepo=null;
const runcell=(r,state)=>{ if(!r) return ''; const c=`<code>${esc(r)}</code>`;
  return (ghRepo&&state!=='expired')?`<a href="https://github.com/${esc(ghRepo)}/actions/runs/${encodeURIComponent(r)}" target="_blank" rel="noopener">${c}</a>`:c; };
// Always 24 hour and zero padded, and the same shape cf-termbin uses so the two portals read
// alike. `hourCycle:'h23'` rather than `hour12:false`: on current ICU both resolve to h23 in
// every locale, but h23 asks for it outright instead of inheriting whatever the locale's
// preferred 24 hour cycle is, and the other one, h24, renders midnight as 24:00:12. Locale
// still decides field order, so a date stays dd/mm in en-GB and mm/dd in en-US.
const HMS={hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'};
const YMD={year:'numeric',month:'2-digit',day:'2-digit'};
// Full date and time, because an event log spans days: a clock alone leaves a row from Tuesday
// indistinguishable from one an hour old.
const tfmt=ts=>new Date(ts*1000).toLocaleString([],{...YMD,...HMS});
const hms=d=>d.toLocaleTimeString([],HMS);
const dur=(a,b)=>{ if(!a||!b) return '–'; const s=b-a; return `${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`; };
const ago=ts=>{ const s=Math.floor(Date.now()/1000)-ts; if(s<60)return I18N.t('ago_seconds',{n:s}); if(s<3600)return I18N.t('ago_minutes',{n:Math.floor(s/60)}); return I18N.t('ago_hours',{n:Math.floor(s/3600)}); };
const PILL={queued:'bg-info text-dark',running:'bg-primary',cancelling:'bg-warning text-dark',done:'bg-success',failed:'bg-danger',cancelled:'bg-secondary',expired:'bg-dark border'};
const stateLabel=s=>{ const v=I18N.t('state_'+s); return v==='state_'+s?s:v; };
// An expired build keeps its terminal result in `outcome`, so show e.g. "expired (done)".
const pill=(s,o)=>{ const t=(s==='expired'&&o)?`${stateLabel(s)} (${stateLabel(o)})`:stateLabel(s); return `<span class="badge ${PILL[s]||'bg-secondary'}" title="${esc(t)}">${esc(t)}</span>`; };
const tile=(l,n)=>`<div class="col-6 col-md-3 col-lg-2"><div class="card text-center h-100"><div class="card-body py-2 px-1"><div class="fs-4 fw-bold">${n??0}</div><div class="small muted text-uppercase">${l}</div></div></div></div>`;

// Cloudflare's free daily request limit answers admin endpoints with a bare 429 (none of
// our own admin routes emit 429), so that status means "out of capacity". Admin sees the
// real cause; the public page just shows the generic maintenance banner.
const capText=()=>{ const n=new Date(), reset=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()+1)); return I18N.t('over_capacity',{t:reset.toLocaleTimeString([],{hourCycle:'h23',hour:'2-digit',minute:'2-digit'})}); };
function showCap(on){ const b=$('cap-banner'); if(b){ if(on) b.textContent=capText(); b.style.display=on?'':'none'; } }
async function adminGet(){ const r=await fetch(API+'/api/admin/stats'+allQs(),{headers:{Authorization:'Bearer '+tok()}}); if(r.status===401){ const e=new Error('unauthorized'); e.auth=1; throw e; } if(r.status===429){ const e=new Error('capacity'); e.cap=1; throw e; } if(!r.ok) throw new Error('http '+r.status); return r.json(); }
let masterMode=false;
function setMaster(on){ masterMode=on;
  $('username').style.display=on?'none':''; $('password').style.display=on?'none':''; $('token').style.display=on?'':'none';
  $('master-toggle').textContent=on?I18N.t('userpass_toggle'):I18N.t('master_toggle');
  $('gate-hint').textContent=on?I18N.t('master_hint'):I18N.t('signin_hint');
}
async function login(){
  $('gate-err').textContent='';
  // app is an audit label for the login event, not a credential and not a permission. The
  // Worker prefers the Origin header and only falls back to this, so it cannot lie from a browser.
  const body=masterMode?{token:$('token').value.trim(),totp:$('totp').value.trim(),app:'builder'}
    :{username:$('username').value.trim().toLowerCase(),password:$('password').value,totp:$('totp').value.trim(),app:'builder'};
  const r=await fetch(API+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.session){ localStorage.setItem(TK,d.session); show(); }
  else { $('gate-err').textContent=(r.status===429&&!d.error)?capText():(d.error||I18N.t('err_invalid_creds')); localStorage.removeItem(TK); }
}
function show(){ $('gate').style.display='none'; $('app').style.display=''; refresh(); }
async function logout(){ try{ await fetch(API+'/api/admin/logout',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); }catch{} localStorage.removeItem(TK); location.reload(); }

// Inactivity logout: 2h without real user input ends the session. The server enforces the
// same window per-request on its side; this client check covers a visible tab, whose 10s
// stats poll would otherwise keep the session alive forever. Last input is tracked in
// localStorage (throttled), so activity in any tab counts for all tabs and survives reloads.
const IDLE_MS=2*3600*1000, LA='thingino_admin_last_input';
let laWrote=0;
const touchIdle=()=>{ const t=Date.now(); if(t-laWrote>30000){ laWrote=t; try{ localStorage.setItem(LA,String(t)); }catch{} } };
['pointerdown','keydown','wheel','touchstart'].forEach(e=>document.addEventListener(e,touchIdle,{passive:true,capture:true}));
// True (and starts the logout) when the last user input is too old; a missing marker is
// seeded to "now" instead of logging out, so pre-existing sessions get a full window.
function idledOut(){ const la=parseInt(localStorage.getItem(LA)||'0',10);
  if(!la){ touchIdle(); return false; }
  if(Date.now()-la>IDLE_MS){ logout(); return true; }
  return false; }

let enabled=true;
let srvVer=null;
// The two tables default to the newest 25 / 60 rows; each table's "show all" re-fetches
// with that table named in ?all= (server-clamped), so the whole 7-day retention window is
// visible for one without dragging the other along. Session-only: a reload returns to the
// light default and the 10s poll stays cheap for everyone else.
const showAll={builds:false,events:false};
const allQs=()=>{ const p=Object.keys(showAll).filter(k=>showAll[k]); return p.length?'?all='+p.join(','):''; };
async function refresh(){
  // Re-rendering the tables destroys the row a confirm popover is anchored to, so drop it.
  // The 10s poll skips refreshing entirely while one is open; this covers every other caller.
  closeConfirm(false);
  let d; try{ d=await adminGet(); }catch(e){ if(e&&e.auth){ logout(); } else if(e&&e.cap){ showCap(true); } return; }
  showCap(false);
  // Version handshake: reload once when a deploy changes the server version, so open
  // admin tabs stop running stale page code.
  if(d.version){ if(srvVer===null) srvVer=d.version; else if(d.version!==srvVer){ location.reload(); return; } }
  enabled=d.builds_enabled;
  ghRepo=d.repo||null;
  $('kill-state').innerHTML=enabled?'<span class="text-success">'+I18N.t('kill_enabled')+'</span>':'<span class="text-danger">'+I18N.t('kill_disabled')+'</span>';
  const kb=$('kill-btn'); kb.textContent=enabled?I18N.t('kill_disable'):I18N.t('kill_enable'); kb.className='btn btn-sm '+(enabled?'btn-outline-danger':'btn-thingino');
  $('kill-extra').textContent=I18N.t('kill_extra',{n:d.max_concurrent,m:Math.round(d.retention_secs/60)});
  // Version + self-update: the card only makes sense on a backend that can self-update
  // (the VPS broker sets self_update). The Worker can't, so there the card is hidden and
  // the version shows in the footer instead. The footer span is emptied on the broker so
  // the version isn't printed twice.
  const selfUpdate=!!d.self_update;
  $('version-card').style.display=selfUpdate?'':'none';
  $('admin-ver').textContent=selfUpdate?'':(d.version||'');
  $('ver').textContent=d.version||'–';
  if(d.update_available){
    $('upd-badge').innerHTML='<span class="badge text-bg-warning ms-1">'+I18N.t('update_available',{v:esc(d.latest_version)})+'</span>';
    $('upd-btn').style.display=''; $('upd-btn').dataset.v=d.latest_version||'';
  } else {
    $('upd-badge').innerHTML=d.latest_version?'<span class="text-success small ms-1">'+I18N.t('up_to_date')+'</span>':'';
    $('upd-btn').style.display='none';
  }
  renderLimits(d.limits, d.usage);
  renderBranches(d.branches);
  renderNotice(d);
  isMaster=!!d.master; if(d.master||d.manage_users){ if(!usersShown){ $('users-card').style.display=''; usersShown=true; renderUsers(); } } else $('users-card').style.display='none';
  const c=d.counts||{};
  $('tiles').innerHTML=[['state_running',c.running],['state_queued',c.queued],['state_done',c.done],['state_failed',c.failed],['state_cancelled',c.cancelled],['state_expired',c.expired],['tile_24h',d.last24h],['tile_total_done',d.total_done??0],['tile_avg_build',d.avg_build_secs?Math.round(d.avg_build_secs/60)+'m':'–']].map(([k,n])=>tile(I18N.t(k),n)).join('');
  $('builds-body').innerHTML=(d.recent_builds||[]).map(b=>`<tr><td><code>${esc(short(b.build_id))}</code></td><td>${esc(b.defconfig)}</td><td>${esc(b.ref||'–')}</td><td>${pill(b.state,b.outcome)}${buildAction(b)}</td><td><code>${esc(short(b.uid))}</code></td><td>${ipcell(b.ip,b.ip_bucket,b.country)}</td><td>${ago(b.created_ts)}</td><td>${dur(b.dispatched_ts,b.finished_ts)}</td><td>${runcell(b.run_id,b.state)}</td></tr>`).join('');
  // "showing latest N of M kept (7 days)" + the expand/collapse link under each table.
  // Builds total = the state-count tiles summed; events carry their own count.
  const moreLine=(id,which,shown,total)=>{ const el=$(id); if(!el) return;
    const on=showAll[which];
    let h=esc(I18N.t('showing_latest',{n:shown,m:total??shown,days:d.kept_days||7}));
    if((total??0)>shown||on) h+=' <a href="#" class="more-toggle" data-which="'+which+'">'+esc(I18N.t(on?'show_less':'show_all'))+'</a>';
    el.innerHTML=h; };
  moreLine('builds-more','builds',(d.recent_builds||[]).length,Object.values(c).reduce((a,x)=>a+(x||0),0));
  moreLine('events-more','events',(d.recent_events||[]).length,d.events_total);
  $('events-body').innerHTML=(d.recent_events||[]).map(e=>`<tr><td>${tfmt(e.ts)}</td><td>${esc(e.kind)}</td><td><code>${esc(short(e.build_id))}</code></td><td><code>${esc(short(e.uid))}</code></td><td>${ipcell(e.ip,e.ip_bucket,e.country)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('');
  $('updated').textContent=I18N.t('updated',{t:hms(new Date())});
}
async function toggle(){ await fetch(API+'/api/admin/toggle',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({enabled:!enabled})}); refresh(); }
// --- notice banner: one at a time, posted to the public builder page ---
// Levels are GitHub's five markdown alert types; each badge takes the Bootstrap colour
// its banner uses on the builder page. info/danger are the old names of note/caution,
// mapped so a notice posted before the rename still shows the right badge.
const NLVL={note:'bg-info text-dark',tip:'bg-success',important:'bg-purple',warning:'bg-warning text-dark',caution:'bg-danger'};
const NLVL_ALIAS={info:'note',danger:'caution'};
const nlvl=l=>{ const s=NLVL_ALIAS[l]||l; return NLVL[s]?s:'note'; };
let noticeSeen=null;
function renderNotice(d){
  const can=!!(d.master||d.edit_notice);
  $('notice-card').style.display=can?'':'none';
  if(!can) return;
  const n=d.notice, lvl=n?nlvl(n.level):'note';
  $('notice-state').innerHTML=n
    ?`<span class="badge ${NLVL[lvl]}">${esc(I18N.t('notice_'+lvl))}</span> ${esc(n.text)}`
      +(n.until?` <span class="muted">${esc(I18N.t('notice_expires',{t:tfmt(n.until)}))}</span>`:'')
    :`<span class="muted">${esc(I18N.t('notice_none'))}</span>`;
  // Refill the editor from the server only when the server's value actually changed and the
  // box isn't focused, so the 10s poll can't overwrite a half-typed notice.
  const sig=JSON.stringify(n||null);
  if(sig!==noticeSeen&&document.activeElement!==$('notice-text')){
    noticeSeen=sig;
    $('notice-text').value=n?n.text:'';
    $('notice-level').value=lvl;
  }
}
async function postNotice(clear){
  const body=clear?{text:''}:{text:$('notice-text').value,level:$('notice-level').value,hours:parseInt($('notice-hours').value,10)||0};
  $('notice-msg').textContent=I18N.t('saving');
  try{
    const r=await fetch(API+'/api/admin/notice',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(r.ok){ if(clear) $('notice-text').value=''; noticeSeen=null; $('notice-msg').textContent=I18N.t('saved'); }
    else $('notice-msg').textContent=j.error||I18N.t('failed');
  }catch{ $('notice-msg').textContent=I18N.t('failed'); }
  refresh();
}
async function clearLogs(){ if(!confirm(I18N.t('confirm_clear_logs'))) return; await fetch(API+'/api/admin/clear-logs',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); refresh(); }
async function clearBuilds(){ if(!confirm(I18N.t('confirm_clear_builds'))) return; await fetch(API+'/api/admin/clear-builds',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); refresh(); }
async function resetLimits(){ if(!confirm(I18N.t('confirm_reset_limits'))) return; const r=await fetch(API+'/api/admin/reset-limits',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); if(r.ok) $('kill-extra').textContent=I18N.t('hourly_reset'); refresh(); }
let lastLimits=null, lastUsage=null, editingLimits=false;
const fmtLimits=(L,U)=>{ const pair=(u,m)=> U ? `<code>${u}</code> / <code>${m}</code>` : `<code>${m}</code>`;
  return `${I18N.t('lim_user_hourly')} <code>${L.userHourly}</code> · ${I18N.t('lim_ip_hourly')} <code>${L.ipHourly}</code> · ${I18N.t('lim_global_hourly')} ${pair(U&&U.globalHourly,L.globalHourly)} · ${I18N.t('lim_concurrent')} ${pair(U&&U.maxConcurrent,L.maxConcurrent)} · ${I18N.t('lim_queue')} ${pair(U&&U.maxQueue,L.maxQueue)} · ${I18N.t('lim_retention')} <code>${Math.round(L.retention/60)}</code> ${I18N.t('lim_min')}`; };
function renderLimits(L,U){ if(!L) return; lastLimits=L; lastUsage=U; if(!editingLimits) $('limits-view').innerHTML=fmtLimits(L,U); }
function editLimits(){ const L=lastLimits; if(!L) return; editingLimits=true; $('limits-msg').textContent='';
  $('lim-userHourly').value=L.userHourly; $('lim-ipHourly').value=L.ipHourly; $('lim-globalHourly').value=L.globalHourly; $('lim-maxConcurrent').value=L.maxConcurrent; $('lim-maxQueue').value=L.maxQueue; $('lim-retention').value=Math.round(L.retention/60);
  $('limits-view').style.display='none'; $('limits-edit').style.display='none'; $('limits-fields').style.display=''; $('limits-save').style.display=''; $('limits-cancel').style.display=''; }
function viewLimits(){ editingLimits=false;
  $('limits-view').style.display=''; $('limits-edit').style.display=''; $('limits-fields').style.display='none'; $('limits-save').style.display='none'; $('limits-cancel').style.display='none';
  if(lastLimits) $('limits-view').innerHTML=fmtLimits(lastLimits,lastUsage); }
async function saveLimits(){ const v=id=>parseInt($(id).value,10);
  const body={userHourly:v('lim-userHourly'),ipHourly:v('lim-ipHourly'),globalHourly:v('lim-globalHourly'),maxConcurrent:v('lim-maxConcurrent'),maxQueue:v('lim-maxQueue'),retention:Math.max(60,v('lim-retention')*60)};
  $('limits-msg').textContent=I18N.t('saving');
  try{ const r=await fetch(API+'/api/admin/limits',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json().catch(()=>({})); if(r.ok){ if(j.limits) lastLimits=j.limits; $('limits-msg').textContent=I18N.t('saved'); viewLimits(); } else $('limits-msg').textContent=j.error||I18N.t('failed'); }
  catch{ $('limits-msg').textContent=I18N.t('failed'); }
  refresh(); }
// --- buildable branches: which firmware branches the builder offers ---------
// The current selection rides along on admin stats, so the collapsed view stays live on the
// 10s poll for free. The repo's own branch list is a separate call made only when someone
// opens the card to edit, because that one costs a GitHub round-trip.
let lastBranches=null, editingBranches=false;
const fmtBranches=B=>(!B||!Array.isArray(B.enabled))?'…':B.enabled.map(r=>
  `<code>${esc(r)}</code>${r===B.default?` <span class="badge bg-secondary">${esc(I18N.t('branches_default'))}</span>`:''}`).join(' &nbsp;·&nbsp; ');
function renderBranches(B){ if(!B) return; lastBranches=B; if(!editingBranches) $('branches-view').innerHTML=fmtBranches(B); }
async function editBranches(){
  const B=lastBranches; if(!B) return;
  editingBranches=true; $('branches-msg').textContent='';
  $('branches-view').style.display='none'; $('branches-edit').style.display='none';
  $('branches-fields').style.display=''; $('branches-save').style.display=''; $('branches-cancel').style.display='';
  let d={};
  try{
    const r=await fetch(API+'/api/admin/branches',{headers:{Authorization:'Bearer '+tok()}});
    d=await r.json().catch(()=>({}));
    if(!r.ok) $('branches-msg').textContent=d.error||I18N.t('failed');
  }catch{ $('branches-msg').textContent=I18N.t('failed'); }
  const all=Array.isArray(d.all)?d.all:[];
  // An enabled branch that has since disappeared upstream still gets a row, flagged: it has
  // to be visible to be turned off, and it must not vanish from the save silently.
  const rows=[...new Set([...all,...B.enabled])];
  // Each row is boxed. Two columns side by side otherwise run the left row's "default"
  // radio straight into the right row's tick box, and the radio reads as belonging to the
  // branch next to it.
  $('branches-list').innerHTML=rows.map((r,i)=>
    '<div class="col-12 col-md-6"><div class="d-flex align-items-center gap-2 border rounded px-2 py-1">'
    +`<input type="checkbox" class="form-check-input br-on mt-0" id="br-on-${i}" value="${esc(r)}"${B.enabled.includes(r)?' checked':''}>`
    +`<label class="form-check-label flex-grow-1 text-truncate" for="br-on-${i}"><code>${esc(r)}</code>`
    +(all.length&&!all.includes(r)?` <span class="badge bg-warning text-dark">${esc(I18N.t('branches_missing'))}</span>`:'')
    +'</label>'
    +'<label class="small muted" style="white-space:nowrap">'
    +`<input type="radio" name="br-def" class="br-def" value="${esc(r)}"${r===B.default?' checked':''}> ${esc(I18N.t('branches_default'))}</label>`
    +'</div></div>').join('');
  $('branches-src').textContent=all.length?I18N.t('branches_src',{n:all.length,repo:d.repo||''}):'';
}
// Keep the two controls on a row agreeing: unticking the default moves it to the first
// branch still ticked (a default nobody can build is not a default), and marking a branch
// as the default enables it.
function syncBranchDefault(e){
  const t=e.target;
  if(t.classList.contains('br-def')){
    for(const c of document.querySelectorAll('.br-on')) if(c.value===t.value) c.checked=true;
    return;
  }
  if(!t.classList.contains('br-on')) return;
  const on=[...document.querySelectorAll('.br-on')].filter(x=>x.checked).map(x=>x.value);
  const def=document.querySelector('.br-def:checked');
  if(!def||on.indexOf(def.value)>=0) return;
  def.checked=false;
  if(on.length) for(const r of document.querySelectorAll('.br-def')) if(r.value===on[0]){ r.checked=true; break; }
}
function viewBranches(){ editingBranches=false;
  $('branches-view').style.display=''; $('branches-edit').style.display='';
  $('branches-fields').style.display='none'; $('branches-save').style.display='none'; $('branches-cancel').style.display='none';
  if(lastBranches) $('branches-view').innerHTML=fmtBranches(lastBranches); }
async function saveBranches(){
  const enabled=[...document.querySelectorAll('.br-on')].filter(x=>x.checked).map(x=>x.value);
  const sel=document.querySelector('.br-def:checked');
  if(!enabled.length){ $('branches-msg').textContent=I18N.t('branches_none'); return; }
  const body={enabled, default:(sel&&enabled.indexOf(sel.value)>=0)?sel.value:enabled[0]};
  $('branches-msg').textContent=I18N.t('saving');
  try{ const r=await fetch(API+'/api/admin/branches',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json().catch(()=>({}));
    if(r.ok){ lastBranches={enabled:j.enabled,default:j.default}; $('branches-msg').textContent=I18N.t('saved'); viewBranches(); }
    else $('branches-msg').textContent=j.error||I18N.t('failed'); }
  catch{ $('branches-msg').textContent=I18N.t('failed'); }
  refresh(); }
async function doUpdate(){
  const v=$('upd-btn').dataset.v||'';
  if(!confirm(I18N.t('confirm_update',{v:v?I18N.t('update_to_ver',{v:v}):''}))) return;
  $('upd-btn').disabled=true; $('upd-extra').textContent=I18N.t('requesting_update');
  try{ const r=await fetch(API+'/api/admin/update',{method:'POST',headers:{Authorization:'Bearer '+tok()}}); const j=await r.json().catch(()=>({})); $('upd-extra').textContent=r.ok?(j.status||I18N.t('update_requested')):(j.error||I18N.t('update_failed')); }
  catch{ $('upd-extra').textContent=I18N.t('update_failed'); }
  $('upd-btn').disabled=false;
}

// --- admin user management (master only) + invite enrollment ---
let usersShown=false, isMaster=false;
const PRIVS=['clear_logs','clear_builds','reset_limits','edit_limits','kill_switch','manage_users','edit_notice'];
const privCell=u=>isMaster?PRIVS.map(p=>`<label class="me-2 small" style="white-space:nowrap"><input type="checkbox" class="privbox" data-u="${esc(u.username)}" data-p="${p}" ${(u.privileges||[]).includes(p)?'checked':''}> ${I18N.t('priv_'+p)}</label>`).join(''):(u.privileges||[]).map(p=>`<span class="badge bg-secondary me-1">${esc(I18N.t('priv_'+p))}</span>`).join('');
async function renderUsers(){
  const r=await fetch(API+'/api/admin/users',{headers:{Authorization:'Bearer '+tok()}});
  if(!r.ok) return; const d=await r.json().catch(()=>({}));
  $('users-body').innerHTML=(d.users||[]).map(u=>`<tr><td><code>${esc(u.username)}</code></td><td>${u.invite_token?`<a href="#" class="show-invite" data-u="${esc(u.username)}" data-t="${esc(u.invite_token)}" data-e="${u.invite_expires||0}" title="${esc(I18N.t('title_show_invite'))}">${I18N.t('state_invited')}</a>`:esc(u.state)}</td><td class="muted">${u.last_login?ago(u.last_login):I18N.t('never')}</td><td>${privCell(u)}</td><td><a href="#" class="deluser text-danger small" data-u="${esc(u.username)}">${I18N.t('act_remove')}</a></td></tr>`).join('') || `<tr><td colspan="5" class="muted small">${I18N.t('no_users')}</td></tr>`;
  // Drop a shown invite link once its user is no longer a pending invite (removed / enrolled / expired).
  const il=$('invite-link'), shown=il.dataset.user;
  if(shown && !(d.users||[]).some(u=>u.username===shown&&u.invite_token)){ il.innerHTML=''; delete il.dataset.user; }
}
function showInviteLink(username, token, expires){
  const link=location.origin+location.pathname+'?invite='+token;
  const mins=expires?Math.max(0,Math.round((expires-Math.floor(Date.now()/1000))/60)):60;
  $('invite-link').innerHTML=I18N.t('invite_link_intro',{u:`<code>${esc(username)}</code>`,n:mins})+`<br><code style="word-break:break-all">${esc(link)}</code> <button class="btn btn-sm btn-outline-secondary ms-1" id="copy-invite">${I18N.t('copy_btn')}</button>`;
  $('invite-link').dataset.user=username;  // remember whose link is shown, so removing that user can clear it
  const cb=$('copy-invite'); if(cb) cb.onclick=()=>{ navigator.clipboard.writeText(link).then(()=>{cb.textContent=I18N.t('copied');}); };
}
async function invite(){
  const u=$('invite-user').value.trim().toLowerCase(); if(!u) return;
  $('invite-link').textContent=I18N.t('creating');
  const r=await fetch(API+'/api/admin/users',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({username:u})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.invite_token){ showInviteLink(d.username, d.invite_token, null); $('invite-user').value=''; renderUsers(); }
  else $('invite-link').innerHTML=`<span class="text-danger">${esc(d.error||I18N.t('failed'))}</span>`;
}
async function startEnroll(token){
  $('gate').style.display='none'; $('app').style.display='none'; $('enroll').style.display='';
  const r=await fetch(API+'/api/admin/invite/'+encodeURIComponent(token));
  const d=await r.json().catch(()=>({}));
  if(!r.ok){ $('enroll-msg').className='text-danger small mt-2'; $('enroll-msg').textContent=d.error||I18N.t('invalid_invite'); $('enroll-btn').disabled=true; return; }
  $('enroll-user').textContent=d.username; $('enroll-secret').textContent=d.secret;
  new QRCode($('enroll-qr'),{text:d.otpauth,width:168,height:168,correctLevel:QRCode.CorrectLevel.M});
  $('enroll-btn').onclick=()=>acceptInvite(token);
}
async function acceptInvite(token){
  const pw=$('enroll-pw').value, pw2=$('enroll-pw2').value, totp=$('enroll-totp').value.trim(), m=$('enroll-msg');
  if(pw.length<10){ m.className='text-danger small mt-2'; m.textContent=I18N.t('err_pw_short'); return; }
  if(pw!==pw2){ m.className='text-danger small mt-2'; m.textContent=I18N.t('err_pw_mismatch'); return; }
  m.className='small mt-2'; m.textContent=I18N.t('setting_up');
  const r=await fetch(API+'/api/admin/accept-invite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:pw,totp})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){ m.className='text-success small mt-2'; m.innerHTML=I18N.t('account_ready')+' <a href="'+esc(location.pathname)+'">'+I18N.t('signin_link')+'</a>'; $('enroll-btn').disabled=true; }
  else { m.className='text-danger small mt-2'; m.textContent=d.error||I18N.t('failed'); }
}
$('login').onclick=login;
$('master-toggle').onclick=e=>{ e.preventDefault(); setMaster(!masterMode); };
$('invite-btn').onclick=invite;
$('username').addEventListener('keydown',e=>{ if(e.key==='Enter') $('password').focus(); });
$('password').addEventListener('keydown',e=>{ if(e.key==='Enter') $('totp').focus(); });
$('token').addEventListener('keydown',e=>{ if(e.key==='Enter') $('totp').focus(); });
$('totp').addEventListener('keydown',e=>{ if(e.key==='Enter') login(); });
$('logout').onclick=logout;
$('kill-btn').onclick=toggle;
$('clearlogs-btn').onclick=clearLogs;
$('clearbuilds-btn').onclick=clearBuilds;
$('resetlimits-btn').onclick=resetLimits;
$('notice-post').onclick=()=>postNotice(false);
$('notice-clear').onclick=()=>postNotice(true);
$('limits-edit').onclick=editLimits;
$('limits-save').onclick=saveLimits;
$('limits-cancel').onclick=viewLimits;
$('branches-edit').onclick=editBranches;
$('branches-save').onclick=saveBranches;
$('branches-cancel').onclick=viewBranches;
$('branches-list').addEventListener('change',syncBranchDefault);
$('upd-btn').onclick=doUpdate;
// Expand/collapse one recent table to the full retention window (independent per table).
document.addEventListener('click',ev=>{ const x=ev.target.closest('.more-toggle'); if(!x) return; ev.preventDefault();
  const w=x.dataset.which; if(w in showAll){ showAll[w]=!showAll[w]; refresh(); } });
// Click an IP to toggle between the full address and its /64 (v4 /32) bucket.
document.addEventListener('click',ev=>{ const c=ev.target.closest('.ipc'); if(!c) return; const f=c.dataset.full; if(ipExpanded.has(f)) ipExpanded.delete(f); else ipExpanded.add(f); c.textContent=ipExpanded.has(f)?c.dataset.bucket:c.dataset.full; });
/* Confirm a destructive row action in a popover anchored to the link that was clicked, so
 * the pointer travels a few pixels instead of up to a browser confirm() at the top of the
 * window. Resolves true only if the action button is used; the x, a click elsewhere, Escape
 * and a second popover all resolve false. Only one is ever open (`cpop`), which is also what
 * holds off the 10s refresh: that rewrites the table, and the anchor with it. */
function closeConfirm(ok){ if(!cpop) return; const {el,done,off}=cpop; cpop=null; off(); el.remove(); done(ok); }
function askConfirm(anchor,message,actionLabel){
  closeConfirm(false);
  return new Promise(done=>{
    const el=document.createElement('div');
    el.className='cpop';
    el.innerHTML=`<div class="cpop-msg"></div>`+
                 `<div class="cpop-row"><button type="button" class="btn btn-sm btn-danger py-0 cpop-go"></button></div>`+
                 `<button type="button" class="cpop-x" aria-label="${esc(I18N.t('limits_cancel'))}">&times;</button>`;
    el.querySelector('.cpop-msg').textContent=message;       // admin-facing, but never as markup
    el.querySelector('.cpop-go').textContent=actionLabel;
    document.body.appendChild(el);

    // Sit under the anchor, or above it when there is no room below, and keep the arrow on
    // the anchor even after the box has been clamped inside the viewport.
    const place=()=>{
      const a=anchor.getBoundingClientRect(), b=el.getBoundingClientRect();
      const above=a.bottom+b.height+10>innerHeight && a.top-b.height-10>0;
      const cx=a.left+a.width/2;
      const left=Math.max(6,Math.min(cx-b.width/2,innerWidth-b.width-6));
      el.classList.toggle('above',above);
      el.style.left=left+'px';
      el.style.top=(above?a.top-b.height-6:a.bottom+6)+'px';
      el.style.setProperty('--cpop-arrow',Math.max(8,Math.min(cx-left,b.width-14))+'px');
    };
    place();
    const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); closeConfirm(false); } };
    // The click that opened this popover is still propagating, so ignore anything inside it
    // and let the current event finish before the outside-click listener starts to matter.
    const onDoc=e=>{ if(!el.contains(e.target)) closeConfirm(false); };
    const off=()=>{ removeEventListener('keydown',onKey); removeEventListener('scroll',place,true);
                    removeEventListener('resize',place); removeEventListener('click',onDoc,true); };
    cpop={el,done,off};
    addEventListener('keydown',onKey);
    addEventListener('scroll',place,true);
    addEventListener('resize',place);
    setTimeout(()=>{ if(cpop&&cpop.el===el) addEventListener('click',onDoc,true); },0);
    el.querySelector('.cpop-go').addEventListener('click',()=>closeConfirm(true));
    el.querySelector('.cpop-x').addEventListener('click',()=>closeConfirm(false));
    el.querySelector('.cpop-go').focus();
  });
}
// Per-build admin action: cancel (active) or remove artifact+run (finished).
document.addEventListener('click',async ev=>{ const x=ev.target.closest('.bact'); if(!x) return; ev.preventDefault();
  const act=x.dataset.act, id=x.dataset.id, cancel=act==='cancel';
  const ok=await askConfirm(x,
    I18N.t(cancel?'confirm_cancel_build':'confirm_remove_build',{id:id.slice(0,8)}),
    I18N.t(cancel?'title_cancel_build':'act_remove'));
  if(!ok) return;
  try{ await fetch(API+'/api/admin/'+(cancel?'cancel':'expire')+'/'+id,{method:'POST',headers:{Authorization:'Bearer '+tok()}}); }catch{}
  refresh(); });
// Remove an admin user (master only).
document.addEventListener('click',async ev=>{ const x=ev.target.closest('.deluser'); if(!x) return; ev.preventDefault();
  const u=x.dataset.u; if(!confirm(I18N.t('confirm_remove_user',{u:u}))) return;
  await fetch(API+'/api/admin/users/'+encodeURIComponent(u),{method:'DELETE',headers:{Authorization:'Bearer '+tok()}});
  const il=$('invite-link'); if(il.dataset.user===u){ il.innerHTML=''; delete il.dataset.user; }  // drop the shown link if it was this user's
  renderUsers(); });
// Click a pending "invited" admin to re-show its (still-valid) invite link.
document.addEventListener('click',ev=>{ const x=ev.target.closest('.show-invite'); if(!x) return; ev.preventDefault();
  showInviteLink(x.dataset.u, x.dataset.t, parseInt(x.dataset.e,10)||0); });
// Toggle a per-admin privilege (master only): gather that user's checked boxes and save the set.
document.addEventListener('change',async ev=>{ const x=ev.target.closest('.privbox'); if(!x) return;
  const u=x.dataset.u;
  const privileges=[...document.querySelectorAll('.privbox')].filter(b=>b.dataset.u===u&&b.checked).map(b=>b.dataset.p);
  await fetch(API+'/api/admin/users/'+encodeURIComponent(u)+'/privileges',{method:'POST',headers:{Authorization:'Bearer '+tok(),'content-type':'application/json'},body:JSON.stringify({privileges})});
  renderUsers(); });
I18N.apply();
I18N.selector('lang-slot');
// On a language switch: re-apply static text everywhere, restore the gate hint/toggle for the
// current mode, and re-render the live app sections (kill/version/tiles/builds/events/limits + users).
window.addEventListener('i18nchange',function(){
  I18N.apply();
  setMaster(masterMode);
  if($('app').style.display!=='none'){ refresh(); if(usersShown) renderUsers(); }
});
// Footer version on the gate/enroll screens too, so the login page shows it like the
// signed-in footer does. Those screens never call the authed admin stats, so read it from
// the public /api/stats. Skipped once the app is up, where refresh() owns the footer
// version (and on the VPS backend deliberately blanks it in favour of the version card).
async function gateVersion(){
  if($('app').style.display!=='none') return;
  try{ const r=await fetch(API+'/api/stats'); const d=await r.json(); if(d&&d.version&&$('app').style.display==='none') $('admin-ver').textContent=d.version; }catch(_){}
}
const inviteParam=new URLSearchParams(location.search).get('invite');
if(inviteParam){ startEnroll(inviteParam); }
else if(tok()&&!idledOut()){ adminGet().then(show).catch(e=>{ if(e&&e.auth) localStorage.removeItem(TK); else show(); }); }
gateVersion();
// Poll gently: 10s, and not at all while the tab is hidden (idle background admin tabs
// were burning the free request quota); refresh immediately when the tab comes back.
// An open confirm popover holds the poll off: refreshing would rewrite the table under it.
setInterval(()=>{ if(document.hidden||cpop) return; if($('app').style.display!=='none'&&!idledOut()) refresh(); },10000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&$('app').style.display!=='none'&&!idledOut()) refresh(); });
