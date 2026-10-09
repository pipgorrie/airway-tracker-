/*
 * Optional sync across devices through the user's OWN Google Drive.
 *
 * - Each person signs in with their own Google account; the data goes into one file in
 *   their Drive. The site owner never receives or stores anyone's data.
 * - The file is end-to-end encrypted (AES-GCM, key derived from a passphrase with PBKDF2),
 *   so Google can't read it either. The passphrase never leaves the device.
 * - Changes from several devices are merged record by record (3-way merge against the
 *   last synced copy), so readings logged offline on a phone and a laptop both survive.
 * - Uses the drive.file scope: the app can only see files it created itself.
 *
 * Setup: create an OAuth client in Google Cloud (see README) and paste its client ID below.
 * While it's empty, the sync section doesn't appear in Settings.
 */
const GOOGLE_CLIENT_ID = '';

const DRIVE_FILE_NAME = 'Airway Tracker – encrypted sync.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SYNC_FORMAT = 'airway-tracker-sync';
const PBKDF2_ITERATIONS = 600000;
const SYNC_COLLECTIONS = ['peakFlow','oxygen','symptoms','surgeries','silsi','treatments','events','allergies','documents'];
// per-device display preferences — never overwritten by another device
const DEVICE_ONLY_SETTINGS = ['accessibility','chartView','pfRange','lastAutoBackup'];
const DRIVE_CFG_KEY = 'airway-tracker:drive';

let driveToken = null;          // {access_token, expires_at}
let driveTokenClient = null;
let driveSyncing = false;
let driveSyncTimer = null;
let driveStatus = 'off';        // 'off' | 'ready' | 'needs-signin' | 'syncing' | 'error'
let driveError = '';

const syncEnabled = () => !!GOOGLE_CLIENT_ID;
function driveCfg(){ try{ return JSON.parse(localStorage.getItem(DRIVE_CFG_KEY)||'null'); }catch(e){ return null; } }
function setDriveCfg(c){ try{ c ? localStorage.setItem(DRIVE_CFG_KEY, JSON.stringify(c)) : localStorage.removeItem(DRIVE_CFG_KEY); }catch(e){} }
function driveLastSyncAt(){ return driveCfg()?.lastSyncAt || null; }

/* ---------- small IndexedDB store: encryption key + last-synced copy ---------- */
function syncDB(mode, fn){
  return new Promise((resolve, reject)=>{
    const open = indexedDB.open('airway-tracker-sync', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const kvGet = k => syncDB('readonly', s=>s.get(k));
const kvSet = (k,v) => syncDB('readwrite', s=>s.put(v,k));
const kvDel = k => syncDB('readwrite', s=>s.delete(k));

/* ---------- encryption ---------- */
const b64 = buf => { const b = new Uint8Array(buf); let s=''; for(let i=0;i<b.length;i+=0x8000) s += String.fromCharCode.apply(null, b.subarray(i,i+0x8000)); return btoa(s); };
const unb64 = str => Uint8Array.from(atob(str), c=>c.charCodeAt(0));
async function deriveKey(passphrase, salt){
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:PBKDF2_ITERATIONS, hash:'SHA-256'},
    base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']); // non-extractable
}
async function encryptPayload(obj, key, salt){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj)));
  return {format:SYNC_FORMAT, v:1, kdf:'PBKDF2-SHA256', iterations:PBKDF2_ITERATIONS, salt:b64(salt), iv:b64(iv), ct:b64(ct), savedAt:new Date().toISOString()};
}
async function decryptPayload(file, key){
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(file.iv)}, key, unb64(file.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------- Google sign-in (Google Identity Services, token flow) ---------- */
function loadGoogleScript(){
  if(window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve; s.onerror = () => reject(new Error("Couldn't reach Google — check your connection"));
    document.head.appendChild(s);
  });
}
function tokenValid(){ return driveToken && driveToken.expires_at > Date.now() + 60000; }
// must be called from a tap/click — opens Google's sign-in popup
async function driveSignIn(promptMode){
  await loadGoogleScript();
  return new Promise((resolve, reject)=>{
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: resp => {
        if(resp.error){ reject(new Error(resp.error_description || resp.error)); return; }
        driveToken = {access_token:resp.access_token, expires_at:Date.now() + (resp.expires_in||3600)*1000};
        try{ sessionStorage.setItem('airway-tracker:driveToken', JSON.stringify(driveToken)); }catch(e){}
        resolve();
      },
      error_callback: err => reject(new Error(err.type==='popup_closed' ? 'Sign-in was cancelled' : (err.message||'Sign-in failed'))),
    });
    driveTokenClient.requestAccessToken({prompt: promptMode ?? ''});
  });
}

