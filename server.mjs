import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { all, one, run, ins, tx, init, dayOf } from './db.mjs';
import { extract, caps, maxUpload } from './extract.mjs';

try { process.loadEnvFile(); } catch {}   // reads settings from a .env file next to server.mjs, if present
const PORT = process.env.PORT || 3000;
const KEY = process.env.AI_API_KEY;
const BASE = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');   // any OpenAI-compatible endpoint (OpenAI, Gemini, ...)
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const DEF = { free_limit: 30, premium_limit: 100, premium_days: 30, premium_price: 0, premium_currency: 'EGP', instapay_handle: '' };
const NUMERIC = ['free_limit', 'premium_limit', 'premium_days', 'premium_price'];
const settings = async () => { const o = { ...DEF }; for (const r of await all('SELECT k,v FROM settings')) if (r.k in DEF) o[r.k] = r.v; return o; };
const setting = async k => (await settings())[k];
const WEEK = 7 * 864e5, now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const err = (code, msg) => Object.assign(new Error(msg), { code });
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, st) => { const [s, h] = st.split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// Tables are created on first use; the admin account comes from the server's environment only (never from the web):
// created if missing, promoted if that email already registered.
const ready = (async () => {
  await init();
  if (process.env.ADMIN_EMAIL) {
    const ae = process.env.ADMIN_EMAIL.toLowerCase().trim(), ex = await one('SELECT * FROM users WHERE email=?', ae);
    if (!ex && process.env.ADMIN_PASSWORD) await run('INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,?,?)', 'Administrator', ae, hashPw(process.env.ADMIN_PASSWORD), 'admin', now());
    else if (ex && ex.role !== 'admin') { await run("UPDATE users SET role='admin' WHERE id=?", ex.id); console.log('Promoted ' + ae + ' to admin'); }
  }
})();
ready.catch(e => console.error('startup failed:', e));

const plan = u => (u.plan === 'premium' && u.plan_expires > now() ? 'premium' : 'free');
const usedOf = async u => (await one('SELECT COUNT(*) c FROM usage WHERE user_id=? AND ts>?', u.id, now() - WEEK)).c;
const limitOf = async (u, S) => u.quota != null ? u.quota : Number((S || await settings())[plan(u) + '_limit']);
// Reserve one AI request. Check and insert are ONE statement, so two simultaneous requests cannot both slip under the limit.
async function reserve(u, kind) {
  const lim = await limitOf(u);
  const r = await one('INSERT INTO usage(user_id,kind,ts) SELECT CAST(? AS BIGINT),CAST(? AS TEXT),CAST(? AS BIGINT) WHERE (SELECT COUNT(*) FROM usage WHERE user_id=? AND ts>?)<? RETURNING id',
    u.id, kind, now(), u.id, now() - WEEK, lim);
  if (!r) throw err(429, 'Weekly AI limit reached. Upgrade to Premium or wait for the window to reset.');
  return Number(r.id);
}
const parseJson = s => { try { return JSON.parse(s); } catch { return JSON.parse(String(s).match(/\{[\s\S]*\}/)[0]); } };   // tolerates ```json fences
async function ai(messages, json) {
  if (!KEY) throw err(503, 'AI is not configured: set AI_API_KEY on the server.');
  const call = js => fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages, ...(js ? { response_format: { type: 'json_object' } } : {}) }), signal: AbortSignal.timeout(60000) });
  let r = await call(json);
  if (!r.ok && r.status === 400 && json) r = await call(false);   // some providers reject response_format; the prompt already asks for JSON only
  if (!r.ok) {
    console.error('AI provider error', r.status, (await r.text().catch(() => '')).slice(0, 300));
    throw err(502, r.status === 401 ? 'AI key rejected (401). Check AI_API_KEY.' : r.status === 404 ? 'AI model or endpoint not found (404). Check AI_MODEL and AI_BASE_URL.'
      : r.status === 429 ? 'The AI provider says the key is out of quota or rate-limited (429).' : 'AI provider error ' + r.status);
  }
  const txt = (await r.json()).choices?.[0]?.message?.content;
  if (!txt) throw err(502, 'The AI returned an empty answer. Try again.');
  return txt;
}
// Long documents (a book, a 1-hour lecture transcript) do not fit in one AI prompt: send the parts that match the question, or an even spread when there is no question.
function pick(text, query = '', max = 12000) {
  if (text.length <= max) return text;
  const size = 1500, ch = []; for (let i = 0; i < text.length; i += size) ch.push(text.slice(i, i + size));
  const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])], k = Math.floor(max / size);
  const sc = ch.map((c, i) => { const l = c.toLowerCase(); return [words.filter(w => l.includes(w)).length, i]; }).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const idx = sc[0][0] > 0 ? sc.slice(0, k).map(x => x[1]) : Array.from({ length: k }, (_, j) => Math.round(j * (ch.length - 1) / Math.max(1, k - 1)));
  return [...new Set(idx)].sort((a, b) => a - b).map(i => ch[i]).join('\n[…]\n');
}
async function metered(u, kind, fn) {
  const id = (await reserve(u, kind));
  try { return await fn(); } catch (e) { (await run('DELETE FROM usage WHERE id=?', id)); throw e; }
}
const publicUser = async u => {
  const S = await settings(), [used, limit, docs, due, attempts, avg] = await Promise.all([usedOf(u), limitOf(u, S),
    one('SELECT COUNT(*) c FROM docs WHERE user_id=?', u.id), one('SELECT COUNT(*) c FROM cards WHERE user_id=? AND due<=?', u.id, now()),
    one('SELECT COUNT(*) c FROM attempts WHERE user_id=?', u.id), one('SELECT AVG(100.0*score/total) a FROM attempts WHERE user_id=?', u.id)]);
  return { id: u.id, name: u.name, email: u.email, role: u.role, lang: u.lang, theme: u.theme, plan: plan(u), plan_expires: u.plan_expires,
    usage: { used, limit }, instapay: S.instapay_handle,
    pricing: { price: Number(S.premium_price), currency: S.premium_currency, days: Number(S.premium_days), limit: Number(S.premium_limit), free_limit: Number(S.free_limit) },
    stats: { docs: docs.c, due: due.c, attempts: attempts.c, avg: Math.round(avg.a ?? 0) } };
};

