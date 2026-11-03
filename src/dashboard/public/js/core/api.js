// fetch wrapper: same-origin credentials, the CSRF header on writes, JSON bodies,
// and an optional AbortSignal (pass ctx.signal so a page's in-flight requests die
// with it).

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readCookie(name) {
  const hit = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export class ApiError extends Error {
  // `body`: the parsed JSON error body when there was one (e.g. a refusal's earliestAt).
  constructor(message, status, body = null) { super(message); this.status = status; this.body = body; }
}

// What the shell tells the owner about reaching the server: 'ok' | 'offline' | 'signedOut'.
let health = 'ok';
const healthFns = new Set();
function setHealth(next) {
  if (next === health) return;
  health = next;
  for (const fn of [...healthFns]) { try { fn(next); } catch (err) { console.error(err); } }
}
/** The app couldn't load code it needed: same state as a failed request. */
export const markOffline = () => setHealth('offline');
export function onApiHealth(fn) {
  healthFns.add(fn);
  return () => healthFns.delete(fn);
}

// A dropped session cookie is renewed once from the browser's saved login, and the request
// runs again; the owner only hears about it when that fails. One attempt at a time.
let relogin = null;
let signingOut = false;
function renewSession() {
  relogin ??= login().finally(() => { relogin = null; });
  return relogin;
}

export async function api(path, opts = {}) {
  const res = await send(path, opts);
  if (res.status === 401 && !signingOut && await renewSession()) return finish(await send(path, opts));
  return finish(res);
}

async function send(path, opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (WRITE_METHODS.has(method)) {
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
  }
  // A write needs the CSRF cookie, which goes with the session cookie.
  if (WRITE_METHODS.has(method) && !headers['X-CSRF-Token'] && !signingOut && await renewSession()) {
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  try {
    return await fetch(path, { credentials: 'include', method, headers, body, signal: opts.signal });
  } catch (err) {
    if (!isAbort(err)) setHealth('offline');
    throw err;
  }
}

async function finish(res) {
  setHealth(res.status === 401 ? 'signedOut' : 'ok');
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let body = null;
    try { const b = await res.json(); body = b && typeof b === 'object' ? b : null; if (b?.error) msg = `${res.status}: ${b.error}`; } catch {}
    throw new ApiError(msg, res.status, body);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/** An aborted request is not an error worth showing (the page went away). */
export const isAbort = (err) => err?.name === 'AbortError';

/** Turn the browser's cached Basic-auth into the session + CSRF cookies. */
export async function login() {
  try {
    const res = await fetch('/api/login', { method: 'POST', credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sign out: drop the session cookie, then overwrite the browser's cached Basic
 * credentials with bogus ones (a 401 on purpose) so the next load prompts again.
 */
export async function logout() {
  signingOut = true;
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  try {
    await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store', headers: { Authorization: 'Basic ' + btoa('logout:x') } });
  } catch {}
}
