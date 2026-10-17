/* Lifetracker platform layer.
   Provides window.claude.use('db' | 'mcp' | 'downloads') backed by:
   - Google Drive: one JSON file (Lifetracker/lifetracker-data.json) holds all data,
     cached on the device so the app works offline and syncs when back online.
   - Google Calendar REST API for calendars and events.
   Sign-in uses the OAuth 2.0 redirect flow (works in iPhone home-screen apps). */
(() => {
'use strict';

const CLIENT_ID = '126102017268-10jharb06ajilu166iq2jbah3nvjq5sf.apps.googleusercontent.com';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events'
].join(' ');
const REDIRECT = new URL('./', location.href).href;
const FILE_NAME = 'lifetracker-data.json', FOLDER_NAME = 'Lifetracker';
const COLLS = ['days', 'tx', 'recurring', 'savings', 'goals', 'meta'];
const LS = { auth: 'lt.auth', data: 'lt.data', ops: 'lt.ops', meta: 'lt.meta' };

/* ---------- storage helpers ---------- */
const lsGet = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
const ssGet = k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
const ssSet = (k, v) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { } };
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const o = { ...(a || {}) };
  for (const k in b) { const v = b[k]; o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : clone(v); }
  return o;
}
const emptyStore = () => Object.fromEntries(COLLS.map(c => [c, {}]));

/* ---------- auth ---------- */
let auth = lsGet(LS.auth) || {};
let authNote = null;
(function readRedirect() {
  if (!location.hash || location.hash.length < 2) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('access_token') && !p.has('error')) return;
  const expected = ssGet('lt.state');
  history.replaceState(null, '', location.pathname + location.search);
  if (!expected || p.get('state') !== expected) { authNote = 'Sign-in could not be confirmed. Try again.'; return; }
  ssSet('lt.state', null);
  if (p.has('access_token')) {
    auth = { ...auth, token: p.get('access_token'), exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 };
    lsSet(LS.auth, auth);
  } else {
    const e = p.get('error');
    if (e !== 'login_required' && e !== 'interaction_required' && e !== 'consent_required' && e !== 'access_denied') authNote = 'Google sign-in failed (' + e + '). Try again.';
    if (e === 'access_denied') authNote = 'Sign-in was cancelled.';
    auth = { ...auth, token: null, exp: 0 };
    lsSet(LS.auth, auth);
  }
})();
const token = () => auth.token && auth.exp - 60000 > Date.now() ? auth.token : null;
function signIn(silent) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  ssSet('lt.state', state);
  if (silent) ssSet('lt.silent', String(Date.now()));
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'token', scope: SCOPES,
    include_granted_scopes: 'true', state
  });
  if (auth.hint) q.set('login_hint', auth.hint);
  if (silent) q.set('prompt', 'none');
  else if (!auth.hint) q.set('prompt', 'select_account consent');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
}
function trySilentRenew() {
  if (token() || !auth.hint || !navigator.onLine) return false;
  const last = Number(ssGet('lt.silent') || 0);
  if (Date.now() - last < 120000) return false;
  const a = document.activeElement;
  if (a && a.matches && a.matches('input,select,textarea')) return false;
  signIn(true); return true;
}
function signOut() {
  const t = auth.token;
  auth = {}; lsSet(LS.auth, null); lsSet(LS.data, null); lsSet(LS.ops, null); lsSet(LS.meta, null);
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', mode: 'no-cors' }).catch(() => { });
  location.replace(REDIRECT);
}