// Rate limits live in the database (not in memory) so they hold across serverless instances and restarts. 15-minute window per key.
const WIN = 9e5;
const rlCount = async k => { const r = await one('SELECT n,t0 FROM rate_limits WHERE k=?', k); return r && now() - r.t0 <= WIN ? r.n : 0; };
async function rlBump(k) {
  const t = now();
  await run('INSERT INTO rate_limits(k,n,t0) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN ?-rate_limits.t0>? THEN 1 ELSE rate_limits.n+1 END,t0=CASE WHEN ?-rate_limits.t0>? THEN ? ELSE rate_limits.t0 END', k, t, t, WIN, t, WIN, t);
  if (Math.random() < 0.02) await run('DELETE FROM rate_limits WHERE t0<?', t - WIN);   // drop expired entries now and then
}
// Client IP for rate limiting. Behind a reverse proxy (Vercel, Fly, Render, Cloudflare) set TRUST_PROXY=1 so the
// real client address is read from X-Forwarded-For; leave it off when exposed directly, or clients could fake it.
const clientIp = req => process.env.TRUST_PROXY ? (String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
const sid = req => /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
async function session(req) {
  const t = sid(req);
  const s = t && await one('SELECT user_id FROM sessions WHERE hash=?', sha(t));
  const u = s && await one('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) throw err(401, 'Not signed in');
  if (u.status !== 'active') throw err(403, 'Account suspended');
  return u;
}
const login = async (res, u) => {
  const t = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions VALUES(?,?,?)', sha(t), u.id, now());
  return { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` };
};
const send = (res, c, d, h = {}) => { res.writeHead(c, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(d)); };
// Reads a request body of at most `max` bytes. Normally streams it; if the host already consumed the stream (some serverless runtimes do), uses what it parsed.
async function bodyBuffer(req, max, tooBig) {
  if (req.readableEnded && req.body !== undefined) return Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw tooBig; chunks.push(c); }
  return Buffer.concat(chunks);
}
const readBody = async req => {
  const b = (await bodyBuffer(req, 1.5e6, err(413, 'Payload too large'))).toString();
  try { return b ? JSON.parse(b) : {}; } catch { throw err(400, 'Bad JSON'); }
};
const str = (v, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw err(400, 'Invalid input'); return v.trim(); };
const audit = (u, a, t, q = { run }) => q.run('INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)', u.id, a, String(t), now());

// N-day series of counts keyed by UTC date; `sql` must select d (YYYY-MM-DD) and c, with its first parameter being the start timestamp.
async function daySeries(sql, days, ...p) {
  const day = 864e5, d0 = new Date(); d0.setUTCHours(0, 0, 0, 0); const t0 = d0.getTime() - (days - 1) * day;
  const m = Object.fromEntries((await all(sql, t0, ...p)).map(r => [r.d, r.c]));
  return Array.from({ length: days }, (_, i) => { const d = new Date(t0 + i * day).toISOString().slice(0, 10); return { d, c: m[d] || 0 }; });
}
const SITE = (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : `http://localhost:${PORT}`)).replace(/\/+$/, '');
// Sends via a webhook (MAIL_WEBHOOK_URL receives {to,subject,text}); without one, prints the email to the console (development only).
async function sendMail(to, subject, text) {
  if (!process.env.MAIL_WEBHOOK_URL) return console.log(`[DEV EMAIL] to=${to}\n${subject}\n${text}\n`);
  try { await fetch(process.env.MAIL_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, text }), signal: AbortSignal.timeout(10000) }); }
  catch (e) { console.error('mail failed:', e.message); }
}
// ---- Social sign-in (Google, GitHub): OAuth 2.0 authorization-code flow ----
const E = process.env;
const jget = async (url, tok) => (await fetch(url, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json', 'user-agent': 'Cogniva' }, signal: AbortSignal.timeout(10000) })).json();
const GH = E.GITHUB_API_URL || 'https://api.github.com';
const OAUTH = {
  google: { id: E.GOOGLE_CLIENT_ID, secret: E.GOOGLE_CLIENT_SECRET, scope: 'openid email profile',
    auth: E.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth', token: E.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    profile: async tok => { const r = await jget(E.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo', tok); return r.email && r.email_verified ? { email: r.email, name: r.name } : null; } },
  github: { id: E.GITHUB_CLIENT_ID, secret: E.GITHUB_CLIENT_SECRET, scope: 'read:user user:email',
    auth: E.GITHUB_AUTH_URL || 'https://github.com/login/oauth/authorize', token: E.GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
    profile: async tok => { const [u, em] = await Promise.all([jget(GH + '/user', tok), jget(GH + '/user/emails', tok)]);
      const p = Array.isArray(em) && em.find(x => x.primary && x.verified); return p ? { email: p.email, name: u.name || u.login } : null; } }
};
async function oauth(req, res, name, isCb) {
  const P = OAUTH[name], q = new URL(req.url, 'http://x').searchParams, ck = n => new RegExp('(?:^|; )' + n + '=([^;]*)').exec(req.headers.cookie || '')?.[1];
  const go = (loc, cookies = []) => { res.writeHead(302, { location: loc, 'set-cookie': [...(isCb ? ['oauth=; Max-Age=0; Path=/auth'] : []), ...cookies] }); res.end(); };
  const back = e => go('/?auth_error=' + e);
  if (!P.id || !P.secret) return back('not_configured');
  const redirect = `${SITE}/auth/${name}/callback`;
  if (!isCb) {
    const state = crypto.randomBytes(16).toString('hex'), role = q.get('role') === 'teacher' ? 'teacher' : 'student';
    return go(P.auth + '?' + new URLSearchParams({ client_id: P.id, redirect_uri: redirect, response_type: 'code', scope: P.scope, state }),
      [`oauth=${state}.${role}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`]);
  }
  const [st, role] = (ck('oauth') || '').split('.');
  if (!st || st !== q.get('state') || !q.get('code')) return back('failed');   // state check = CSRF protection for the login flow
  try {
    const tr = await fetch(P.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: P.id, client_secret: P.secret, code: q.get('code'), redirect_uri: redirect, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10000) });
    const tok = (await tr.json()).access_token; if (!tok) return back('failed');
    const prof = await P.profile(tok); if (!prof) return back('no_email');
    const email = prof.email.toLowerCase().trim(); let u = (await one('SELECT * FROM users WHERE email=?', email));
    const unusable = () => hashPw(crypto.randomBytes(32).toString('hex'));
    if (!u) {
      const id = (await ins('INSERT INTO users(name,email,pass,role,provider,created) VALUES(?,?,?,?,?,?)', String(prof.name || email.split('@')[0]).slice(0, 100), email, unusable(), role === 'teacher' ? 'teacher' : 'student', name, now()));
      u = (await one('SELECT * FROM users WHERE id=?', Number(id)));
    } else {
      if (u.status !== 'active') return back('suspended');
      if (!u.provider) {   // first social login into a password account: retire the old password + sessions so nobody who pre-registered this email keeps access
        (await run('UPDATE users SET pass=?,provider=? WHERE id=?', unusable(), name, u.id)); (await run('DELETE FROM sessions WHERE user_id=?', u.id));
      }
    }
    return go('/app', [(await login(res, u))['set-cookie']]);
  } catch (e) { console.error('oauth error:', e.message); return back('failed'); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";

const PUB = fileURLToPath(new URL('./public/', import.meta.url));
const who = async req => { try { return await session(req); } catch { return null; } };
async function serveStatic(p, req, res) {
  // signed in -> the login page sends you straight to the app; signed out -> the app sends you to the login page
  if ((p === '/' || p === '/index.html') && (await who(req))) { res.writeHead(302, { location: '/app' }); return res.end(); }
  // a stale or invalid cookie is cleared here, otherwise a host that redirects '/' to '/app' whenever a cookie exists would loop
  if (p === '/app' && !(await who(req))) { res.writeHead(302, { location: '/', 'set-cookie': 'sid=; Max-Age=0; Path=/' }); return res.end(); }
  let full = p === '/app' ? fileURLToPath(new URL('./app.html', import.meta.url)) : path.join(PUB, p === '/' ? 'index.html' : p.slice(1));
  if (p !== '/app' && !full.startsWith(PUB)) full = '';
  let ok = false; try { ok = !!full && fs.statSync(full).isFile() && !!MIME[path.extname(full)]; } catch {}
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)], 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
  res.end(fs.readFileSync(full));
}

