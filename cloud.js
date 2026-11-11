// ennakkoon.fi cloud storage (opt-in): Cognito sign-in with social providers, budget.txt in
// DynamoDB in Stockholm (eu-north-1), reached through /api on the same origin.
//
// Sign-in: OAuth 2.0 authorization code + PKCE straight to the chosen provider. The refresh token
// is kept in localStorage so the app stays signed in (static app, no server to set cookies). It
// rotates on every use, lives at most 30 days and is revoked on sign-out; the strict CSP limits
// what injected script could do. Access tokens (15 min) stay in memory only.
//
// Errors carry `key` + `args` like core.js, so the UI can translate them (i18n `err.*`).

// Filled in from the ennakkoon-api stack outputs (AuthDomain, ClientId). Not secret.
const CONFIG = {
  origin: 'https://ennakkoon.fi',
  authDomain: 'ennakkoon.auth.eu-north-1.amazoncognito.com',
  clientId: 'e9nrl3jrmbdccvsi48n34vcqb',
  providers: ['Google'],   // Cognito identity provider names, in button order
};

const K = { refresh: 'budget.cloud.refresh', user: 'budget.cloud.user', pkce: 'budget.cloud.pkce' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let access = null;       // { token, exp (ms), claims }

function fail(key, args = []) {
  const e = new Error(key);
  e.key = key; e.args = args;
  throw e;
}

export const available = () => !!CONFIG.clientId && location.origin === CONFIG.origin;
export const providers = () => CONFIG.providers;
export const signedIn = () => available() && !!store.get(K.refresh);
export const user = () => store.get(K.user) || '';
export const isAdmin = () => {
  const g = access?.claims['cognito:groups'];
  return Array.isArray(g) && g.includes('admin');
};

// ---------- OAuth ----------

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const claimsOf = jwt => JSON.parse(decodeURIComponent(escape(atob(
  jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
const redirectUri = () => CONFIG.origin + '/';

export async function signIn(provider) {
  if (!CONFIG.providers.includes(provider)) fail('cloudConfig');
  const verifier = randomString(), state = randomString();
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set(K.pkce, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: 'code', client_id: CONFIG.clientId, redirect_uri: redirectUri(),
    scope: 'openid email', state, code_challenge: challenge, code_challenge_method: 'S256',
    identity_provider: provider,
  });
  location.assign(`https://${CONFIG.authDomain}/oauth2/authorize?${q}`);
}

async function tokenRequest(params) {
  let r;
  try {
    r = await fetch(`https://${CONFIG.authDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, ...params }),
    });
  } catch { fail('cloudOffline'); }
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) { forget(); fail('cloudSignedOut'); }
    fail('cloudServer', [r.status]);
  }
  const j = await r.json();
  if (j.refresh_token) store.set(K.refresh, j.refresh_token);
  const claims = claimsOf(j.access_token);
  access = { token: j.access_token, exp: claims.exp * 1000, claims };
  if (j.id_token) store.set(K.user, claimsOf(j.id_token).email || '');
}

// Call once at startup. Returns 'signedIn' after a successful return from the provider,
// 'error' if sign-in failed or was cancelled, or null if this was not a sign-in return.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  const saved = JSON.parse(store.get(K.pkce) || 'null');
  store.set(K.pkce, null);
  history.replaceState(null, '', location.pathname);
  if (!available() || q.has('error') || !saved || q.get('state') !== saved.state) return 'error';
  try {
    await tokenRequest({
      grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: saved.verifier,
    });
    return 'signedIn';
  } catch { return 'error'; }
}

async function accessToken() {
  if (access && access.exp - 60_000 > Date.now()) return access.token;
  const refresh = store.get(K.refresh);
  if (!refresh) fail('cloudSignedOut');
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  return access.token;
}

function forget() {
  access = null;
  store.set(K.refresh, null);
  store.set(K.user, null);
}

export async function signOut() {
  const refresh = store.get(K.refresh);
  forget();
  if (refresh)   // best effort: revoke so the token is useless even if it was copied
    fetch(`https://${CONFIG.authDomain}/oauth2/revoke`, {
      method: 'POST', keepalive: true,   // survives a page reload right after sign-out
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, token: refresh }),
    }).catch(() => {});
}

// Fetch the token first so isAdmin() is accurate before the first API call.
export async function refreshSession() { await accessToken(); }

// ---------- API ----------

async function api(method, path, body) {
  const token = await accessToken();
  let r;
  try {
    r = await fetch('/api' + path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch { fail('cloudOffline'); }
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (r.ok) return j;
  if (r.status === 401) { forget(); fail('cloudSignedOut'); }
  if (r.status === 404 && path === '/budget') return null;
  if (r.status === 409) fail('cloudConflict');
  if (j?.error === 'storeTooLarge' || j?.error === 'storeInvalid') fail(j.error, j.args || []);
  fail('cloudServer', [r.status]);
}

export const get = () => api('GET', '/budget');                       // { text, version } | null
export const put = (text, version) => api('PUT', '/budget', { text, version });   // { version }
export const adminStats = () => api('GET', '/admin/stats');

export async function deleteAccount() {
  await api('DELETE', '/account');
  forget();
}
