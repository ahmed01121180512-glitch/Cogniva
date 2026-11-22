// Database layer: one async API (all / one / run / ins / tx) over two engines.
//   DATABASE_URL set  -> PostgreSQL (Supabase, Neon, any Postgres). Needs the `pg` package.
//   otherwise         -> SQLite file (DB_PATH, default cogniva.db) through node:sqlite, as before.
// Every query is written once with `?` placeholders and portable SQL; Postgres gets $1,$2,... automatically.
import { pathToFileURL } from 'node:url';

try { process.loadEnvFile(); } catch {}   // .env must be read before the engine is chosen
const E = process.env;
const SCHEMA_VERSION = '3';

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS rate_limits(k TEXT PRIMARY KEY,n INTEGER,t0 INTEGER);
`;
// Columns added after the first release. Existing databases get them here; they are not in CREATE TABLE above.
const COLUMNS = [
  ['users', 'provider', 'TEXT'],     // 'google' | 'github' once the account is linked to social sign-in
  ['docs', 'kind', 'TEXT'],          // what the file was: pdf, docx, image, audio, ...
  ['payments', 'amount', 'REAL'],    // price when the request was made (changing the price later does not rewrite history)
  ['payments', 'days', 'INTEGER'],   // days of Premium this payment buys
  ['payments', 'note', 'TEXT'],      // reason shown to the student when a request is rejected
  ['users', 'quota', 'INTEGER'],     // per-user weekly quota override (NULL = plan default)
];
// Postgres: ids and millisecond timestamps need 64 bits (INTEGER there is only 32).
const toPg = s => s.replace(/INTEGER PRIMARY KEY/g, 'BIGSERIAL PRIMARY KEY').replace(/\bINTEGER\b/g, 'BIGINT').replace(/\bREAL\b/g, 'DOUBLE PRECISION');
const toDollar = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

async function sqliteDriver() {
  const { DatabaseSync } = await import('node:sqlite');
  const sq = new DatabaseSync(E.DB_PATH || 'cogniva.db');
  sq.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const query = (sql, p = []) => {
    const st = sq.prepare(sql);
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) { const rows = st.all(...p); return { rows, count: rows.length }; }
    return { rows: [], count: Number(st.run(...p).changes) };
  };
  // The sync engine cannot interleave work between awaits that only touch the database, but a lock keeps two transactions from nesting anyway.
  let chain = Promise.resolve();
  const tx = fn => {
    const r = chain.then(async () => {
      sq.exec('BEGIN');
      try { const v = await fn({ query: async (s, p) => query(s, p) }); sq.exec('COMMIT'); return v; }
      catch (e) { try { sq.exec('ROLLBACK'); } catch {} throw e; }
    });
    chain = r.catch(() => {}); return r;
  };
  return { dialect: 'sqlite', query: async (s, p) => query(s, p), tx, exec: async s => sq.exec(s) };
}

async function pgDriver() {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, Number);     // BIGINT (counts, ids, ms timestamps) -> number, not string
  pg.types.setTypeParser(1700, Number);   // NUMERIC (AVG, ROUND, SUM) -> number
  let url = E.DATABASE_URL, local = false;
  try { const u = new URL(url); local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname); u.searchParams.delete('sslmode'); url = u.toString(); } catch {}
  // Hosted Postgres (Supabase) requires TLS; its pooler certificate does not chain to a public CA, so verification is relaxed there.
  const pool = new pg.Pool({ connectionString: url, max: Number(E.DB_POOL) || (E.VERCEL ? 1 : 5), idleTimeoutMillis: 10000,
    ssl: local || E.DB_SSL === 'off' ? false : { rejectUnauthorized: false } });
  pool.on('error', e => console.error('pg pool error:', e.message));
  const q = c => async (sql, p = []) => { const r = await c.query(toDollar(sql), p); return { rows: r.rows, count: r.rowCount }; };
  const tx = async fn => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const v = await fn({ query: q(c) }); await c.query('COMMIT'); return v; }
    catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
    finally { c.release(); }
  };
  return { dialect: 'pg', query: q(pool), tx, exec: async s => { await pool.query(s); } };
}

const api = x => ({
  all: async (s, ...p) => (await x.query(s, p)).rows,
  one: async (s, ...p) => (await x.query(s, p)).rows[0],
  run: async (s, ...p) => (await x.query(s, p)).count,                                   // rows changed
  ins: async (s, ...p) => Number((await x.query(s + ' RETURNING id', p)).rows[0].id),     // id of the inserted row
});

if (E.VERCEL && !E.DATABASE_URL && !E.COGNIVA_DB_DRIVER) throw new Error('DATABASE_URL is not set. Vercel has no persistent disk: add your Supabase connection string as DATABASE_URL in the project settings.');
const driver = await (E.COGNIVA_DB_DRIVER ? import(pathToFileURL(E.COGNIVA_DB_DRIVER).href).then(m => m.default()) : E.DATABASE_URL ? pgDriver() : sqliteDriver());
export const dialect = driver.dialect;
export const { all, one, run, ins } = api(driver);
export const tx = fn => driver.tx(x => fn(api(x)));
// SQL that differs per engine
export const dayOf = col => dialect === 'pg' ? `to_char(to_timestamp(${col}/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD')` : `strftime('%Y-%m-%d',${col}/1000,'unixepoch')`;

// Create/upgrade tables once per schema version (cheap check on every cold start; a lock stops two cold starts racing).
export async function init() {
  let cur; try { cur = (await one('SELECT v FROM settings WHERE k=?', 'schema_version'))?.v; } catch {}
  if (cur === SCHEMA_VERSION) return;
  const stmts = (dialect === 'pg' ? toPg(SCHEMA) : SCHEMA).split(';').map(s => s.trim()).filter(Boolean);
  await tx(async t => {
    if (dialect === 'pg') await t.run('SELECT pg_advisory_xact_lock(7331)');
    for (const s of stmts) await t.run(s);
    for (const [tb, col, ty] of COLUMNS) {
      if (dialect === 'pg') await t.run(`ALTER TABLE ${tb} ADD COLUMN IF NOT EXISTS ${col} ${toPg(ty)}`);
      else { try { await t.run(`ALTER TABLE ${tb} ADD COLUMN ${col} ${ty}`); } catch {} }
    }
    await t.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'schema_version', SCHEMA_VERSION);
  });
}
