import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

try { process.loadEnvFile(); } catch {}   // reads settings from a .env file next to server.mjs, if present
const PORT = process.env.PORT || 3000;
const KEY = process.env.AI_API_KEY;
const BASE = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');   // any OpenAI-compatible endpoint (OpenAI, Gemini, ...)
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const DB_FILE = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/cogniva.db' : 'cogniva.db');
if (process.env.VERCEL && !process.env.DB_PATH) console.warn('[cogniva] Vercel: the SQLite file is in /tmp, which is temporary and not shared between instances. Use a persistent database/host for real data.');
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,pass TEXT,role TEXT DEFAULT 'student',status TEXT DEFAULT 'active',plan TEXT DEFAULT 'free',plan_expires INTEGER DEFAULT 0,lang TEXT DEFAULT 'en',theme TEXT DEFAULT 'dark',created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,created INTEGER);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,kind TEXT,ts INTEGER);
CREATE INDEX IF NOT EXISTS usage_u ON usage(user_id,ts);
CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,name TEXT,text TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,role TEXT,content TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS exams(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,title TEXT,qs TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,user_id INTEGER,score INTEGER,total INTEGER,ts INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,ref TEXT,status TEXT DEFAULT 'pending',ts INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,front TEXT,back TEXT,ef REAL DEFAULT 2.5,reps INTEGER DEFAULT 0,ivl INTEGER DEFAULT 0,due INTEGER,created INTEGER);
CREATE INDEX IF NOT EXISTS cards_u ON cards(user_id,due);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,title TEXT,due INTEGER,done INTEGER DEFAULT 0,ts INTEGER);
CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY,teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,title TEXT,code TEXT UNIQUE,ts INTEGER);
CREATE TABLE IF NOT EXISTS enrollments(course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(course_id,user_id));
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY,course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,title TEXT,description TEXT,due INTEGER,ts INTEGER);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY,assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,text TEXT,grade INTEGER,feedback TEXT,ts INTEGER,UNIQUE(assignment_id,user_id));
CREATE TABLE IF NOT EXISTS reset_tokens(hash TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,expires INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor INTEGER,action TEXT,target TEXT,ts INTEGER);
`);
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);
const run = (s, ...p) => db.prepare(s).run(...p);
const DEF = { free_limit: 30, premium_limit: 100, premium_days: 30, premium_price: 0, instapay_handle: '' };
try { db.exec('ALTER TABLE users ADD COLUMN provider TEXT'); } catch {}   // 'google' | 'github' once the account is linked to social sign-in
try { db.exec('ALTER TABLE users ADD COLUMN quota INTEGER'); } catch {}   // per-user weekly quota override (NULL = plan default)
const setting = k => one('SELECT v FROM settings WHERE k=?', k)?.v ?? DEF[k];
const WEEK = 7 * 864e5, now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const err = (code, msg) => Object.assign(new Error(msg), { code });
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, st) => { const [s, h] = st.split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// Admin account comes from the server's environment only (never from the web): created if missing, promoted if that email already registered.
if (process.env.ADMIN_EMAIL) {
  const ae = process.env.ADMIN_EMAIL.toLowerCase().trim(), ex = one('SELECT * FROM users WHERE email=?', ae);
  if (!ex && process.env.ADMIN_PASSWORD) run('INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,?,?)', 'Administrator', ae, hashPw(process.env.ADMIN_PASSWORD), 'admin', now());
  else if (ex && ex.role !== 'admin') { run("UPDATE users SET role='admin' WHERE id=?", ex.id); console.log('Promoted ' + ae + ' to admin'); }
}

const plan = u => (u.plan === 'premium' && u.plan_expires > now() ? 'premium' : 'free');
const usedOf = u => one('SELECT COUNT(*) c FROM usage WHERE user_id=? AND ts>?', u.id, now() - WEEK).c;
const limitOf = u => (u.quota != null ? u.quota : Number(setting(plan(u) + '_limit')));
// Reserve one AI request. Synchronous, so check+insert cannot interleave with another request.
function reserve(u, kind) {
  if (usedOf(u) >= limitOf(u)) throw err(429, 'Weekly AI limit reached. Upgrade to Premium or wait for the window to reset.');
  return Number(run('INSERT INTO usage(user_id,kind,ts) VALUES(?,?,?)', u.id, kind, now()).lastInsertRowid);
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
async function metered(u, kind, fn) {
  const id = reserve(u, kind);
  try { return await fn(); } catch (e) { run('DELETE FROM usage WHERE id=?', id); throw e; }
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, lang: u.lang, theme: u.theme, plan: plan(u), plan_expires: u.plan_expires,
  usage: { used: usedOf(u), limit: limitOf(u) }, instapay: setting('instapay_handle'),
  stats: { docs: one('SELECT COUNT(*) c FROM docs WHERE user_id=?', u.id).c, due: one('SELECT COUNT(*) c FROM cards WHERE user_id=? AND due<=?', u.id, now()).c, attempts: one('SELECT COUNT(*) c FROM attempts WHERE user_id=?', u.id).c,
    avg: Math.round(one('SELECT AVG(100.0*score/total) a FROM attempts WHERE user_id=?', u.id).a ?? 0) } });

const tries = new Map();
function session(req) {
  const m = /(?:^|; )sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const s = m && one('SELECT user_id FROM sessions WHERE hash=?', sha(m[1]));
  const u = s && one('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) throw err(401, 'Not signed in');
  if (u.status !== 'active') throw err(403, 'Account suspended');
  return u;
}
const login = (res, u) => {
  const t = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?)', sha(t), u.id, now());
  return { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` };
};
const send = (res, c, d, h = {}) => { res.writeHead(c, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(d)); };
const readBody = req => {
  let pre; try { pre = req.body; } catch { return Promise.reject(err(400, 'Bad JSON')); }       // set by Vercel's runtime; undefined with plain Node
  if (pre && typeof pre === 'object' && !Buffer.isBuffer(pre)) return Promise.resolve(pre);
  if (typeof pre === 'string' && pre) { try { return Promise.resolve(JSON.parse(pre)); } catch { return Promise.reject(err(400, 'Bad JSON')); } }
  return readStream(req);
};
const readStream = req => new Promise((ok, no) => { let b = '', n = 0;
  req.on('data', c => { n += c.length; if (n > 1.5e6) { no(err(413, 'Payload too large')); req.destroy(); } else b += c; });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(err(400, 'Bad JSON')); } }); });