/* ---------- Google API fetch ---------- */
async function gfetch(url, opts = {}) {
  const t = token();
  if (!t) throw { code: 'needs_reauth', message: 'Sign in with Google' };
  let res;
  try { res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } }); }
  catch (e) { throw { code: 'server_unavailable', message: 'No connection' }; }
  if (res.status === 401) { auth = { ...auth, token: null, exp: 0 }; lsSet(LS.auth, auth); syncState('signin'); throw { code: 'needs_reauth', message: 'Session expired' }; }
  if (!res.ok) {
    let msg = res.status + ''; try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { }
    if (res.status === 403 && /insufficient|scope/i.test(msg)) throw { code: 'needs_reauth', message: msg };
    throw { code: res.status >= 500 ? 'server_unavailable' : 'tool_error', message: msg, status: res.status };
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}
async function fetchHint() {
  if (auth.hint) return;
  try { const u = await gfetch('https://openidconnect.googleapis.com/v1/userinfo'); if (u && u.email) { auth = { ...auth, hint: u.email }; lsSet(LS.auth, auth); } } catch (e) { }
}

/* ---------- local store + Drive sync ---------- */
let store = lsGet(LS.data);
let ops = lsGet(LS.ops) || [];
let meta = lsGet(LS.meta) || {};
let fresh = false;
let state = 'idle';
const listeners = new Set();
function syncState(s) { if (state === s) return; state = s; window.dispatchEvent(new Event('lt-sync')); }
function persist() { lsSet(LS.data, store); lsSet(LS.ops, ops); lsSet(LS.meta, meta); }
function applyOp(st, o) {
  if (o.op === 'replace') return clone(o.data);
  const s = { ...st }; s[o.c] = { ...(s[o.c] || {}) };
  if (o.op === 'set') s[o.c][o.id] = clone(o.data);
  else if (o.op === 'update') s[o.c][o.id] = merge(s[o.c][o.id], o.data);
  else if (o.op === 'delete') delete s[o.c][o.id];
  return s;
}
const applyAll = (st, list) => list.reduce(applyOp, st);
function normalize(d) { const s = emptyStore(); if (d) for (const c of COLLS) if (isObj(d[c])) s[c] = d[c]; return s; }
let notifyQueued = false;
function notify() {
  if (notifyQueued) return; notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); });
}
function write(o) {
  store = applyOp(store || emptyStore(), o);
  ops.push(o); persist(); notify(); scheduleSync(1200);
  return Promise.resolve();
}

const DRIVE = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const fileBody = data => JSON.stringify({ app: 'Lifetracker', format: 1, updatedAt: new Date().toISOString(), data }, null, 1);
async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await gfetch(`${DRIVE}?q=${q}&spaces=drive&fields=files(id,version,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`);
  return (r.files || [])[0] || null;
}
async function createFile(data) {
  let folderId = meta.folderId;
  if (!folderId) {
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await gfetch(`${DRIVE}?q=${q}&fields=files(id)&pageSize=1`);
    folderId = r.files && r.files[0] && r.files[0].id;
    if (!folderId) {
      const f = await gfetch(`${DRIVE}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
      folderId = f.id;
    }
    meta.folderId = folderId;
  }
  const b = 'lt' + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: [folderId], mimeType: 'application/json', description: 'Lifetracker data. Edited by the Lifetracker app.' })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${fileBody(data)}\r\n--${b}--`;
  const f = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  meta.fileId = f.id; meta.version = f.version;
}
async function download(id) {
  const txt = await gfetch(`${DRIVE}/${id}?alt=media`, { cache: 'no-store' });
  const j = typeof txt === 'string' ? JSON.parse(txt || '{}') : txt;
  return normalize(j && j.data ? j.data : j);
}

let syncing = false, again = false, syncTimer = null;
function scheduleSync(ms = 0) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (syncing) { again = true; return; }
  if (!token()) { syncState('signin'); return; }
  if (!navigator.onLine) { syncState('offline'); return; }
  syncing = true; syncState('syncing');
  try {
    if (!meta.fileId) {
      const f = await findFile();
      if (f) { meta.fileId = f.id; meta.version = null; }
      else if (store) { const sent = ops.length; await createFile(normalize(clone(store))); ops = ops.slice(sent); persist(); }
      else { syncing = false; syncState('firstrun'); firstRun(); return; }
    }
    const m = await gfetch(`${DRIVE}/${meta.fileId}?fields=version,trashed`, { cache: 'no-store' }).catch(e => { if (e.status === 404) { meta.fileId = null; } throw e; });
    if (m.trashed) { meta.fileId = null; meta.version = null; persist(); throw { code: 'tool_error', message: 'The data file is in the Drive trash. Restore it, or reload to start a new file.' }; }
    let base = null;
    if (m.version !== meta.version || !store) { base = await download(meta.fileId); meta.version = m.version; }
    const sent = ops.length;
    if (sent) {
      const next = applyAll(base || store, ops.slice(0, sent));
      const r = await gfetch(`${UPLOAD}/${meta.fileId}?uploadType=media&fields=version`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: fileBody(next) });
      meta.version = r.version;
      ops = ops.slice(sent);
      store = applyAll(next, ops);
    } else if (base) store = base;
    persist();
    fresh = true; resolveDb();
    notify();
    syncState(ops.length ? 'syncing' : 'synced');
    if (ops.length) again = true;
  } catch (e) {
    if (e && e.code === 'needs_reauth') syncState('signin');
    else if (!navigator.onLine || (e && e.code === 'server_unavailable')) syncState('offline');
    else { syncState('error'); lastError = e && e.message; }
    if (!fresh && store) resolveDb();
    if (!store) gate('error', (e && e.message) || 'Could not reach Google Drive.');
  } finally {
    syncing = false;
    if (again) { again = false; scheduleSync(800); }
  }
}
let lastError = null;
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!trySilentRenew()) scheduleSync(0); } });
window.addEventListener('online', () => scheduleSync(0));
window.addEventListener('offline', () => syncState('offline'));
window.addEventListener('pagehide', () => persist());