/* ---------- Drive file access ---------- */
async function driveFetch(url, opts={}){
  const res = await fetch(url, {...opts, headers:{...(opts.headers||{}), Authorization:'Bearer '+driveToken.access_token}});
  if(res.status===401){ driveToken = null; throw new Error('signin'); }
  if(!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return res;
}
async function driveFindFile(){
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME.replace(/'/g,"\\'")}' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  return (await res.json()).files?.[0] || null;
}
async function driveDownload(fileId){
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return res.json();
}
async function driveUpload(payload, fileId){
  const body = JSON.stringify(payload);
  if(fileId){
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body});
    return fileId;
  }
  const boundary = 'airway' + Math.random().toString(36).slice(2);
  const meta = {name:DRIVE_FILE_NAME, mimeType:'application/json', description:'Encrypted data from the Airway stenosis tracker. Only readable in the app with your sync passphrase.'};
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {method:'POST', headers:{'Content-Type':`multipart/related; boundary=${boundary}`}, body:multipart});
  return (await res.json()).id;
}

/* ---------- merging ---------- */
// what gets synced: every record plus shared settings/care info, minus per-device preferences
function syncableState(s){
  const out = {};
  SYNC_COLLECTIONS.forEach(c=>{ out[c] = s[c] || []; });
  out.careInfo = s.careInfo || {};
  out.settings = {...(s.settings||{})};
  DEVICE_ONLY_SETTINGS.forEach(k=>delete out.settings[k]);
  return JSON.parse(JSON.stringify(out));
}
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
// 3-way merge: base = last copy both sides agreed on. A change on either side wins over
// an unchanged side; if both changed the same record, this device's version wins.
function mergeStates(base, local, remote){
  base = base || {};
  const out = {};
  SYNC_COLLECTIONS.forEach(c=>{
    const B = new Map((base[c]||[]).map(r=>[r.id,r]));
    const L = new Map((local[c]||[]).map(r=>[r.id,r]));
    const R = new Map((remote[c]||[]).map(r=>[r.id,r]));
    const ids = new Set([...L.keys(), ...R.keys()]);
    const merged = [];
    ids.forEach(id=>{
      const inB = B.has(id), l = L.get(id), r = R.get(id);
      if(l && r) merged.push(inB && same(l, B.get(id)) ? r : l);
      else if(l){ if(!inB || !same(l, B.get(id))) merged.push(l); }   // remote deleted an unchanged record → drop
      else if(r){ if(!inB || !same(r, B.get(id))) merged.push(r); }   // local deleted an unchanged record → drop
    });
    out[c] = merged;
  });
  ['careInfo','settings'].forEach(obj=>{
    const b = base[obj]||{}, l = local[obj]||{}, r = remote[obj]||{};
    out[obj] = {};
    new Set([...Object.keys(l), ...Object.keys(r)]).forEach(k=>{
      out[obj][k] = (k in l) && !same(l[k], b[k]) ? l[k] : (k in r ? r[k] : l[k]);
    });
  });
  // keep the usual orderings
  const t = r => new Date(r.date || (r.start ? r.start+'T00:00' : 0)).getTime();
  ['peakFlow','oxygen','surgeries','silsi','events','symptoms'].forEach(c=>out[c].sort((a,b)=>t(a)-t(b)));
  out.treatments.sort((a,b)=>t(b)-t(a));
  return out;
}
function applySyncedState(merged){
  const device = {};
  DEVICE_ONLY_SETTINGS.forEach(k=>{ if(k in state.settings) device[k] = state.settings[k]; });
  SYNC_COLLECTIONS.forEach(c=>{ state[c] = merged[c]; });
  state.careInfo = Object.assign(defaultCareInfo(), merged.careInfo);
  state.settings = Object.assign(defaultSettings(), merged.settings, device);
}