// Raw-body upload: the file's bytes are the request body, its name travels in the x-filename header. Text is extracted server-side, then stored like any other document.
async function upload(req, res) {
  const u = await session(req), max = maxUpload();
  if (Number(req.headers['content-length'] || 0) > max) throw err(413, `File too large (max ${max / 1048576} MB)`);
  const buf = await bodyBuffer(req, max, err(413, `File too large (max ${max / 1048576} MB)`)); if (!buf.length) throw err(400, 'Empty file');
  let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch {}
  name = path.basename(name.replace(/\\/g, '/')).slice(0, 200) || 'file';
  let used = false; const meter = fn => used ? fn() : (used = true, metered(u, 'upload', fn));   // AI-assisted reading (images, speech, scanned PDFs) costs one request
  let r; try { r = await extract(buf, name, String(req.headers['content-type'] || ''), meter); }
  catch (e) { if (typeof e.code === 'number') throw e; console.error('extract failed:', e); throw err(422, 'Could not read this file: ' + String(e.message).slice(0, 150)); }
  const id = (await ins('INSERT INTO docs(user_id,name,text,ts,kind) VALUES(?,?,?,?,?)', u.id, name, r.text, now(), r.kind));
  return send(res, 201, { id: Number(id), kind: r.kind, chars: r.text.length, truncated: r.truncated, note: r.note });
}