/* ---------- db shim (same surface the app uses) ---------- */
let dbResolve; const dbReady = new Promise(r => { dbResolve = r; });
let dbResolved = false;
function resolveDb() { if (dbResolved || !store) return; dbResolved = true; hideGate(); dbResolve(db); }
const collSnap = c => ({ docs: Object.entries((store && store[c]) || {}).map(([id, d]) => ({ id, data: () => clone(d) })), metadata: { fromCache: !fresh } });
const docSnap = (c, id) => { const d = store && store[c] && store[c][id]; return { exists: d != null, id, data: () => clone(d), metadata: { fromCache: !fresh } }; };
const db = {
  collection(c) {
    return {
      onSnapshot(cb) { const fn = () => cb(collSnap(c)); listeners.add(fn); queueMicrotask(fn); return () => listeners.delete(fn); }
    };
  },
  doc(path) {
    const [c, id] = path.split('/');
    return {
      get: async () => docSnap(c, id),
      set: data => write({ op: 'set', c, id, data }),
      update: data => write({ op: 'update', c, id, data }),
      delete: () => write({ op: 'delete', c, id }),
      onSnapshot(cb) { const fn = () => cb(docSnap(c, id)); listeners.add(fn); queueMicrotask(fn); return () => listeners.delete(fn); }
    };
  }
};

/* ---------- import ---------- */
function backupToStore(j) {
  if (!j || typeof j !== 'object') throw new Error('bad');
  if (j.data && isObj(j.data) && j.data.days) return normalize(j.data);
  const s = emptyStore();
  const put = (c, arr, key = 'id') => (Array.isArray(arr) ? arr : []).forEach(x => { if (!x) return; const id = x[key] || x.date; if (!id) return; const { id: _drop, ...rest } = x; s[c][id] = rest; });
  put('days', j.days, 'id');
  put('tx', j.transactions || j.tx);
  put('recurring', j.recurring);
  put('savings', j.savings);
  put('goals', j.goals);
  if (isObj(j.settings)) s.meta.settings = j.settings;
  if (!Object.keys(s.days).length && !Object.keys(s.tx).length && !Object.keys(s.goals).length && !s.meta.settings) throw new Error('empty');
  return s;
}
function pickImport() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    let s;
    try { s = backupToStore(JSON.parse(await f.text())); }
    catch (e) { alertMsg('This file is not a Lifetracker backup.'); return; }
    const n = Object.keys(s.days).length, t = Object.keys(s.tx).length;
    if (store && (Object.keys(store.days || {}).length || Object.keys(store.tx || {}).length)) {
      if (!confirm(`Replace everything in your tracker with this backup (${n} days, ${t} transactions)?`)) return;
    }
    store = s; ops.push({ op: 'replace', data: s }); persist();
    resolveDb(); notify(); scheduleSync(0);
    alertMsg(`Imported ${n} days and ${t} transactions.`);
  };
  document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}