/* ---------- sync ---------- */
async function syncNow({interactive=false}={}){
  const cfg = driveCfg();
  if(!cfg || driveSyncing) return;
  if(!navigator.onLine){ driveStatus='ready'; refreshDriveUI(); return; }
  const key = await kvGet('key');
  if(!key){ driveStatus='error'; driveError='This device needs your sync passphrase again — disconnect and reconnect.'; refreshDriveUI(); return; }
  if(!tokenValid()){
    if(!interactive){ driveStatus='needs-signin'; refreshDriveUI(); return; }
    try{ await driveSignIn(''); }catch(e){ driveStatus='needs-signin'; driveError=e.message; refreshDriveUI(); return; }
  }
  driveSyncing = true; driveStatus='syncing'; driveError=''; refreshDriveUI();
  try{
    const base = await kvGet('base');
    let remote = null, fileId = cfg.fileId;
    let file = fileId ? await driveDownload(fileId).catch(()=>null) : null;
    if(!file){ const f = await driveFindFile(); if(f){ fileId = f.id; file = await driveDownload(fileId); } }
    if(file){
      try{ remote = (await decryptPayload(file, key)).data; }
      catch(e){ throw new Error("The file in Google Drive was saved with a different passphrase. Disconnect, then reconnect with the passphrase used on your other device."); }
    }
    const local = syncableState(state);
    const merged = remote ? mergeStates(base, local, remote) : local;
    if(!same(merged, local)){
      applySyncedState(merged);
      await _saveStateForSync();
      renderAll();
    }
    if(!remote || !same(merged, remote)){
      const payload = await encryptPayload({data:merged}, key, unb64(cfg.salt));
      fileId = await driveUpload(payload, fileId);
    }
    await kvSet('base', merged);
    setDriveCfg({...cfg, fileId, lastSyncAt:new Date().toISOString()});
    driveStatus = 'ready';
  }catch(e){
    if(e.message==='signin'){ driveStatus='needs-signin'; }
    else{ driveStatus='error'; driveError=e.message; console.error('sync failed', e); }
  }finally{
    driveSyncing = false;
    refreshDriveUI();
  }
}
function scheduleDriveSync(){
  if(!driveCfg() || !tokenValid()) { if(driveCfg() && driveStatus!=='needs-signin'){ driveStatus='needs-signin'; refreshDriveUI(); } return; }
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(()=>syncNow(), 4000);
}