export async function handle(req, res) {
  try {
    await ready;
    const p = new URL(req.url, 'http://x').pathname, m = req.method; let mt;
    if (m === 'GET' && (mt = p.match(/^\/auth\/(google|github)(\/callback)?$/))) return oauth(req, res, mt[1], !!mt[2]);
    if (!p.startsWith('/api/')) return serveStatic(p, req, res);
    if (m !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw err(403, 'Bad origin');
    if (m === 'POST' && p === '/api/docs/upload') return await upload(req, res);
    const b = m === 'GET' || m === 'DELETE' ? {} : await readBody(req);
    const R = (meth, re) => m === meth && (mt = p.match(re));

    if (R('POST', /^\/api\/register$/)) {
      const email = str(b.email, 200).toLowerCase(), pw = str(b.password, 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pw.length < 8) throw err(400, 'Valid email and a password of at least 8 characters are required');
      if (!['student', 'teacher'].includes(b.role)) throw err(400, 'Invalid role');
      if ((await one('SELECT 1 FROM users WHERE email=?', email))) throw err(409, 'Email already registered');
      const id = (await ins('INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,?,?)', str(b.name, 100), email, hashPw(pw), b.role, now()));
      return send(res, 201, { ok: true }, (await login(res, { id: Number(id) })));
    }
    if (R('POST', /^\/api\/login$/)) {
      const ip = clientIp(req);
      if (await rlCount(ip) >= 10) throw err(429, 'Too many attempts. Try again later.');
      const u = (await one('SELECT * FROM users WHERE email=?', String(b.email || '').toLowerCase()));
      if (!u || !checkPw(String(b.password || ''), u.pass)) { await rlBump(ip); throw err(401, 'Invalid email or password'); }
      if (u.status !== 'active') throw err(403, 'Account suspended');
      return send(res, 200, { ok: true }, (await login(res, u)));
    }
    if (R('POST', /^\/api\/logout$/)) {
      const k = sid(req); if (k) await run('DELETE FROM sessions WHERE hash=?', sha(k));
      return send(res, 200, { ok: true }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
    }

    if (R('POST', /^\/api\/forgot$/)) {
      const k = 'f' + clientIp(req);
      if (await rlCount(k) >= 5) throw err(429, 'Too many attempts. Try again later.');
      await rlBump(k);
      const fu = (await one('SELECT * FROM users WHERE email=?', String(b.email || '').toLowerCase().trim()));
      if (fu && fu.status === 'active') {
        const tok = crypto.randomBytes(32).toString('hex');
        (await run('DELETE FROM reset_tokens WHERE user_id=?', fu.id));
        (await run('INSERT INTO reset_tokens VALUES(?,?,?)', sha(tok), fu.id, now() + 36e5));
        await sendMail(fu.email, 'Reset your Cogniva password', `Open this link within 1 hour to choose a new password:\n${SITE}/reset.html?token=${tok}\n\nIf you did not ask for this, ignore this email.`);
      }
      return send(res, 200, { ok: true });   // same answer whether or not the email exists
    }
    if (R('POST', /^\/api\/reset$/)) {
      const pw = str(b.password, 200); if (pw.length < 8) throw err(400, 'Password must be at least 8 characters');
      const rt = (await one('SELECT * FROM reset_tokens WHERE hash=? AND expires>?', sha(String(b.token || '')), now()));
      if (!rt) throw err(400, 'Invalid or expired link');
      await tx(async t => {
        await t.run('UPDATE users SET pass=? WHERE id=?', hashPw(pw), rt.user_id);
        await t.run('DELETE FROM reset_tokens WHERE user_id=?', rt.user_id);
        await t.run('DELETE FROM sessions WHERE user_id=?', rt.user_id);   // sign out everywhere
      });
      return send(res, 200, { ok: true });
    }

    const u = (await session(req));
    const admin = () => { if (u.role !== 'admin') throw err(403, 'Forbidden'); };
    if (R('GET', /^\/api\/me$/)) return send(res, 200, { user: (await publicUser(u)) });
    if (R('PATCH', /^\/api\/me$/)) {
      if (['en', 'ar'].includes(b.lang)) (await run('UPDATE users SET lang=? WHERE id=?', b.lang, u.id));
      if (['dark', 'light'].includes(b.theme)) (await run('UPDATE users SET theme=? WHERE id=?', b.theme, u.id));
      return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/docs$/)) return send(res, 200, { docs: (await all('SELECT id,name,kind,length(text) size,ts FROM docs WHERE user_id=? ORDER BY id DESC', u.id)) });
    if (R('GET', /^\/api\/docs\/caps$/)) return send(res, 200, await caps());
    if (R('GET', /^\/api\/docs\/(\d+)$/)) { const d = (await one('SELECT id,name,kind,text FROM docs WHERE id=? AND user_id=?', mt[1], u.id)); if (!d) throw err(404, 'Not found'); return send(res, 200, { name: d.name, kind: d.kind, size: d.text.length, text: d.text.slice(0, 20000) }); }
    if (R('POST', /^\/api\/docs$/)) {
      const id = (await ins('INSERT INTO docs(user_id,name,text,ts) VALUES(?,?,?,?)', u.id, str(b.name, 200), str(b.text, 500000), now()));
      return send(res, 201, { id: Number(id) });
    }
    if (R('DELETE', /^\/api\/docs\/(\d+)$/)) { (await run('DELETE FROM docs WHERE id=? AND user_id=?', mt[1], u.id)); return send(res, 200, { ok: true }); }
    // One or more of the user's documents (docIds: [..]; the old single docId still works). Returns null when none is chosen.
    // The prompt budget (~12k chars) is shared, so several long documents still fit in one AI request.
    const docsText = async (b, query = '') => {
      const ids = [...new Set((Array.isArray(b.docIds) ? b.docIds : b.docId ? [b.docId] : []).map(Number).filter(Number.isInteger))].slice(0, 10);
      if (!ids.length) return null;
      const rows = await Promise.all(ids.map(id => one('SELECT name,text FROM docs WHERE id=? AND user_id=?', id, u.id)));
      if (rows.some(r => !r)) throw err(404, 'Document not found');
      if (rows.length === 1) return pick(rows[0].text, query);
      const each = Math.floor(11500 / rows.length);
      return rows.map(r => `=== ${r.name} ===\n` + pick(r.text, query, each)).join('\n\n');
    };

    if (R('GET', /^\/api\/messages$/)) return send(res, 200, { messages: (await all('SELECT role,content FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id)).reverse() });
    if (R('POST', /^\/api\/chat$/)) {
      const msg = str(b.message, 4000), doc = (await docsText(b, msg));
      const sys = 'You are Cogniva, an academic study assistant. Be accurate and clear.' + (doc ? ' The student attached one or more documents. Use them when relevant and say explicitly whether an answer comes from the document or from general knowledge. Never invent quotes or page citations.\n\nDOCUMENT:\n' + doc : '');
      const hist = (await all('SELECT role,content FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id)).reverse();
      const reply = await metered(u, 'chat', () => ai([{ role: 'system', content: sys }, ...hist, { role: 'user', content: msg }]));
      (await run('INSERT INTO messages(user_id,role,content,ts) VALUES(?,?,?,?),(?,?,?,?)', u.id, 'user', msg, now(), u.id, 'assistant', reply, now()));
      return send(res, 200, { reply });
    }
    if (R('GET', /^\/api\/exams$/)) return send(res, 200, { exams: (await all('SELECT e.id,e.title,e.ts,(SELECT MAX(100.0*score/total) FROM attempts a WHERE a.exam_id=e.id) best FROM exams e WHERE user_id=? ORDER BY id DESC', u.id)) });
    if (R('POST', /^\/api\/exams$/)) {
      const src = (await docsText(b)) ?? (b.text ? pick(str(b.text, 20000)) : null); if (!src) throw err(400, 'Choose a document or enter text/topic');
      const n = Math.min(10, Math.max(3, Number(b.n) || 5));
      const out = await metered(u, 'exam', () => ai([{ role: 'system', content: 'Return ONLY JSON: {"questions":[{"q":string,"options":[4 strings],"answer":0-3,"explanation":string}]}. Write in the same language as the source.' },
        { role: 'user', content: `Create ${n} multiple-choice questions from:\n${src}` }], true));
      let qs; try { qs = parseJson(out).questions; } catch { throw err(502, 'AI returned invalid exam data'); }
      qs = (qs || []).filter(x => x.q && Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4);
      if (!qs.length) throw err(502, 'AI returned no valid questions');
      const id = (await ins('INSERT INTO exams(user_id,title,qs,ts) VALUES(?,?,?,?)', u.id, str(b.title || 'Exam', 100), JSON.stringify(qs), now()));
      return send(res, 201, { id: Number(id) });
    }
    if (R('GET', /^\/api\/exams\/(\d+)$/)) {
      const e = (await one('SELECT * FROM exams WHERE id=? AND user_id=?', mt[1], u.id)); if (!e) throw err(404, 'Not found');
      return send(res, 200, { title: e.title, questions: JSON.parse(e.qs).map(({ q, options }) => ({ q, options })) });
    }
    if (R('POST', /^\/api\/exams\/(\d+)\/submit$/)) {
      const e = (await one('SELECT * FROM exams WHERE id=? AND user_id=?', mt[1], u.id)); if (!e) throw err(404, 'Not found');
      const qs = JSON.parse(e.qs), a = Array.isArray(b.answers) ? b.answers : [];
      const review = qs.map((q, i) => ({ correct: a[i] === q.answer, answer: q.answer, picked: a[i] ?? null, explanation: q.explanation || '' }));
      const score = review.filter(r => r.correct).length;
      (await run('INSERT INTO attempts(exam_id,user_id,score,total,ts) VALUES(?,?,?,?,?)', e.id, u.id, score, qs.length, now()));
      return send(res, 200, { score, total: qs.length, review });
    }
    if (R('GET', /^\/api\/payments$/)) return send(res, 200, { payments: (await all('SELECT id,ref,status,ts,amount,days,note FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id)) });
    if (R('POST', /^\/api\/payments$/)) {
      const S = await settings(); if (!S.instapay_handle) throw err(503, 'Payments are not set up yet. Please contact the administrator.');
      const ref = str(b.ref, 100); if (ref.length < 4) throw err(400, 'Enter the payment reference (at least 4 characters)');
      if ((await one("SELECT 1 FROM payments WHERE user_id=? AND status='pending'", u.id))) throw err(409, 'You already have a pending request');
      if ((await one('SELECT COUNT(*) c FROM payments WHERE user_id=? AND ts>?', u.id, now() - 864e5)).c >= 5) throw err(429, 'Too many requests today. Try again tomorrow.');
      // a transfer reference can pay for one request only (stops the same receipt being reused by several accounts)
      if ((await one("SELECT 1 FROM payments WHERE lower(ref)=lower(?) AND status IN ('pending','approved')", ref))) throw err(409, 'This payment reference was already used');
      const id = (await ins('INSERT INTO payments(user_id,ref,ts,amount,days) VALUES(?,?,?,?,?)', u.id, ref, now(), Number(S.premium_price), Math.round(Number(S.premium_days))));
      if (process.env.ADMIN_EMAIL) await sendMail(process.env.ADMIN_EMAIL, 'New Premium request', `${u.name} <${u.email}> sent payment reference "${ref}".\nReview it: ${SITE}/app (Administration > Payments)`);
      return send(res, 201, { ok: true, id: Number(id) });
    }
    if (R('DELETE', /^\/api\/payments\/(\d+)$/)) {   // the student withdraws a request that is still pending
      const r = (await run("UPDATE payments SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'", mt[1], u.id));
      if (!r) throw err(404, 'No pending request'); return send(res, 200, { ok: true });
    }

    if (R('GET', /^\/api\/insights$/)) return send(res, 200, {
      usage: (await daySeries(`SELECT ${dayOf('ts')} d,COUNT(*) c FROM usage WHERE ts>=? AND user_id=? GROUP BY d`, 7, u.id)),
      scores: (await all('SELECT ROUND(100.0*score/total) p FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id)).reverse().map(r => r.p) });
    // ---- flashcards (SM-2 spaced repetition) ----
    if (R('GET', /^\/api\/cards$/)) return send(res, 200, {
      due: (await all('SELECT id,front,back FROM cards WHERE user_id=? AND due<=? ORDER BY due LIMIT 50', u.id, now())),
      cards: (await all('SELECT id,front,back FROM cards WHERE user_id=? ORDER BY id DESC LIMIT 100', u.id)),
      mastered: (await one('SELECT COUNT(*) c FROM cards WHERE user_id=? AND ivl>=21', u.id)).c });
    if (R('POST', /^\/api\/cards$/)) {
      (await run('INSERT INTO cards(user_id,front,back,due,created) VALUES(?,?,?,?,?)', u.id, str(b.front, 500), str(b.back, 1000), now(), now()));
      return send(res, 201, { ok: true });
    }
    if (R('POST', /^\/api\/cards\/generate$/)) {
      const src = (await docsText(b)) ?? (b.text ? pick(str(b.text, 20000)) : null); if (!src) throw err(400, 'Choose a document or enter text/topic');
      const n = Math.min(15, Math.max(3, Number(b.n) || 8));
      const out = await metered(u, 'cards', () => ai([{ role: 'system', content: 'Return ONLY JSON: {"cards":[{"front":string,"back":string}]}. Concise, one fact per card, same language as the source.' },
        { role: 'user', content: `Create ${n} flashcards from:\n${src}` }], true));
      let cs; try { cs = parseJson(out).cards; } catch { throw err(502, 'AI returned invalid card data'); }
      cs = (cs || []).filter(c => typeof c.front === 'string' && typeof c.back === 'string' && c.front && c.back).slice(0, n);
      if (!cs.length) throw err(502, 'AI returned no valid cards');
      await tx(async t => { for (const c of cs) await t.run('INSERT INTO cards(user_id,front,back,due,created) VALUES(?,?,?,?,?)', u.id, c.front.slice(0, 500), c.back.slice(0, 1000), now(), now()); });
      return send(res, 201, { added: cs.length });
    }
    if (R('POST', /^\/api\/cards\/(\d+)\/review$/)) {
      const c = (await one('SELECT * FROM cards WHERE id=? AND user_id=?', mt[1], u.id)); if (!c) throw err(404, 'Not found');
      const q = Number(b.q); if (![1, 3, 4, 5].includes(q)) throw err(400, 'Invalid rating');
      let { reps, ivl, ef } = c;
      if (q < 3) { reps = 0; ivl = 1; } else { reps++; ivl = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(ivl * ef); }
      ef = Math.max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
      (await run('UPDATE cards SET reps=?,ivl=?,ef=?,due=? WHERE id=?', reps, ivl, ef, now() + ivl * 864e5, c.id));
      return send(res, 200, { next_in_days: ivl });
    }
    if (R('DELETE', /^\/api\/cards\/(\d+)$/)) { (await run('DELETE FROM cards WHERE id=? AND user_id=?', mt[1], u.id)); return send(res, 200, { ok: true }); }
    // ---- study planner ----
    if (R('GET', /^\/api\/tasks$/)) return send(res, 200, { tasks: (await all('SELECT id,title,due,done FROM tasks WHERE user_id=? ORDER BY done,(due IS NULL),due LIMIT 200', u.id)) });
    if (R('POST', /^\/api\/tasks$/)) {
      const due = b.due == null ? null : Math.round(Number(b.due)); if (due !== null && !Number.isFinite(due)) throw err(400, 'Invalid date');
      (await run('INSERT INTO tasks(user_id,title,due,ts) VALUES(?,?,?,?)', u.id, str(b.title, 200), due, now()));
      return send(res, 201, { ok: true });
    }
    if (R('PATCH', /^\/api\/tasks\/(\d+)$/)) { (await run('UPDATE tasks SET done=? WHERE id=? AND user_id=?', b.done ? 1 : 0, mt[1], u.id)); return send(res, 200, { ok: true }); }
    if (R('DELETE', /^\/api\/tasks\/(\d+)$/)) { (await run('DELETE FROM tasks WHERE id=? AND user_id=?', mt[1], u.id)); return send(res, 200, { ok: true }); }

    // ---- teacher: courses, assignments, grading (access checked per course) ----
    const course = async id => {
      const c = (await one('SELECT * FROM courses WHERE id=?', id)); if (!c) throw err(404, 'Not found');
      const teacher = c.teacher_id === u.id, student = !!(await one('SELECT 1 FROM enrollments WHERE course_id=? AND user_id=?', id, u.id));
      if (!teacher && !student && u.role !== 'admin') throw err(404, 'Not found');
      return { c, teacher, student };
    };
    const ownCourse = async id => { const r = (await course(id)); if (!r.teacher) throw err(403, 'Forbidden'); return r.c; };
    if (R('GET', /^\/api\/courses$/)) return send(res, 200, { courses: u.role === 'teacher'
      ? (await all('SELECT c.id,c.title,c.code,(SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) students FROM courses c WHERE teacher_id=? ORDER BY id DESC', u.id))
      : (await all('SELECT c.id,c.title FROM courses c JOIN enrollments e ON e.course_id=c.id WHERE e.user_id=? ORDER BY c.id DESC', u.id)) });
    if (R('POST', /^\/api\/courses$/)) {
      if (u.role !== 'teacher') throw err(403, 'Only teachers can create courses');
      const title = str(b.title, 150); let code;
      do code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); while ((await one('SELECT 1 FROM courses WHERE code=?', code)));
      return send(res, 201, { id: Number((await ins('INSERT INTO courses(teacher_id,title,code,ts) VALUES(?,?,?,?)', u.id, title, code, now()))), code });
    }
    if (R('POST', /^\/api\/courses\/join$/)) {
      if (u.role !== 'student') throw err(403, 'Only students can join courses');
      const c = (await one('SELECT id FROM courses WHERE code=?', str(b.code, 20).toUpperCase())); if (!c) throw err(404, 'Invalid course code');
      (await run('INSERT INTO enrollments VALUES(?,?) ON CONFLICT DO NOTHING', c.id, u.id)); return send(res, 200, { id: c.id });
    }
    if (R('GET', /^\/api\/courses\/(\d+)$/)) {
      const { c, teacher } = (await course(mt[1]));
      return send(res, 200, { teacher, course: { id: c.id, title: c.title, code: teacher ? c.code : undefined },
        assignments: teacher
          ? (await all('SELECT a.id,a.title,a.description,a.due,(SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) subs,(SELECT ROUND(AVG(grade)) FROM submissions s WHERE s.assignment_id=a.id) avg FROM assignments a WHERE a.course_id=? ORDER BY a.id DESC', c.id))
          : (await all('SELECT a.id,a.title,a.description,a.due,s.text,s.grade,s.feedback FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id AND s.user_id=? WHERE a.course_id=? ORDER BY a.id DESC', u.id, c.id)),
        students: teacher ? (await all('SELECT u.name,u.email FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=?', c.id)) : undefined });
    }
    if (R('POST', /^\/api\/courses\/(\d+)\/assignments$/)) {
      const c = (await ownCourse(mt[1])), due = b.due == null ? null : Math.round(Number(b.due)); if (due !== null && !Number.isFinite(due)) throw err(400, 'Invalid date');
      (await run('INSERT INTO assignments(course_id,title,description,due,ts) VALUES(?,?,?,?,?)', c.id, str(b.title, 200), b.description ? str(b.description, 5000) : '', due, now()));
      return send(res, 201, { ok: true });
    }
    if (R('POST', /^\/api\/assignments\/(\d+)\/submit$/)) {
      const a = (await one('SELECT * FROM assignments WHERE id=?', mt[1])); if (!a) throw err(404, 'Not found');
      if (!(await course(a.course_id)).student) throw err(403, 'Forbidden');
      if ((await one('SELECT 1 FROM submissions WHERE assignment_id=? AND user_id=? AND grade IS NOT NULL', a.id, u.id))) throw err(409, 'Already graded');
      (await run('INSERT INTO submissions(assignment_id,user_id,text,ts) VALUES(?,?,?,?) ON CONFLICT(assignment_id,user_id) DO UPDATE SET text=excluded.text,ts=excluded.ts', a.id, u.id, str(b.text, 20000), now()));
      return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/assignments\/(\d+)\/submissions$/)) {
      const a = (await one('SELECT * FROM assignments WHERE id=?', mt[1])); if (!a) throw err(404, 'Not found'); (await ownCourse(a.course_id));
      return send(res, 200, { submissions: (await all('SELECT s.id,s.text,s.grade,s.feedback,s.ts,u.name FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.assignment_id=? ORDER BY s.ts', a.id)) });
    }
    if (R('POST', /^\/api\/submissions\/(\d+)\/grade$/)) {
      const s = (await one('SELECT s.id,a.course_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?', mt[1])); if (!s) throw err(404, 'Not found'); (await ownCourse(s.course_id));
      const g = Number(b.grade); if (!Number.isInteger(g) || g < 0 || g > 100) throw err(400, 'Grade must be an integer from 0 to 100');
      (await run('UPDATE submissions SET grade=?,feedback=? WHERE id=?', g, String(b.feedback || '').slice(0, 2000), s.id)); return send(res, 200, { ok: true });
    }

    // ---- admin (server-side role check on every route) ----
    if (R('GET', /^\/api\/admin\/stats$/)) { admin(); return send(res, 200, {
      users: (await one('SELECT COUNT(*) c FROM users')).c, teachers: (await one("SELECT COUNT(*) c FROM users WHERE role='teacher'")).c,
      premium: (await one("SELECT COUNT(*) c FROM users WHERE plan='premium' AND plan_expires>?", now())).c,
      ai7d: (await one('SELECT COUNT(*) c FROM usage WHERE ts>?', now() - WEEK)).c, docs: (await one('SELECT COUNT(*) c FROM docs')).c,
      settings: await settings(), audit: (await all('SELECT * FROM audit ORDER BY id DESC LIMIT 15')) }); }
    if (R('GET', /^\/api\/admin\/users$/)) { admin(); return send(res, 200, { users: (await all('SELECT id,name,email,role,status,plan,plan_expires,quota,created,(SELECT COUNT(*) FROM usage x WHERE x.user_id=users.id AND x.ts>?) used FROM users ORDER BY id DESC LIMIT 500', now() - WEEK)) }); }
    if (R('GET', /^\/api\/admin\/analytics$/)) {
      admin(); const cnt = async q => (await one(q)).c;
      return send(res, 200, {
        signups: (await daySeries(`SELECT ${dayOf('created')} d,COUNT(*) c FROM users WHERE created>=? GROUP BY d`, 14)),
        ai: (await daySeries(`SELECT ${dayOf('ts')} d,COUNT(*) c FROM usage WHERE ts>=? GROUP BY d`, 14)),
        byKind: (await all('SELECT kind,COUNT(*) c FROM usage WHERE ts>? GROUP BY kind', now() - 30 * 864e5)),
        byRole: (await all('SELECT role,COUNT(*) c FROM users GROUP BY role')),
        top: (await all('SELECT u.email,COUNT(*) c FROM usage x JOIN users u ON u.id=x.user_id WHERE x.ts>? GROUP BY u.id ORDER BY c DESC LIMIT 5', now() - WEEK)),
        totals: { exams: await cnt('SELECT COUNT(*) c FROM attempts'), avg: Math.round((await one('SELECT AVG(100.0*score/total) a FROM attempts')).a ?? 0), cards: await cnt('SELECT COUNT(*) c FROM cards'),
          courses: await cnt('SELECT COUNT(*) c FROM courses'), submissions: await cnt('SELECT COUNT(*) c FROM submissions'),
          active7: (await one('SELECT COUNT(DISTINCT user_id) c FROM usage WHERE ts>?', now() - WEEK)).c, pending: await cnt("SELECT COUNT(*) c FROM payments WHERE status='pending'"),
          revenue: (await one("SELECT COALESCE(SUM(COALESCE(amount,?)),0) s FROM payments WHERE status='approved'", Number((await setting('premium_price'))))).s } });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/quota$/)) {
      admin(); let q = b.limit; if (q !== null) { q = Number(q); if (!Number.isInteger(q) || q < 0 || q > 100000) throw err(400, 'Invalid quota'); }
      if (!(await one('SELECT 1 FROM users WHERE id=?', mt[1]))) throw err(404, 'Not found');
      (await run('UPDATE users SET quota=? WHERE id=?', q, mt[1])); (await audit(u, 'quota.set', mt[1] + ':' + (q ?? 'default'))); return send(res, 200, { ok: true });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/plan$/)) {
      admin(); if (!['premium', 'free'].includes(b.plan)) throw err(400, 'Invalid plan');
      const tu = (await one('SELECT plan_expires e FROM users WHERE id=?', mt[1])); if (!tu) throw err(404, 'Not found');
      const days = Math.min(3650, Math.max(1, Number(b.days) || Number((await setting('premium_days')))));
      (await run('UPDATE users SET plan=?,plan_expires=? WHERE id=?', b.plan, b.plan === 'premium' ? Math.round(Math.max(now(), tu.e || 0) + days * 864e5) : 0, mt[1]));
      (await audit(u, 'plan.' + b.plan, mt[1])); return send(res, 200, { ok: true });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/status$/)) {
      admin(); if (!['active', 'suspended'].includes(b.status) || Number(mt[1]) === u.id) throw err(400, 'Invalid request');
      (await run('UPDATE users SET status=? WHERE id=?', b.status, mt[1]));
      if (b.status === 'suspended') (await run('DELETE FROM sessions WHERE user_id=?', mt[1]));
      (await audit(u, 'user.' + b.status, mt[1])); return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/admin\/payments$/)) { admin(); return send(res, 200, { payments: (await all('SELECT p.id,p.ref,p.status,p.ts,p.amount,p.note,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY (p.status=\'pending\') DESC,p.id DESC LIMIT 100')) }); }
    if (R('POST', /^\/api\/admin\/payments\/(\d+)\/(approve|reject)$/)) {
      admin(); const pay = (await one("SELECT * FROM payments WHERE id=? AND status='pending'", mt[1])); if (!pay) throw err(404, 'No pending payment');
      const approve = mt[2] === 'approve', note = approve ? null : String(b.note || '').trim().slice(0, 200) || null;
      const days = Number(pay.days) || Number((await setting('premium_days')));   // the days that were on offer when the student paid
      await tx(async t => {
        await t.run('UPDATE payments SET status=?,note=? WHERE id=?', approve ? 'approved' : 'rejected', note, pay.id);
        // renewing while still Premium adds the days on top of the current expiry instead of overwriting it
        if (approve) await t.run("UPDATE users SET plan='premium',plan_expires=(CASE WHEN plan_expires>CAST(? AS BIGINT) THEN plan_expires ELSE CAST(? AS BIGINT) END)+CAST(? AS BIGINT) WHERE id=?", now(), now(), Math.round(days * 864e5), pay.user_id);
        await audit(u, 'payment.' + mt[2], pay.id, t);
      });
      const pu = (await one('SELECT email,name,plan_expires FROM users WHERE id=?', pay.user_id));
      if (pu) await sendMail(pu.email, approve ? 'Your Cogniva Premium is active' : 'Your Cogniva Premium request was not approved',
        approve ? `Hi ${pu.name},\nYour Premium plan is active until ${new Date(pu.plan_expires).toISOString().slice(0, 10)}. Thank you!\n${SITE}/app`
                : `Hi ${pu.name},\nWe could not confirm your payment reference "${pay.ref}".${note ? '\nReason: ' + note : ''}\nYou can send a new request from the Subscription page.`);
      return send(res, 200, { ok: true });
    }
    if (R('PUT', /^\/api\/admin\/settings$/)) {
      admin();
      for (const k of Object.keys(DEF)) if (b[k] !== undefined) {
        if (NUMERIC.includes(k) && !(Number(b[k]) >= 0)) throw err(400, 'Invalid ' + k);
        if (k === 'premium_days' && !(Number(b[k]) >= 1)) throw err(400, 'Premium days must be at least 1');
        if (k === 'premium_currency' && !/^[\p{L}$€£¥]{1,8}$/u.test(String(b[k]).trim())) throw err(400, 'Invalid currency');
        (await run('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(b[k]).trim().slice(0, 200)));
      }
      (await audit(u, 'settings.update', '-')); return send(res, 200, { ok: true });
    }
    throw err(404, 'Not found');
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(e);
    send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Server error' });
  }
}
// `node server.mjs` starts a normal server; on Vercel the same handler is used by api/index.js instead.
if (!process.env.VERCEL && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  http.createServer(handle).listen(PORT, () => console.log('Cogniva on http://localhost:' + PORT));


// Vercel may detect this module directly; expose its handler as the default export.
export default handle;