function alertMsg(m) { const el = document.getElementById('toast'); if (el) { el.textContent = m; el.hidden = false; setTimeout(() => { el.hidden = true; }, 3500); } }

/* ---------- gate (first run / sign-in screen) ---------- */
function gate(kind, msg) {
  let el = document.getElementById('lt-gate');
  if (!el) { el = document.createElement('div'); el.id = 'lt-gate'; document.body.appendChild(el); }
  el.style.cssText = 'position:fixed;inset:0;z-index:70;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:24px 16px';
  const brand = `<div class="brand" style="margin-bottom:6px"><img class="brand-logo" src="icon-192-v2.png" alt="" width="26" height="26">Lifetracker</div>`;
  let body = '';
  if (kind === 'signin') body = `<h2 style="font-size:22px">Sign in to your tracker</h2><p class="sub" style="margin:0">Your entries are saved in a file on your Google Drive, and your events come from Google Calendar.</p>${authNote ? `<div class="notice">${authNote}</div>` : ''}<div><button class="btn primary" data-lt="signin">Sign in with Google</button></div>`;
  else if (kind === 'loading') body = `<div class="sub">Connecting to Google Drive…</div>`;
  else if (kind === 'firstrun') body = `<h2 style="font-size:22px">Welcome</h2><p class="sub" style="margin:0">There's no tracker data on your Google Drive yet. Bring in a backup from your old tracker, or start with an empty one.</p><div class="row"><button class="btn primary" data-lt="import">Import backup (.json)</button><button class="btn" data-lt="fresh">Start fresh</button></div>`;
  else body = `<h2 style="font-size:22px">Couldn't open your data</h2><p class="sub" style="margin:0">${String(msg || '').replace(/[<>&]/g, '')}</p><div class="row"><button class="btn primary" data-lt="retry">Try again</button><button class="btn" data-lt="signin">Sign in again</button></div>`;
  el.innerHTML = `<div class="card" style="max-width:440px;width:100%;gap:14px">${brand}${body}</div>`;
}
function hideGate() { const el = document.getElementById('lt-gate'); if (el) el.remove(); }
function firstRun() { gate('firstrun'); }
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-lt]'); if (!b) return;
  const a = b.dataset.lt;
  if (a === 'signin') signIn(false);
  else if (a === 'retry') { gate('loading'); scheduleSync(0); }
  else if (a === 'import') pickImport();
  else if (a === 'fresh') { store = emptyStore(); ops.push({ op: 'replace', data: store }); persist(); resolveDb(); scheduleSync(0); }
});