/* ---------- connect / disconnect ---------- */
async function connectDrive(){
  try{
    driveStatus='syncing'; refreshDriveUI();
    await driveSignIn('consent');
    const existing = await driveFindFile();
    if(existing){
      const file = await driveDownload(existing.id);
      if(file.format!==SYNC_FORMAT) throw new Error('Unexpected file in Google Drive');
      askPassphrase({existing:true, onSubmit: async pass=>{
        const salt = unb64(file.salt);
        const key = await deriveKey(pass, salt);
        try{ await decryptPayload(file, key); }catch(e){ return 'That passphrase doesn\'t match the one used on your other device.'; }
        await finishConnect(key, file.salt, existing.id);
      }});
    }else{
      askPassphrase({existing:false, onSubmit: async pass=>{
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(pass, salt);
        await finishConnect(key, b64(salt), null);
      }});
    }
  }catch(e){
    driveStatus = 'off'; refreshDriveUI();
    toast(e.message || 'Could not connect to Google Drive');
  }
}
async function finishConnect(key, saltB64, fileId){
  await kvSet('key', key);
  await kvDel('base'); // first sync: union of this device and Drive
  setDriveCfg({salt:saltB64, fileId, lastSyncAt:null});
  closeModal();
  await syncNow({interactive:true});
  if(driveStatus==='ready'){ toast('Syncing with Google Drive'); markBackedUp(); }
  openSettings();
}
function askPassphrase({existing, onSubmit}){
  renderModal(`
    <div class="modal-head"><h2>${existing ? 'Enter your sync passphrase' : 'Create a sync passphrase'}</h2><button class="modal-close" onclick="closeModal();driveStatus='off';refreshDriveUI();">✕</button></div>
    <p style="font-size:13px;line-height:1.5;margin-bottom:12px;">${existing
      ? 'Your data is already in Google Drive from another device. Enter the passphrase you chose there.'
      : 'Your data is encrypted with this passphrase before it goes to Google Drive — not even Google can read it. You\'ll need it on each device you sync.'}</p>
    ${existing ? '' : `<p style="font-size:12.5px;color:var(--sev4);line-height:1.5;margin-bottom:12px;"><strong>Write it down somewhere safe.</strong> If it's forgotten, the synced copy can't be unlocked (the data on your devices is unaffected).</p>`}
    <div class="field"><label class="field-label">Passphrase</label><input type="password" id="syncPass" autocomplete="new-password" placeholder="At least 8 characters"></div>
    ${existing ? '' : `<div class="field"><label class="field-label">Type it again</label><input type="password" id="syncPass2" autocomplete="new-password"></div>`}
    <div id="syncPassErr" style="color:var(--sev4);font-size:13px;margin-bottom:10px;"></div>
    <button class="btn btn-primary" id="syncPassBtn">${existing ? 'Unlock and sync' : 'Start syncing'}</button>`);
  const btn = document.getElementById('syncPassBtn');
  btn.onclick = async ()=>{
    const p = document.getElementById('syncPass').value;
    const err = document.getElementById('syncPassErr');
    if(p.length<8){ err.textContent = 'Use at least 8 characters.'; return; }
    if(!existing && p!==document.getElementById('syncPass2').value){ err.textContent = "The two passphrases don't match."; return; }
    btn.disabled = true; btn.textContent = 'Working…';
    const msg = await onSubmit(p);
    if(msg){ err.textContent = msg; btn.disabled = false; btn.textContent = existing ? 'Unlock and sync' : 'Start syncing'; }
  };
}
async function disconnectDrive(){
  if(!confirm('Stop syncing this device? Your data stays on this device and in Google Drive.')) return;
  if(driveToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(driveToken.access_token, ()=>{});
  driveToken = null;
  try{ sessionStorage.removeItem('airway-tracker:driveToken'); }catch(e){}
  await kvDel('key'); await kvDel('base');
  setDriveCfg(null);
  driveStatus = 'off';
  refreshDriveUI();
  toast('Sync turned off on this device');
}

/* ---------- UI ---------- */
function driveSettingsHtml(){
  if(!syncEnabled()) return '';
  const cfg = driveCfg();
  let body;
  if(!cfg){
    body = `
      <p style="font-size:12.5px;color:var(--ink-faint);margin-bottom:10px;line-height:1.5;">Use the app on your phone and any computer. Your data is encrypted with a passphrase only you know, then saved to <strong>your own</strong> Google Drive — no one else, including Google and the app's creator, can read it.</p>
      <button class="btn btn-outline" onclick="connectDrive()" ${driveStatus==='syncing'?'disabled':''}>${driveStatus==='syncing'?'Connecting…':'🔒 Sync with Google Drive'}</button>`;
  }else{
    const last = cfg.lastSyncAt ? new Date(cfg.lastSyncAt).toLocaleString() : 'not yet';
    const status = {
      ready: `✅ Synced — last ${escapeHtml(last)}`,
      syncing: '🔄 Syncing…',
      'needs-signin': '⏸ Tap “Sync now” to sign in to Google again',
      error: `⚠️ ${escapeHtml(driveError || 'Sync failed')}`,
      off: `Last synced ${escapeHtml(last)}`,
    }[driveStatus] || '';
    body = `
      <p style="font-size:13px;line-height:1.5;margin-bottom:8px;">${status}</p>
      <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="syncNow({interactive:true})" ${driveStatus==='syncing'?'disabled':''}>Sync now</button><button class="btn btn-outline btn-sm" onclick="disconnectDrive()">Turn off</button></div>
      <p style="font-size:12px;color:var(--ink-faint);margin-top:8px;line-height:1.5;">Syncs automatically after each change while signed in. Uploaded document files stay on the device they were added on (their thumbnails sync).</p>`;
  }
  return `<h2 style="margin-bottom:4px;">Sync across devices</h2><div id="driveSettings" style="margin-bottom:18px;">${body}</div>`;
}
function refreshDriveUI(){
  const el = document.getElementById('driveSettings');
  if(el){ const tmp = document.createElement('div'); tmp.innerHTML = driveSettingsHtml(); el.replaceWith(tmp.querySelector('#driveSettings')); }
  renderDriveBanner();
}
// one-tap banner on Home when this device is set up to sync but the Google sign-in has lapsed
function renderDriveBanner(){
  const host = document.getElementById('todayBanners');
  if(!host) return;
  let el = document.getElementById('driveBanner');
  if(!el){ el = document.createElement('div'); el.id = 'driveBanner'; host.parentNode.insertBefore(el, host); }
  const show = syncEnabled() && driveCfg() && (driveStatus==='needs-signin' || driveStatus==='error');
  el.innerHTML = show ? `
    <div class="banner reminder" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <div><div class="banner-title">${driveStatus==='error'?'⚠️ Sync problem':'🔄 Sync with Google Drive'}</div><div style="font-size:12.5px;color:var(--ink-soft);">${driveStatus==='error'?escapeHtml(driveError):'Tap to sign in and bring this device up to date.'}</div></div>
      <button class="btn btn-primary btn-sm" onclick="syncNow({interactive:true})">Sync now</button>
    </div>` : '';
}

/* ---------- hooks ---------- */
// "Delete all data" only means this device: stop syncing first so the deletions
// aren't copied to Google Drive (and from there to the person's other devices)
const _clearDataOriginal = clearData;
clearData = async function(){
  if(driveCfg()){
    driveToken = null;
    try{ sessionStorage.removeItem('airway-tracker:driveToken'); }catch(e){}
    await kvDel('key'); await kvDel('base');
    setDriveCfg(null);
    driveStatus = 'off';
  }
  _clearDataOriginal();
};
const _saveStateForSync = saveState;   // the save chain before sync (storage + auto backup)
saveState = async function(){
  await _saveStateForSync();
  if(syncEnabled()) scheduleDriveSync();
};
if(syncEnabled()){
  try{ driveToken = JSON.parse(sessionStorage.getItem('airway-tracker:driveToken')||'null'); }catch(e){}
  const startSync = () => {
    if(!driveCfg()) return;
    if(tokenValid()) syncNow(); else { driveStatus='needs-signin'; refreshDriveUI(); }
  };
  // wait for the app's data to load before the first sync
  const waitLoaded = setInterval(()=>{ if(stateLoaded){ clearInterval(waitLoaded); startSync(); } }, 200);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && driveCfg() && tokenValid()) syncNow(); });
  window.addEventListener('online', ()=>{ if(driveCfg() && tokenValid()) syncNow(); });
}