const str = (v, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw err(400, 'Invalid input'); return v.trim(); };
const audit = (u, a, t) => run('INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)', u.id, a, String(t), now());

// N-day series of counts keyed by UTC date; `sql` must select d (YYYY-MM-DD) and c, with its first parameter being the start timestamp.
function daySeries(sql, days, ...p) {
  const day = 864e5, d0 = new Date(); d0.setUTCHours(0, 0, 0, 0); const t0 = d0.getTime() - (days - 1) * day;
  const m = Object.fromEntries(all(sql, t0, ...p).map(r => [r.d, r.c]));
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
  console.log(`[oauth] ${name} ${isCb ? 'callback' : 'start'} configured=${!!(P.id && P.secret)} site=${SITE}`);
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
    const email = prof.email.toLowerCase().trim(); let u = one('SELECT * FROM users WHERE email=?', email);
    const unusable = () => hashPw(crypto.randomBytes(32).toString('hex'));
    if (!u) {
      const id = run('INSERT INTO users(name,email,pass,role,provider,created) VALUES(?,?,?,?,?,?)', String(prof.name || email.split('@')[0]).slice(0, 100), email, unusable(), role === 'teacher' ? 'teacher' : 'student', name, now()).lastInsertRowid;
      u = one('SELECT * FROM users WHERE id=?', Number(id));
    } else {
      if (u.status !== 'active') return back('suspended');
      if (!u.provider) {   // first social login into a password account: retire the old password + sessions so nobody who pre-registered this email keeps access
        run('UPDATE users SET pass=?,provider=? WHERE id=?', unusable(), name, u.id); run('DELETE FROM sessions WHERE user_id=?', u.id);
      }
    }
    return go('/app', [login(res, u)['set-cookie']]);
  } catch (e) { console.error('oauth error:', e.message); return back('failed'); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
const PUB = fileURLToPath(new URL('./public/', import.meta.url));
const who = req => { try { return session(req); } catch { return null; } };
function serveStatic(p, req, res) {
  // signed in -> the login page sends you straight to the app; signed out -> the app sends you to the login page
  if ((p === '/' || p === '/index.html') && who(req)) { res.writeHead(302, { location: '/app' }); return res.end(); }
  if (p === '/app' && !who(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
  let full = p === '/app' ? fileURLToPath(new URL('./app.html', import.meta.url)) : path.join(PUB, p === '/' ? 'index.html' : p.slice(1));
  if (p !== '/app' && !full.startsWith(PUB)) full = '';
  let ok = false; try { ok = !!full && fs.statSync(full).isFile() && !!MIME[path.extname(full)]; } catch {}
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)], 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
  res.end(fs.readFileSync(full));
}

export async function handle(req, res) {
  try {
    const p = new URL(req.url, 'http://x').pathname, m = req.method; let mt;
    if (m === 'GET' && (mt = p.match(/^\/auth\/(google|github)(\/callback)?$/))) return oauth(req, res, mt[1], !!mt[2]);
    if (!p.startsWith('/api/')) return serveStatic(p, req, res);
    if (m !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw err(403, 'Bad origin');
    const b = m === 'GET' || m === 'DELETE' ? {} : await readBody(req);
    const R = (meth, re) => m === meth && (mt = p.match(re));

    if (R('POST', /^\/api\/register$/)) {
      const email = str(b.email, 200).toLowerCase(), pw = str(b.password, 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pw.length < 8) throw err(400, 'Valid email and a password of at least 8 characters are required');
      if (!['student', 'teacher'].includes(b.role)) throw err(400, 'Invalid role');
      if (one('SELECT 1 FROM users WHERE email=?', email)) throw err(409, 'Email already registered');
      const id = run('INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,?,?)', str(b.name, 100), email, hashPw(pw), b.role, now()).lastInsertRowid;
      return send(res, 201, { ok: true }, login(res, { id: Number(id) }));
    }
    if (R('POST', /^\/api\/login$/)) {
      const ip = req.socket.remoteAddress, t = tries.get(ip) || { n: 0, at: now() };
      if (now() - t.at > 9e5) { t.n = 0; t.at = now(); }
      if (t.n >= 10) throw err(429, 'Too many attempts. Try again later.');
      const u = one('SELECT * FROM users WHERE email=?', String(b.email || '').toLowerCase());
      if (!u || !checkPw(String(b.password || ''), u.pass)) { tries.set(ip, { ...t, n: t.n + 1 }); throw err(401, 'Invalid email or password'); }
      if (u.status !== 'active') throw err(403, 'Account suspended');
      return send(res, 200, { ok: true }, login(res, u));
    }
    if (R('POST', /^\/api\/logout$/)) {
      const k = /sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (k) run('DELETE FROM sessions WHERE hash=?', sha(k[1]));
      return send(res, 200, { ok: true }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
    }

    if (R('GET', /^\/api\/health$/)) return send(res, 200, { ok: true, node: process.version, vercel: !!process.env.VERCEL, site: SITE, db: DB_FILE,
      github: !!(OAUTH.github.id && OAUTH.github.secret), google: !!(OAUTH.google.id && OAUTH.google.secret), ai: !!KEY, mail: !!process.env.MAIL_WEBHOOK_URL, path: p });
    if (R('POST', /^\/api\/forgot$/)) {
      const k = 'f' + req.socket.remoteAddress, tr = tries.get(k) || { n: 0, at: now() };
      if (now() - tr.at > 9e5) { tr.n = 0; tr.at = now(); }
      if (tr.n >= 5) throw err(429, 'Too many attempts. Try again later.');
      tries.set(k, { ...tr, n: tr.n + 1 });
      const fu = one('SELECT * FROM users WHERE email=?', String(b.email || '').toLowerCase().trim());
      if (fu && fu.status === 'active') {
        const tok = crypto.randomBytes(32).toString('hex');
        run('DELETE FROM reset_tokens WHERE user_id=?', fu.id);
        run('INSERT INTO reset_tokens VALUES(?,?,?)', sha(tok), fu.id, now() + 36e5);
        await sendMail(fu.email, 'Reset your Cogniva password', `Open this link within 1 hour to choose a new password:\n${SITE}/reset.html?token=${tok}\n\nIf you did not ask for this, ignore this email.`);
      }
      return send(res, 200, { ok: true });   // same answer whether or not the email exists
    }
    if (R('POST', /^\/api\/reset$/)) {
      const pw = str(b.password, 200); if (pw.length < 8) throw err(400, 'Password must be at least 8 characters');
      const rt = one('SELECT * FROM reset_tokens WHERE hash=? AND expires>?', sha(String(b.token || '')), now());
      if (!rt) throw err(400, 'Invalid or expired link');
      db.exec('BEGIN');
      try {
        run('UPDATE users SET pass=? WHERE id=?', hashPw(pw), rt.user_id);
        run('DELETE FROM reset_tokens WHERE user_id=?', rt.user_id);
        run('DELETE FROM sessions WHERE user_id=?', rt.user_id);   // sign out everywhere
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true });
    }

    const u = session(req);
    const admin = () => { if (u.role !== 'admin') throw err(403, 'Forbidden'); };
    if (R('GET', /^\/api\/me$/)) return send(res, 200, { user: publicUser(u) });
    if (R('PATCH', /^\/api\/me$/)) {
      if (['en', 'ar'].includes(b.lang)) run('UPDATE users SET lang=? WHERE id=?', b.lang, u.id);
      if (['dark', 'light'].includes(b.theme)) run('UPDATE users SET theme=? WHERE id=?', b.theme, u.id);
      return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/docs$/)) return send(res, 200, { docs: all('SELECT id,name,length(text) size,ts FROM docs WHERE user_id=? ORDER BY id DESC', u.id) });
    if (R('POST', /^\/api\/docs$/)) {
      const id = run('INSERT INTO docs(user_id,name,text,ts) VALUES(?,?,?,?)', u.id, str(b.name, 200), str(b.text, 500000), now()).lastInsertRowid;
      return send(res, 201, { id: Number(id) });
    }
    if (R('DELETE', /^\/api\/docs\/(\d+)$/)) { run('DELETE FROM docs WHERE id=? AND user_id=?', mt[1], u.id); return send(res, 200, { ok: true }); }
    const docText = id => id ? one('SELECT text FROM docs WHERE id=? AND user_id=?', id, u.id)?.text : null;

    if (R('GET', /^\/api\/messages$/)) return send(res, 200, { messages: all('SELECT role,content FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id).reverse() });
    if (R('POST', /^\/api\/chat$/)) {
      const msg = str(b.message, 4000), doc = docText(b.docId);
      if (b.docId && !doc) throw err(404, 'Document not found');
      const sys = 'You are Cogniva, an academic study assistant. Be accurate and clear.' + (doc ? ' The student attached a document. Use it when relevant and say explicitly whether an answer comes from the document or from general knowledge. Never invent quotes or page citations.\n\nDOCUMENT:\n' + doc.slice(0, 12000) : '');
      const hist = all('SELECT role,content FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id).reverse();
      const reply = await metered(u, 'chat', () => ai([{ role: 'system', content: sys }, ...hist, { role: 'user', content: msg }]));
      run('INSERT INTO messages(user_id,role,content,ts) VALUES(?,?,?,?),(?,?,?,?)', u.id, 'user', msg, now(), u.id, 'assistant', reply, now());
      return send(res, 200, { reply });
    }
    if (R('GET', /^\/api\/exams$/)) return send(res, 200, { exams: all('SELECT e.id,e.title,e.ts,(SELECT MAX(100.0*score/total) FROM attempts a WHERE a.exam_id=e.id) best FROM exams e WHERE user_id=? ORDER BY id DESC', u.id) });
    if (R('POST', /^\/api\/exams$/)) {
      const src = docText(b.docId) || (b.text ? str(b.text, 20000) : null); if (!src) throw err(400, 'Choose a document or enter text/topic');
      const n = Math.min(10, Math.max(3, Number(b.n) || 5));
      const out = await metered(u, 'exam', () => ai([{ role: 'system', content: 'Return ONLY JSON: {"questions":[{"q":string,"options":[4 strings],"answer":0-3,"explanation":string}]}. Write in the same language as the source.' },
        { role: 'user', content: `Create ${n} multiple-choice questions from:\n${src.slice(0, 12000)}` }], true));
      let qs; try { qs = parseJson(out).questions; } catch { throw err(502, 'AI returned invalid exam data'); }
      qs = (qs || []).filter(x => x.q && Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4);
      if (!qs.length) throw err(502, 'AI returned no valid questions');
      const id = run('INSERT INTO exams(user_id,title,qs,ts) VALUES(?,?,?,?)', u.id, str(b.title || 'Exam', 100), JSON.stringify(qs), now()).lastInsertRowid;
      return send(res, 201, { id: Number(id) });
    }
    if (R('GET', /^\/api\/exams\/(\d+)$/)) {
      const e = one('SELECT * FROM exams WHERE id=? AND user_id=?', mt[1], u.id); if (!e) throw err(404, 'Not found');
      return send(res, 200, { title: e.title, questions: JSON.parse(e.qs).map(({ q, options }) => ({ q, options })) });
    }
    if (R('POST', /^\/api\/exams\/(\d+)\/submit$/)) {
      const e = one('SELECT * FROM exams WHERE id=? AND user_id=?', mt[1], u.id); if (!e) throw err(404, 'Not found');
      const qs = JSON.parse(e.qs), a = Array.isArray(b.answers) ? b.answers : [];
      const review = qs.map((q, i) => ({ correct: a[i] === q.answer, answer: q.answer, picked: a[i] ?? null, explanation: q.explanation || '' }));
      const score = review.filter(r => r.correct).length;
      run('INSERT INTO attempts(exam_id,user_id,score,total,ts) VALUES(?,?,?,?,?)', e.id, u.id, score, qs.length, now());
      return send(res, 200, { score, total: qs.length, review });
    }
    if (R('GET', /^\/api\/payments$/)) return send(res, 200, { payments: all('SELECT id,ref,status,ts FROM payments WHERE user_id=? ORDER BY id DESC', u.id) });
    if (R('POST', /^\/api\/payments$/)) {
      if (one("SELECT 1 FROM payments WHERE user_id=? AND status='pending'", u.id)) throw err(409, 'You already have a pending request');
      run('INSERT INTO payments(user_id,ref,ts) VALUES(?,?,?)', u.id, str(b.ref, 100), now());
      return send(res, 201, { ok: true });
    }

    if (R('GET', /^\/api\/insights$/)) return send(res, 200, {
      usage: daySeries("SELECT strftime('%Y-%m-%d',ts/1000,'unixepoch') d,COUNT(*) c FROM usage WHERE ts>=? AND user_id=? GROUP BY d", 7, u.id),
      scores: all('SELECT ROUND(100.0*score/total) p FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id).reverse().map(r => r.p) });
    // ---- flashcards (SM-2 spaced repetition) ----
    if (R('GET', /^\/api\/cards$/)) return send(res, 200, {
      due: all('SELECT id,front,back FROM cards WHERE user_id=? AND due<=? ORDER BY due LIMIT 50', u.id, now()),
      cards: all('SELECT id,front,back FROM cards WHERE user_id=? ORDER BY id DESC LIMIT 100', u.id),
      mastered: one('SELECT COUNT(*) c FROM cards WHERE user_id=? AND ivl>=21', u.id).c });
    if (R('POST', /^\/api\/cards$/)) {
      run('INSERT INTO cards(user_id,front,back,due,created) VALUES(?,?,?,?,?)', u.id, str(b.front, 500), str(b.back, 1000), now(), now());
      return send(res, 201, { ok: true });
    }
    if (R('POST', /^\/api\/cards\/generate$/)) {
      const src = docText(b.docId) || (b.text ? str(b.text, 20000) : null); if (!src) throw err(400, 'Choose a document or enter text/topic');
      const n = Math.min(15, Math.max(3, Number(b.n) || 8));
      const out = await metered(u, 'cards', () => ai([{ role: 'system', content: 'Return ONLY JSON: {"cards":[{"front":string,"back":string}]}. Concise, one fact per card, same language as the source.' },
        { role: 'user', content: `Create ${n} flashcards from:\n${src.slice(0, 12000)}` }], true));
      let cs; try { cs = parseJson(out).cards; } catch { throw err(502, 'AI returned invalid card data'); }
      cs = (cs || []).filter(c => typeof c.front === 'string' && typeof c.back === 'string' && c.front && c.back).slice(0, n);
      if (!cs.length) throw err(502, 'AI returned no valid cards');
      db.exec('BEGIN');
      try { for (const c of cs) run('INSERT INTO cards(user_id,front,back,due,created) VALUES(?,?,?,?,?)', u.id, c.front.slice(0, 500), c.back.slice(0, 1000), now(), now()); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 201, { added: cs.length });
    }
    if (R('POST', /^\/api\/cards\/(\d+)\/review$/)) {
      const c = one('SELECT * FROM cards WHERE id=? AND user_id=?', mt[1], u.id); if (!c) throw err(404, 'Not found');
      const q = Number(b.q); if (![1, 3, 4, 5].includes(q)) throw err(400, 'Invalid rating');
      let { reps, ivl, ef } = c;
      if (q < 3) { reps = 0; ivl = 1; } else { reps++; ivl = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(ivl * ef); }
      ef = Math.max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
      run('UPDATE cards SET reps=?,ivl=?,ef=?,due=? WHERE id=?', reps, ivl, ef, now() + ivl * 864e5, c.id);
      return send(res, 200, { next_in_days: ivl });
    }
    if (R('DELETE', /^\/api\/cards\/(\d+)$/)) { run('DELETE FROM cards WHERE id=? AND user_id=?', mt[1], u.id); return send(res, 200, { ok: true }); }
    // ---- study planner ----
    if (R('GET', /^\/api\/tasks$/)) return send(res, 200, { tasks: all('SELECT id,title,due,done FROM tasks WHERE user_id=? ORDER BY done,(due IS NULL),due LIMIT 200', u.id) });
    if (R('POST', /^\/api\/tasks$/)) {
      const due = b.due == null ? null : Number(b.due); if (due !== null && !Number.isFinite(due)) throw err(400, 'Invalid date');
      run('INSERT INTO tasks(user_id,title,due,ts) VALUES(?,?,?,?)', u.id, str(b.title, 200), due, now());
      return send(res, 201, { ok: true });
    }
    if (R('PATCH', /^\/api\/tasks\/(\d+)$/)) { run('UPDATE tasks SET done=? WHERE id=? AND user_id=?', b.done ? 1 : 0, mt[1], u.id); return send(res, 200, { ok: true }); }
    if (R('DELETE', /^\/api\/tasks\/(\d+)$/)) { run('DELETE FROM tasks WHERE id=? AND user_id=?', mt[1], u.id); return send(res, 200, { ok: true }); }

    // ---- teacher: courses, assignments, grading (access checked per course) ----
    const course = id => {
      const c = one('SELECT * FROM courses WHERE id=?', id); if (!c) throw err(404, 'Not found');
      const teacher = c.teacher_id === u.id, student = !!one('SELECT 1 FROM enrollments WHERE course_id=? AND user_id=?', id, u.id);
      if (!teacher && !student && u.role !== 'admin') throw err(404, 'Not found');
      return { c, teacher, student };
    };
    const ownCourse = id => { const r = course(id); if (!r.teacher) throw err(403, 'Forbidden'); return r.c; };
    if (R('GET', /^\/api\/courses$/)) return send(res, 200, { courses: u.role === 'teacher'
      ? all('SELECT c.id,c.title,c.code,(SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) students FROM courses c WHERE teacher_id=? ORDER BY id DESC', u.id)
      : all('SELECT c.id,c.title FROM courses c JOIN enrollments e ON e.course_id=c.id WHERE e.user_id=? ORDER BY c.id DESC', u.id) });
    if (R('POST', /^\/api\/courses$/)) {
      if (u.role !== 'teacher') throw err(403, 'Only teachers can create courses');
      const title = str(b.title, 150); let code;
      do code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); while (one('SELECT 1 FROM courses WHERE code=?', code));
      return send(res, 201, { id: Number(run('INSERT INTO courses(teacher_id,title,code,ts) VALUES(?,?,?,?)', u.id, title, code, now()).lastInsertRowid), code });
    }
    if (R('POST', /^\/api\/courses\/join$/)) {
      if (u.role !== 'student') throw err(403, 'Only students can join courses');
      const c = one('SELECT id FROM courses WHERE code=?', str(b.code, 20).toUpperCase()); if (!c) throw err(404, 'Invalid course code');
      run('INSERT OR IGNORE INTO enrollments VALUES(?,?)', c.id, u.id); return send(res, 200, { id: c.id });
    }
    if (R('GET', /^\/api\/courses\/(\d+)$/)) {
      const { c, teacher } = course(mt[1]);
      return send(res, 200, { teacher, course: { id: c.id, title: c.title, code: teacher ? c.code : undefined },
        assignments: teacher
          ? all('SELECT a.id,a.title,a.description,a.due,(SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) subs,(SELECT ROUND(AVG(grade)) FROM submissions s WHERE s.assignment_id=a.id) avg FROM assignments a WHERE a.course_id=? ORDER BY a.id DESC', c.id)
          : all('SELECT a.id,a.title,a.description,a.due,s.text,s.grade,s.feedback FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id AND s.user_id=? WHERE a.course_id=? ORDER BY a.id DESC', u.id, c.id),
        students: teacher ? all('SELECT u.name,u.email FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=?', c.id) : undefined });
    }
    if (R('POST', /^\/api\/courses\/(\d+)\/assignments$/)) {
      const c = ownCourse(mt[1]), due = b.due == null ? null : Number(b.due); if (due !== null && !Number.isFinite(due)) throw err(400, 'Invalid date');
      run('INSERT INTO assignments(course_id,title,description,due,ts) VALUES(?,?,?,?,?)', c.id, str(b.title, 200), b.description ? str(b.description, 5000) : '', due, now());
      return send(res, 201, { ok: true });
    }
    if (R('POST', /^\/api\/assignments\/(\d+)\/submit$/)) {
      const a = one('SELECT * FROM assignments WHERE id=?', mt[1]); if (!a) throw err(404, 'Not found');
      if (!course(a.course_id).student) throw err(403, 'Forbidden');
      if (one('SELECT 1 FROM submissions WHERE assignment_id=? AND user_id=? AND grade IS NOT NULL', a.id, u.id)) throw err(409, 'Already graded');
      run('INSERT INTO submissions(assignment_id,user_id,text,ts) VALUES(?,?,?,?) ON CONFLICT(assignment_id,user_id) DO UPDATE SET text=excluded.text,ts=excluded.ts', a.id, u.id, str(b.text, 20000), now());
      return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/assignments\/(\d+)\/submissions$/)) {
      const a = one('SELECT * FROM assignments WHERE id=?', mt[1]); if (!a) throw err(404, 'Not found'); ownCourse(a.course_id);
      return send(res, 200, { submissions: all('SELECT s.id,s.text,s.grade,s.feedback,s.ts,u.name FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.assignment_id=? ORDER BY s.ts', a.id) });
    }
    if (R('POST', /^\/api\/submissions\/(\d+)\/grade$/)) {
      const s = one('SELECT s.id,a.course_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?', mt[1]); if (!s) throw err(404, 'Not found'); ownCourse(s.course_id);
      const g = Number(b.grade); if (!Number.isInteger(g) || g < 0 || g > 100) throw err(400, 'Grade must be an integer from 0 to 100');
      run('UPDATE submissions SET grade=?,feedback=? WHERE id=?', g, String(b.feedback || '').slice(0, 2000), s.id); return send(res, 200, { ok: true });
    }

    // ---- admin (server-side role check on every route) ----
    if (R('GET', /^\/api\/admin\/stats$/)) { admin(); return send(res, 200, {
      users: one('SELECT COUNT(*) c FROM users').c, teachers: one("SELECT COUNT(*) c FROM users WHERE role='teacher'").c,
      premium: one("SELECT COUNT(*) c FROM users WHERE plan='premium' AND plan_expires>?", now()).c,
      ai7d: one('SELECT COUNT(*) c FROM usage WHERE ts>?', now() - WEEK).c, docs: one('SELECT COUNT(*) c FROM docs').c,
      settings: Object.fromEntries(Object.keys(DEF).map(k => [k, setting(k)])), audit: all('SELECT * FROM audit ORDER BY id DESC LIMIT 15') }); }
    if (R('GET', /^\/api\/admin\/users$/)) { admin(); return send(res, 200, { users: all('SELECT id,name,email,role,status,plan,plan_expires,quota,created,(SELECT COUNT(*) FROM usage x WHERE x.user_id=users.id AND x.ts>?) used FROM users ORDER BY id DESC LIMIT 500', now() - WEEK) }); }
    if (R('GET', /^\/api\/admin\/analytics$/)) {
      admin(); const cnt = q => one(q).c;
      return send(res, 200, {
        signups: daySeries("SELECT strftime('%Y-%m-%d',created/1000,'unixepoch') d,COUNT(*) c FROM users WHERE created>=? GROUP BY d", 14),
        ai: daySeries("SELECT strftime('%Y-%m-%d',ts/1000,'unixepoch') d,COUNT(*) c FROM usage WHERE ts>=? GROUP BY d", 14),
        byKind: all('SELECT kind,COUNT(*) c FROM usage WHERE ts>? GROUP BY kind', now() - 30 * 864e5),
        byRole: all('SELECT role,COUNT(*) c FROM users GROUP BY role'),
        top: all('SELECT u.email,COUNT(*) c FROM usage x JOIN users u ON u.id=x.user_id WHERE x.ts>? GROUP BY u.id ORDER BY c DESC LIMIT 5', now() - WEEK),
        totals: { exams: cnt('SELECT COUNT(*) c FROM attempts'), avg: Math.round(one('SELECT AVG(100.0*score/total) a FROM attempts').a ?? 0), cards: cnt('SELECT COUNT(*) c FROM cards'),
          courses: cnt('SELECT COUNT(*) c FROM courses'), submissions: cnt('SELECT COUNT(*) c FROM submissions'),
          active7: one('SELECT COUNT(DISTINCT user_id) c FROM usage WHERE ts>?', now() - WEEK).c, pending: cnt("SELECT COUNT(*) c FROM payments WHERE status='pending'"),
          revenue: cnt("SELECT COUNT(*) c FROM payments WHERE status='approved'") * Number(setting('premium_price')) } });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/quota$/)) {
      admin(); let q = b.limit; if (q !== null) { q = Number(q); if (!Number.isInteger(q) || q < 0 || q > 100000) throw err(400, 'Invalid quota'); }
      if (!one('SELECT 1 FROM users WHERE id=?', mt[1])) throw err(404, 'Not found');
      run('UPDATE users SET quota=? WHERE id=?', q, mt[1]); audit(u, 'quota.set', mt[1] + ':' + (q ?? 'default')); return send(res, 200, { ok: true });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/plan$/)) {
      admin(); if (!['premium', 'free'].includes(b.plan)) throw err(400, 'Invalid plan');
      const tu = one('SELECT plan_expires e FROM users WHERE id=?', mt[1]); if (!tu) throw err(404, 'Not found');
      const days = Math.min(3650, Math.max(1, Number(b.days) || Number(setting('premium_days'))));
      run('UPDATE users SET plan=?,plan_expires=? WHERE id=?', b.plan, b.plan === 'premium' ? Math.max(now(), tu.e || 0) + days * 864e5 : 0, mt[1]);
      audit(u, 'plan.' + b.plan, mt[1]); return send(res, 200, { ok: true });
    }
    if (R('POST', /^\/api\/admin\/users\/(\d+)\/status$/)) {
      admin(); if (!['active', 'suspended'].includes(b.status) || Number(mt[1]) === u.id) throw err(400, 'Invalid request');
      run('UPDATE users SET status=? WHERE id=?', b.status, mt[1]);
      if (b.status === 'suspended') run('DELETE FROM sessions WHERE user_id=?', mt[1]);
      audit(u, 'user.' + b.status, mt[1]); return send(res, 200, { ok: true });
    }
    if (R('GET', /^\/api\/admin\/payments$/)) { admin(); return send(res, 200, { payments: all('SELECT p.id,p.ref,p.status,p.ts,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY (p.status=\'pending\') DESC,p.id DESC LIMIT 100') }); }
    if (R('POST', /^\/api\/admin\/payments\/(\d+)\/(approve|reject)$/)) {
      admin(); const pay = one("SELECT * FROM payments WHERE id=? AND status='pending'", mt[1]); if (!pay) throw err(404, 'No pending payment');
      db.exec('BEGIN');
      try {
        run('UPDATE payments SET status=? WHERE id=?', mt[2] === 'approve' ? 'approved' : 'rejected', pay.id);
        if (mt[2] === 'approve') run("UPDATE users SET plan='premium',plan_expires=MAX(plan_expires,?)+? WHERE id=?", now(), Number(setting('premium_days')) * 864e5, pay.user_id);
        audit(u, 'payment.' + mt[2], pay.id); db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true });
    }
    if (R('PUT', /^\/api\/admin\/settings$/)) {
      admin();
      for (const k of Object.keys(DEF)) if (b[k] !== undefined) {
        if (k !== 'instapay_handle' && !(Number(b[k]) >= 0)) throw err(400, 'Invalid ' + k);
        run('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(b[k]).slice(0, 200));
      }
      audit(u, 'settings.update', '-'); return send(res, 200, { ok: true });
    }
    throw err(404, 'Not found');
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(e);
    send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Server error' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) http.createServer(handle).listen(PORT, () => console.log('Cogniva on http://localhost:' + PORT));