/* ---------- calendar (mcp shim) ---------- */
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const enc = encodeURIComponent;
const localToISO = s => new Date(s).toISOString();
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'Europe/Warsaw'; } };
async function calTool(tool, input) {
  if (tool === 'list_calendars') {
    const r = await gfetch(`${CAL_API}/users/me/calendarList?maxResults=250`);
    return { calendars: r.items || [] };
  }
  if (tool === 'list_events') {
    const q = new URLSearchParams({ timeMin: localToISO(input.startTime), timeMax: localToISO(input.endTime), singleEvents: 'true', orderBy: 'startTime', maxResults: String(input.pageSize || 250) });
    const r = await gfetch(`${CAL_API}/calendars/${enc(input.calendarId)}/events?${q}`);
    return { events: r.items || [], accessRole: r.accessRole };
  }
  if (tool === 'create_event') {
    const body = { summary: input.summary };
    if (input.location) body.location = input.location;
    if (input.allDay) { body.start = { date: input.startTime.slice(0, 10) }; body.end = { date: input.endTime.slice(0, 10) }; }
    else { body.start = { dateTime: input.startTime, timeZone: tz() }; body.end = { dateTime: input.endTime, timeZone: tz() }; }
    return gfetch(`${CAL_API}/calendars/${enc(input.calendarId)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (tool === 'delete_event') return gfetch(`${CAL_API}/calendars/${enc(input.calendarId)}/events/${enc(input.eventId)}`, { method: 'DELETE' });
  throw { code: 'tool_error', message: 'Unknown action' };
}
const cache = new Map(), watches = new Set();
const ckey = (tool, input) => tool + ':' + JSON.stringify(input);
async function cachedCall(tool, input, maxAge) {
  const k = ckey(tool, input), hit = cache.get(k);
  if (hit && maxAge && Date.now() - hit.at < maxAge) return hit.payload;
  const payload = await calTool(tool, input);
  cache.set(k, { at: Date.now(), payload });
  return payload;
}
function runWatch(w, maxAge) {
  return cachedCall(w.tool, w.input, maxAge)
    .then(payload => { if (watches.has(w)) w.handler({ type: 'data', result: { payload } }); })
    .catch(error => { if (watches.has(w)) w.handler({ type: 'error', error }); });
}
const mcp = {
  callTool(server, tool, input, opts = {}) {
    const maxAge = opts.cache && opts.cache.refresh ? 0 : (opts.cache && opts.cache.staleTime) || 0;
    const isRead = tool === 'list_events' || tool === 'list_calendars';
    return (isRead ? cachedCall(tool, input, maxAge) : calTool(tool, input).then(p => { cache.clear(); return p; })).then(payload => ({ payload }));
  },
  watchTool(server, tool, input, handler, opts = {}) {
    const w = { tool, input, handler };
    watches.add(w);
    runWatch(w, (opts.cache && opts.cache.staleTime) || 60000);
    const iv = opts.refetchInterval ? setInterval(() => { if (document.visibilityState === 'visible') runWatch(w, 0); }, opts.refetchInterval) : null;
    return () => { watches.delete(w); if (iv) clearInterval(iv); };
  },
  invalidate(server, tool) {
    for (const k of [...cache.keys()]) if (k.startsWith(tool + ':')) cache.delete(k);
    return Promise.all([...watches].filter(w => w.tool === tool).map(w => runWatch(w, 0)));
  }
};

/* ---------- downloads shim ---------- */
const downloads = {
  async save({ filename, data }) {
    const type = /\.json$/.test(filename) ? 'application/json' : /\.xlsx$/.test(filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream';
    const blob = new Blob([data], { type });
    const coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;
    if (coarse && navigator.canShare) {
      const file = new File([blob], filename, { type });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e && e.name === 'AbortError') throw { code: 'declined' }; }
      }
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
};

/* ---------- public surface ---------- */
window.claude = {
  use(name) {
    if (name === 'db') return dbReady;
    if (name === 'mcp') return Promise.resolve(mcp);
    if (name === 'downloads') return Promise.resolve(downloads);
    return Promise.resolve(null);
  }
};
window.LT = {
  signIn: () => signIn(false), signOut, pickImport, sync: () => scheduleSync(0),
  state: () => state, account: () => auth.hint || null, error: () => lastError,
  pending: () => ops.length, signedIn: () => !!token()
};

/* ---------- boot ---------- */
function boot() {
  if (store) { resolveDb(); }
  if (token()) { fetchHint(); if (!store) gate('loading'); scheduleSync(0); return; }
  if (trySilentRenew()) { if (!store) gate('loading'); return; }
  syncState('signin');
  if (!store) gate('signin');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
