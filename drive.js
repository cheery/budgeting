// Google Drive sync for a single plain-text file (budget.txt).
// Uses the narrow "drive.file" scope: the app can only see files it created.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'budget.txt';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let tokenClient = null;

// Errors carry a `key`/`args` so the UI can translate them (i18n.js `err.*`).
function driveErr(key, args, msg) { const e = new Error(msg); e.key = key; e.args = args; return e; }
const expired = () => driveErr('expired', [], 'Google session expired; tap Sync to sign in again');
// Token is kept for its lifetime (~1h) so reloads don't need a new sign-in.
let token = null, tokenExpiry = 0;
try { ({ token, tokenExpiry } = JSON.parse(localStorage.getItem('budget.driveToken')) || {}); } catch {}
function saveToken() {
  try { localStorage.setItem('budget.driveToken', JSON.stringify({ token, tokenExpiry })); } catch {}
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(driveErr('gisLoad', [], 'Could not load Google sign-in (offline?)'));
    document.head.appendChild(s);
  });
}

export function hasValidToken() {
  return token && Date.now() < tokenExpiry - 60_000;
}

// Must be called from a user gesture the first time (opens a popup).
export async function signIn(clientId) {
  if (hasValidToken()) return;
  await loadGis();
  await new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token;
        tokenExpiry = Date.now() + r.expires_in * 1000;
        saveToken();
        resolve();
      },
      error_callback: e => reject(new Error(e.message || e.type || 'Sign-in cancelled')),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token);
  token = null;
  tokenExpiry = 0;
  saveToken();
}

async function call(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { token = null; saveToken(); throw expired(); }
  if (!res.ok) throw driveErr('drive', [res.status], `Drive error ${res.status}: ${await res.text()}`);
  return res;
}

export async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await call(`${API}/files?q=${q}&fields=files(id,version,modifiedTime)&orderBy=modifiedTime desc`);
  return (await r.json()).files[0] || null;
}

export async function getMeta(id) {
  const r = await fetch(`${API}/files/${id}?fields=id,version,trashed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (r.status === 401) { token = null; saveToken(); throw expired(); }
  if (!r.ok) throw driveErr('drive', [r.status], `Drive error ${r.status}`);
  const m = await r.json();
  return m.trashed ? null : m;
}

export async function download(id) {
  const r = await call(`${API}/files/${id}?alt=media`);
  return r.text();
}

export async function create(text) {
  const boundary = 'b' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: FILE_NAME, mimeType: 'text/plain' }) +
    `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n` +
    text + `\r\n--${boundary}--`;
  const r = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return r.json();
}

export async function update(id, text) {
  const r = await call(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: text,
  });
  return r.json();
}
