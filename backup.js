/*
 * Backup, restore, automatic file backup, and CSV import.
 * Loaded after the main app script — uses its globals (state, saveState, renderAll, toast, ...).
 */

/* ============ FULL BACKUP / RESTORE ============ */
const BACKUP_APP_ID = 'airway-tracker';
const BACKUP_VERSION = 1;

// everything needed to rebuild the app on another device: the main state plus each
// document's full-size file, which is stored under its own key
async function buildBackup(){
  const docImages = {};
  for(const d of state.documents){
    try{
      const res = await window.storage.get('docimg:'+d.id);
      if(res && res.value) docImages[d.id] = res.value;
    }catch(e){ /* missing image — thumbnail still travels in state */ }
  }
  return {app:BACKUP_APP_ID, version:BACKUP_VERSION, savedAt:new Date().toISOString(), state, docImages};
}
function backupFileName(){
  return `airway-tracker-backup-${new Date().toISOString().slice(0,10)}.json`;
}
function downloadFile(name, text, type){
  const blob = new Blob([text], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
async function downloadBackup(){
  const backup = await buildBackup();
  downloadFile(backupFileName(), JSON.stringify(backup), 'application/json');
  markBackedUp();
  toast('Backup downloaded');
}

function chooseRestoreFile(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = () => input.files[0] && restoreFromFile(input.files[0]);
  input.click();
}
async function restoreFromFile(file){
  let backup;
  try{ backup = JSON.parse(await file.text()); }
  catch(e){ toast("That file isn't a valid backup"); return; }
  if(!backup || backup.app!==BACKUP_APP_ID || !backup.state){ toast("That file isn't an Airway Tracker backup"); return; }
  const s = backup.state;
  const count = (s.peakFlow||[]).length;
  const when = backup.savedAt ? new Date(backup.savedAt).toLocaleString() : 'an unknown date';
  renderModal(`
    <div class="modal-head"><h2>Restore backup?</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:14px;line-height:1.5;margin-bottom:10px;">This backup was saved on <strong>${escapeHtml(when)}</strong> and has <strong>${count}</strong> PEF reading${count===1?'':'s'}, ${(s.surgeries||[]).length} surgeries, ${(s.silsi||[]).length} SILSI and ${(s.documents||[]).length} documents.</p>
    <p style="font-size:13px;color:var(--sev4);line-height:1.5;margin-bottom:16px;">Restoring <strong>replaces everything</strong> currently in the app on this device. Download a backup first if you might want the current data.</p>
    <div class="stack">
      <button class="btn btn-outline" onclick="downloadBackup()">Download a backup of current data first</button>
      <button class="btn btn-primary" id="confirmRestoreBtn">Replace with this backup</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  document.getElementById('confirmRestoreBtn').onclick = () => applyBackup(backup);
}
async function applyBackup(backup){
  const s = backup.state;
  // keep this device's display preferences; take everything else from the backup
  const accessibility = state.settings.accessibility;
  state = Object.assign({peakFlow:[], oxygen:[], symptoms:[], surgeries:[], silsi:[], treatments:[], events:[], allergies:[], documents:[]}, s);
  state.settings = Object.assign(defaultSettings(), s.settings||{}, {accessibility});
  state.careInfo = Object.assign(defaultCareInfo(), s.careInfo||{});
  // clear old document files, then write the backup's
  try{
    const {keys} = await window.storage.list('docimg:');
    for(const k of keys) await window.storage.delete(k);
  }catch(e){}
  let failedDocs = 0;
  for(const [id, data] of Object.entries(backup.docImages||{})){
    try{ await window.storage.set('docimg:'+id, data); }catch(e){ failedDocs++; }
  }
  await saveState();
  closeModal(); renderAll();
  toast(failedDocs ? `Restored — ${failedDocs} document file(s) didn't fit in storage` : 'Backup restored');
}

/* ============ AUTOMATIC BACKUP TO A FILE (e.g. on the Desktop) ============ */
// Uses the File System Access API (Chrome/Edge on Mac, Windows, Linux, ChromeOS).
// The chosen file's handle is kept in IndexedDB so it survives reloads; the browser
// asks once per visit to allow writing again.
const autoBackupSupported = 'showSaveFilePicker' in window;
let autoBackupHandle = null;
let autoBackupStatus = 'off'; // 'off' | 'on' | 'paused' (needs a tap to re-allow) | 'error'
let autoBackupTimer = null;

function idbHandleStore(mode, fn){
  return new Promise((resolve, reject)=>{
    const open = indexedDB.open('airway-tracker-files', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', mode);
      const req = fn(tx.objectStore('handles'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
async function initAutoBackup(){
  if(!autoBackupSupported) return;
  try{ autoBackupHandle = await idbHandleStore('readonly', s=>s.get('autoBackup')); }catch(e){}
  if(!autoBackupHandle) return;
  const perm = await autoBackupHandle.queryPermission({mode:'readwrite'});
  autoBackupStatus = perm==='granted' ? 'on' : 'paused';
  renderAutoBackupBanner();
}
async function chooseAutoBackupFile(){
  try{
    // CSV (opens in Excel/Numbers/Sheets) is offered first; a .json file keeps a full,
    // restorable backup instead. The format follows the extension of the file picked.
    autoBackupHandle = await window.showSaveFilePicker({
      suggestedName:'airway-tracker-data.csv', startIn:'desktop',
      types:[
        {description:'CSV spreadsheet (opens in Excel)', accept:{'text/csv':['.csv']}},
        {description:'Full backup (can be restored)', accept:{'application/json':['.json']}},
      ],
    });
  }catch(e){ return; } // cancelled
  await idbHandleStore('readwrite', s=>s.put(autoBackupHandle, 'autoBackup'));
  autoBackupStatus = 'on';
  await writeAutoBackup();
  refreshAutoBackupUI();
  toast(`Automatic backup on — saving to ${autoBackupHandle.name}`);
}
async function resumeAutoBackup(){
  if(!autoBackupHandle) return;
  const perm = await autoBackupHandle.requestPermission({mode:'readwrite'});
  if(perm!=='granted'){ toast('Automatic backup still paused'); return; }
  autoBackupStatus = 'on';
  await writeAutoBackup();
  refreshAutoBackupUI();
  toast('Automatic backup resumed');
}
async function stopAutoBackup(){
  autoBackupHandle = null;
  autoBackupStatus = 'off';
  try{ await idbHandleStore('readwrite', s=>s.delete('autoBackup')); }catch(e){}
  refreshAutoBackupUI();
  toast('Automatic backup off');
}
function autoBackupIsCSV(){ return !!autoBackupHandle && /\.csv$/i.test(autoBackupHandle.name); }
async function writeAutoBackup(){
  if(!autoBackupHandle || autoBackupStatus!=='on') return;
  try{
    const w = await autoBackupHandle.createWritable();
    await w.write(autoBackupIsCSV() ? '\ufeff'+buildDataCSV() : JSON.stringify(await buildBackup()));
    await w.close();
    state.settings.lastAutoBackup = new Date().toISOString();
    if(!autoBackupIsCSV()) markBackedUp(); // a CSV can't be restored, so it doesn't count as a backup
  }catch(e){
    console.error('auto backup failed', e);
    autoBackupStatus = 'error';
    refreshAutoBackupUI();
  }
}
// called after every save — waits for a quiet moment so rapid edits write once
function scheduleAutoBackup(){
  if(autoBackupStatus!=='on') return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(writeAutoBackup, 1500);
}
function autoBackupSettingsHtml(){
  if(!autoBackupSupported){
    return `<p style="font-size:12.5px;color:var(--ink-faint);line-height:1.5;">Automatic backup to a file works in <strong>Chrome</strong> or <strong>Edge</strong> on a computer (Mac, Windows/HP, Chromebook). In this browser, use <strong>Download backup</strong> instead.</p>`;
  }
  const name = autoBackupHandle ? escapeHtml(autoBackupHandle.name) : '';
  const last = state.settings.lastAutoBackup ? new Date(state.settings.lastAutoBackup).toLocaleString() : null;
  if(autoBackupStatus==='on') return `
    <p style="font-size:13px;line-height:1.5;margin-bottom:8px;">✅ Saving automatically to <strong>${name}</strong> after every change.${autoBackupIsCSV()?`<br><span style="color:var(--ink-faint);font-size:12px;">CSV opens in Excel but can't be restored into the app — use Download backup now and then for a full copy.</span>`:''}${last?`<br><span style="color:var(--ink-faint);font-size:12px;">Last saved ${escapeHtml(last)}</span>`:''}</p>
    <div class="btn-row"><button class="btn btn-outline btn-sm" onclick="chooseAutoBackupFile()">Change file</button><button class="btn btn-outline btn-sm" onclick="stopAutoBackup()">Turn off</button></div>`;
  if(autoBackupStatus==='paused' || autoBackupStatus==='error') return `
    <p style="font-size:13px;line-height:1.5;margin-bottom:8px;">⏸ Automatic backup to <strong>${name}</strong> is paused — your browser needs permission again${autoBackupStatus==='error'?' (the last save failed)':''}.</p>
    <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="resumeAutoBackup()">Resume</button><button class="btn btn-outline btn-sm" onclick="stopAutoBackup()">Turn off</button></div>`;
  return `
    <p style="font-size:12.5px;color:var(--ink-faint);line-height:1.5;margin-bottom:8px;">Pick a file (e.g. on your Desktop) and the app will keep it up to date after every change. Choose <strong>CSV</strong> to open it in Excel, or <strong>Full backup (.json)</strong> to be able to restore from it.</p>
    <button class="btn btn-outline" onclick="chooseAutoBackupFile()">Choose backup file…</button>`;
}
function refreshAutoBackupUI(){
  const el = document.getElementById('autoBackupSettings');
  if(el) el.innerHTML = autoBackupSettingsHtml();
  renderAutoBackupBanner();
}
// small banner on Home when a backup file is set up but the browser needs a tap to allow writing
function renderAutoBackupBanner(){
  let el = document.getElementById('autoBackupBanner');
  if(!el){
    const host = document.getElementById('todayBanners');
    if(!host) return;
    el = document.createElement('div');
    el.id = 'autoBackupBanner';
    host.parentNode.insertBefore(el, host);
  }
  el.innerHTML = (autoBackupStatus==='paused' || autoBackupStatus==='error') ? `
    <div class="banner reminder" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <div><div class="banner-title">Automatic backup paused</div><div style="font-size:12.5px;color:var(--ink-soft);">Tap resume to keep saving to ${escapeHtml(autoBackupHandle?.name||'your backup file')}.</div></div>
      <button class="btn btn-primary btn-sm" onclick="resumeAutoBackup()">Resume</button>
    </div>` : '';
}

/* ============ CSV IMPORT (another app's export) ============ */
let csvImport = null; // {rows, headers, fileName}

function parseCSV(text){
  // RFC-4180-ish: handles quoted fields, escaped quotes, commas/newlines in quotes, ; or tab delimiters
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',',';','\t'].sort((a,b)=>firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let field = ''; let q = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else q = false; }
      else field += c;
    }else if(c==='"') q = true;
    else if(c===delim){ row.push(field); field=''; }
    else if(c==='\n' || c==='\r'){
      if(c==='\r' && text[i+1]==='\n') i++;
      row.push(field); field='';
      if(row.some(f=>f.trim()!=='')) rows.push(row);
      row = [];
    }else field += c;
  }
  row.push(field);
  if(row.some(f=>f.trim()!=='')) rows.push(row);
  return rows;
}
function chooseCSVFile(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv,.txt';
  input.onchange = async () => {
    const file = input.files[0];
    if(!file) return;
    const rows = parseCSV(await file.text());
    if(rows.length<2){ toast("Couldn't find any rows in that file"); return; }
    // header = first row with at least two non-numeric cells
    const headerIdx = Math.max(0, rows.findIndex(r=>r.filter(c=>c.trim() && isNaN(Number(c))).length>=2));
    csvImport = {fileName:file.name, headers:rows[headerIdx].map((h,i)=>h.trim()||`Column ${i+1}`), rows:rows.slice(headerIdx+1)};
    openCSVMappingModal();
  };
  input.click();
}
// best guess at which column holds what, from the header names
function guessColumn(headers, patterns){
  const i = headers.findIndex(h=>patterns.some(p=>p.test(h)));
  return i;
}
function openCSVMappingModal(){
  const {headers, rows, fileName} = csvImport;
  const g = {
    date: guessColumn(headers, [/date/i, /^time ?stamp/i, /^when/i, /^day/i]),
    time: guessColumn(headers, [/^time$/i, /^time\b(?!stamp)/i, /hour/i]),
    pef:  guessColumn(headers, [/pef/i, /peak/i, /flow/i, /l\/min/i, /reading/i, /value/i]),
    spo2: guessColumn(headers, [/spo2|sp o2|o2|oxygen|saturation/i]),
    note: guessColumn(headers, [/note|comment|remark|description/i]),
  };
  if(g.time===g.date) g.time = -1;
  const opts = (sel, optional) => (optional?`<option value="-1">— none —</option>`:'') +
    headers.map((h,i)=>`<option value="${i}" ${i===sel?'selected':''}>${escapeHtml(h)}</option>`).join('');
  const sample = rows.slice(0,3);
  renderModal(`
    <div class="modal-head"><h2>Import from CSV</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
    <p style="font-size:12.5px;color:var(--ink-faint);margin-bottom:12px;">${escapeHtml(fileName)} · ${rows.length} rows. Match the columns to what they contain.</p>
    <div style="overflow-x:auto;margin-bottom:14px;"><table style="border-collapse:collapse;font-size:12px;">
      <thead><tr>${headers.map(h=>`<th style="text-align:left;padding:4px 8px 4px 0;color:var(--ink-faint);white-space:nowrap;">${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${sample.map(r=>`<tr>${headers.map((_,i)=>`<td style="padding:4px 8px 4px 0;white-space:nowrap;">${escapeHtml(r[i]||'')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="grid2">
      <div class="field"><label class="field-label">Date</label><select id="csvDate">${opts(g.date,false)}</select></div>
      <div class="field"><label class="field-label">Time (if separate)</label><select id="csvTime">${opts(g.time,true)}</select></div>
    </div>
    <div class="field"><label class="field-label">Date format</label>
      <select id="csvDateFmt">
        <option value="dmy">Day/Month/Year (e.g. 17/09/2026)</option>
        <option value="mdy">Month/Day/Year (e.g. 09/17/2026)</option>
        <option value="ymd">Year-Month-Day (e.g. 2026-09-17)</option>
      </select>
    </div>
    <div class="grid2">
      <div class="field"><label class="field-label">PEF (L/min)</label><select id="csvPef">${opts(g.pef,true)}</select></div>
      <div class="field"><label class="field-label">SpO₂ %</label><select id="csvSpo2">${opts(g.spo2,true)}</select></div>
    </div>
    <div class="field"><label class="field-label">Notes</label><select id="csvNote">${opts(g.note,true)}</select></div>
    <p style="font-size:12px;color:var(--ink-faint);margin-bottom:12px;line-height:1.5;">Readings already in the app (same date, time and value) are skipped, so importing the same file twice won't create duplicates.</p>
    <button class="btn btn-primary" onclick="runCSVImport()">Import</button>`);
  // ISO-looking dates → pick Y-M-D automatically
  const firstDate = g.date>=0 ? (rows[0][g.date]||'') : '';
  if(/^\d{4}[-/.]/.test(firstDate.trim())) document.getElementById('csvDateFmt').value = 'ymd';
}
function parseImportDate(dateStr, timeStr, fmt){
  dateStr = (dateStr||'').trim(); timeStr = (timeStr||'').trim();
  if(!dateStr) return null;
  // split off a time glued to the date ("17/09/2026 08:30", "2026-09-17T08:30:00")
  const m = dateStr.match(/^(\S+?)(?:[ T](.+))?$/);
  let datePart = m[1], timePart = timeStr || m[2] || '';
  const nums = datePart.split(/[-/.]/).map(n=>parseInt(n,10));
  let y, mo, d;
  if(nums.length===3 && nums.every(n=>!isNaN(n))){
    if(fmt==='ymd' || String(nums[0]).length===4) [y,mo,d] = nums;
    else if(fmt==='mdy') [mo,d,y] = nums;
    else [d,mo,y] = nums;
    if(y<100) y += 2000;
  }else{
    // month names etc. — let the browser try ("17 Sep 2026", "Sep 17, 2026")
    const t = new Date(dateStr + (timeStr?' '+timeStr:''));
    return isNaN(t) ? null : t;
  }
  let h=9, min=0;
  const tm = timePart.match(/(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*(am|pm)?/i);
  if(tm){
    h = parseInt(tm[1],10); min = parseInt(tm[2],10);
    if(tm[3]){ const pm = /pm/i.test(tm[3]); if(h===12) h = pm?12:0; else if(pm) h += 12; }
  }
  const out = new Date(y, mo-1, d, h, min);
  return (isNaN(out) || out.getMonth()!==mo-1) ? null : out;
}
function runCSVImport(){
  const col = id => parseInt(document.getElementById(id).value,10);
  const c = {date:col('csvDate'), time:col('csvTime'), pef:col('csvPef'), spo2:col('csvSpo2'), note:col('csvNote')};
  const fmt = document.getElementById('csvDateFmt').value;
  if(c.pef<0 && c.spo2<0){ toast('Pick a PEF or SpO₂ column'); return; }
  const num = v => { const n = parseFloat(String(v||'').replace(/[^\d.]/g,'')); return isNaN(n) ? null : n; };
  const key = (iso, v) => new Date(iso).toISOString().slice(0,16)+'|'+v;
  const havePef = new Set(state.peakFlow.map(r=>key(r.date, r.value)));
  const haveOx = new Set(state.oxygen.map(r=>key(r.date, r.value)));
  let addedPef=0, addedOx=0, skipped=0, bad=0;
  csvImport.rows.forEach(r=>{
    const when = parseImportDate(r[c.date], c.time>=0 ? r[c.time] : '', fmt);
    if(!when){ bad++; return; }
    const iso = when.toISOString();
    const note = c.note>=0 ? (r[c.note]||'').trim() : '';
    const pef = c.pef>=0 ? num(r[c.pef]) : null;
    const ox = c.spo2>=0 ? num(r[c.spo2]) : null;
    if(pef===null && ox===null){ bad++; return; }
    if(pef!==null && pef>0 && pef<1000){
      if(havePef.has(key(iso,pef))) skipped++;
      else { state.peakFlow.push({id:uid(), date:iso, value:pef, note}); havePef.add(key(iso,pef)); addedPef++; }
    }
    if(ox!==null && ox>0 && ox<=100){
      if(haveOx.has(key(iso,ox))) skipped++;
      else { state.oxygen.push({id:uid(), date:iso, value:ox, note}); haveOx.add(key(iso,ox)); addedOx++; }
    }
  });
  state.peakFlow.sort((a,b)=>new Date(a.date)-new Date(b.date));
  state.oxygen.sort((a,b)=>new Date(a.date)-new Date(b.date));
  saveState(); renderAll();
  renderModal(`
    <div class="modal-head"><h2>Import complete</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="stack" style="gap:6px;font-size:14px;margin-bottom:16px;">
      <div>✅ <strong>${addedPef}</strong> PEF reading${addedPef===1?'':'s'} added</div>
      ${c.spo2>=0?`<div>✅ <strong>${addedOx}</strong> SpO₂ reading${addedOx===1?'':'s'} added</div>`:''}
      ${skipped?`<div>↩︎ ${skipped} already in the app — skipped</div>`:''}
      ${bad?`<div style="color:var(--sev4);">⚠️ ${bad} row${bad===1?'':'s'} couldn't be read (missing or unrecognised date/value)</div>`:''}
    </div>
    <button class="btn btn-primary" onclick="closeModal()">Done</button>`);
  csvImport = null;
}

/* ============ KEEPING DATA SAFE ON THIS DEVICE ============ */
// per-device notes, kept outside the synced app state
const LOCAL_KEYS = {lastBackup:'airway-tracker:lastBackupAt', snooze:'airway-tracker:backupSnoozeUntil', installDismissed:'airway-tracker:installHintDismissed'};
function localGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function localSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function markBackedUp(){ localSet(LOCAL_KEYS.lastBackup, new Date().toISOString()); renderSafetyBanners(); }

// offline support + "add to home screen"
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('sw.js').catch(e=>console.warn('service worker not registered', e));
}
// ask the browser not to clear this site's storage when space runs low
let storagePersisted = null;
if(navigator.storage && navigator.storage.persist){
  navigator.storage.persisted().then(p => p ? p : navigator.storage.persist()).then(p => { storagePersisted = p; });
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; renderSafetyBanners(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; renderSafetyBanners(); toast('App installed'); });
async function installApp(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  renderSafetyBanners();
}
function dismissInstallHint(){ localSet(LOCAL_KEYS.installDismissed, '1'); renderSafetyBanners(); }
function snoozeBackupReminder(){ localSet(LOCAL_KEYS.snooze, String(Date.now() + 3*86400000)); renderSafetyBanners(); }

function dataCount(){
  return state.peakFlow.length + state.oxygen.length + state.symptoms.length + state.surgeries.length
    + state.silsi.length + state.treatments.length + (state.events||[]).length + state.documents.length;
}
function daysSince(iso){ return iso ? Math.floor((Date.now()-new Date(iso).getTime())/86400000) : null; }

// Home banners: install the app (iPhone Safari wipes un-installed sites' data after 7 days unused),
// and a reminder when there's no recent backup (or Drive sync)
function renderSafetyBanners(){
  const host = document.getElementById('todayBanners');
  if(!host) return;
  let el = document.getElementById('safetyBanners');
  if(!el){ el = document.createElement('div'); el.id = 'safetyBanners'; host.parentNode.insertBefore(el, host); }
  const out = [];
  if(!isStandalone() && !localGet(LOCAL_KEYS.installDismissed)){
    if(isIOS){
      out.push(`
      <div class="banner reminder" style="margin-bottom:12px;">
        <div class="banner-title">📲 Add Airway to your Home Screen</div>
        <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.5;margin-bottom:8px;">On iPhone and iPad, Safari can erase a website's saved data if it isn't opened for 7 days. Installing the app keeps your data safe. Tap <strong>Share</strong> <span aria-hidden="true">⬆︎</span> then <strong>Add to Home Screen</strong>, and open Airway from there.</div>
        <button class="link" onclick="dismissInstallHint()">I've done this</button>
      </div>`);
    }else if(deferredInstallPrompt){
      out.push(`
      <div class="banner reminder" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
        <div><div class="banner-title">📲 Install Airway</div><div style="font-size:12.5px;color:var(--ink-soft);">Opens like an app, works offline, and keeps your data safer.</div></div>
        <div style="display:flex;gap:8px;"><button class="btn btn-primary btn-sm" onclick="installApp()">Install</button><button class="btn btn-ghost btn-sm" onclick="dismissInstallHint()">Not now</button></div>
      </div>`);
    }
  }
  const last = localGet(LOCAL_KEYS.lastBackup);
  const lastSync = typeof driveLastSyncAt==='function' ? driveLastSyncAt() : null;
  const newest = [last, lastSync].filter(Boolean).sort().pop() || null;
  const age = daysSince(newest);
  const snoozed = Number(localGet(LOCAL_KEYS.snooze)||0) > Date.now();
  if(dataCount()>=5 && !snoozed && (age===null || age>=14)){
    out.push(`
      <div class="banner recovery" style="margin-bottom:12px;">
        <div class="banner-title">💾 ${age===null ? "You haven't backed up yet" : `Last backup was ${age} days ago`}</div>
        <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.5;margin-bottom:8px;">Your data is only stored in this browser. Keep a copy so nothing is lost.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="downloadBackup()">Back up now</button><button class="btn btn-ghost btn-sm" onclick="snoozeBackupReminder()">Remind me later</button></div>
      </div>`);
  }
  el.innerHTML = out.join('');
}
function safetySettingsHtml(){
  const last = localGet(LOCAL_KEYS.lastBackup);
  const rows = [
    ['Installed as an app', isStandalone() ? '✅ Yes' : (isIOS ? '⚠️ No — use Share → Add to Home Screen' : 'No')],
    ['Protected from browser clean-up', storagePersisted===true ? '✅ Yes' : storagePersisted===false ? 'Not yet — installing the app helps' : '—'],
    ['Last full backup on this device', last ? new Date(last).toLocaleString() : 'Never'],
  ];
  return `<div style="font-size:13px;margin-bottom:14px;">${rows.map(([k,v])=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);"><span style="color:var(--ink-soft);">${k}</span><span style="text-align:right;">${escapeHtml(v)}</span></div>`).join('')}</div>`;
}

/* ============ HOOKS ============ */
// every save also refreshes the automatic backup file
const _saveStateOriginal = saveState;
saveState = async function(){
  await _saveStateOriginal();
  scheduleAutoBackup();
};
// Home banners refresh whenever the app re-renders
const _renderAllOriginal = renderAll;
renderAll = function(){
  _renderAllOriginal();
  if(stateLoaded) renderSafetyBanners();
};
initAutoBackup();
if(stateLoaded) renderSafetyBanners();
