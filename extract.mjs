// File -> plain text for Cogniva. No npm packages: Office/PDF internals are read with node:zlib, and anything that needs "understanding"
// (images, speech, scanned PDFs) goes to the configured AI provider. Optional system tools make things better when installed:
//   ffmpeg (any audio/video, long recordings, odd image formats) · pdftotext (best PDF text) · soffice (old .doc/.xls/.ppt)
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile), E = process.env;   // env is read lazily: server.mjs loads .env after its imports are evaluated
const fail = (code, msg) => Object.assign(new Error(msg), { code });
export const MAX_TEXT = 500000;
export const maxUpload = () => (Number(E.MAX_UPLOAD_MB) || (E.VERCEL ? 4 : 50)) * 1048576;
const maxMediaMin = () => Number(E.MAX_MEDIA_MIN) || 120;

// ---------- optional system tools ----------
const VERSION_FLAG = { ffmpeg: '-version', pdftotext: '-v', soffice: '--version' }, seen = {};
const has = cmd => E.EXTRACT_NO_TOOLS ? Promise.resolve(false) : (seen[cmd] ??= run(cmd, [VERSION_FLAG[cmd]], { timeout: 15000 }).then(() => true, () => false));
async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogniva-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- AI provider calls ----------
const providerErr = (r, what) => fail(502, r.status === 401 ? `${what}: key rejected (401). Check the API key.` : r.status === 404 ? `${what}: model or endpoint not found (404). Check the model / base URL settings.`
  : r.status === 429 ? `${what}: the provider says the key is out of quota or rate-limited (429).` : `${what}: provider error ${r.status}`);
async function chat({ base, key, model, content, ms = 120000, what }) {
  if (!key) throw fail(503, `${what} needs an AI key: set AI_API_KEY on the server.`);
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(ms) });
  if (!r.ok) { console.error('AI provider error', what, r.status, (await r.text().catch(() => '')).slice(0, 300)); throw providerErr(r, what); }
  const txt = (await r.json()).choices?.[0]?.message?.content;
  if (!txt) throw fail(502, `${what}: the AI returned an empty answer.`);
  return typeof txt === 'string' ? txt : String(txt?.map?.(x => x.text || '').join('') || '');
}
const aiBase = () => (E.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
const llm = (content, what, ms) => chat({ base: aiBase(), key: E.AI_API_KEY, model: E.VISION_MODEL || E.AI_MODEL || 'gpt-4o-mini', content, ms, what });

const sttBase = () => (E.STT_BASE_URL || E.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
const sttKey = () => E.STT_API_KEY || E.AI_API_KEY;
// 'whisper' = OpenAI-style /audio/transcriptions (OpenAI, Groq, ...) · 'chat' = audio sent inside a chat message (Gemini's OpenAI-compatible endpoint)
const sttMode = () => E.STT_MODE || (/generativelanguage\.googleapis\.com/.test(sttBase()) ? 'chat' : 'whisper');
const WHISPER_EXT = ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'oga', 'flac'];
async function transcribe(buf, ext) {
  const key = sttKey(); if (!key) throw fail(503, 'Transcription needs an AI key: set AI_API_KEY (or STT_API_KEY) on the server.');
  if (sttMode() === 'chat')
    return chat({ base: sttBase(), key, model: E.STT_MODEL || E.AI_MODEL || 'gemini-2.0-flash', ms: 300000, what: 'Transcription',
      content: [{ type: 'text', text: 'Transcribe this audio verbatim, in the language spoken. Output only the transcript, no commentary. If there is no speech, output nothing.' },
        { type: 'input_audio', input_audio: { data: buf.toString('base64'), format: ext === 'wav' ? 'wav' : 'mp3' } }] });
  const fd = new FormData(); fd.append('file', new Blob([buf]), 'audio.' + ext); fd.append('model', E.STT_MODEL || 'whisper-1'); fd.append('response_format', 'json');
  const r = await fetch(sttBase() + '/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(300000) });
  if (!r.ok) { console.error('STT provider error', r.status, (await r.text().catch(() => '')).slice(0, 300)); throw providerErr(r, 'Transcription'); }
  const raw = await r.text(); try { return JSON.parse(raw).text ?? ''; } catch { return raw; }
}

// ---------- capabilities (the browser asks, to decide whether it must convert video to audio itself) ----------
export async function caps() {
  const ff = await has('ffmpeg'), chatMode = sttMode() === 'chat';
  return { maxMB: maxUpload() / 1048576, ffmpeg: ff, direct: ff ? null : chatMode ? ['mp3', 'wav'] : WHISPER_EXT, directMB: chatMode ? 15 : 24,
    ai: !!E.AI_API_KEY, stt: !!sttKey(), pdftotext: await has('pdftotext'), soffice: await has('soffice') };
}

// ---------- small helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const cp = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
const dec = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? cp(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const tidy = s => dec(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const strip = s => s.replace(/<[^>]+>/g, '');
const html2text = s => tidy(strip(s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|section|article|blockquote)>/gi, '\n')));
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const looksText = buf => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return false; return true; };
function decodeText(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const s = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
  if (!s.includes('�')) return s;
  const ar = new TextDecoder('windows-1256').decode(buf), letters = ar.match(/\p{L}/gu) || [];   // legacy Arabic files are usually cp1256, other legacy text cp1252
  return letters.length && (ar.match(/[؀-ۿ]/g) || []).length / letters.length > .3 ? ar : new TextDecoder('windows-1252').decode(buf);
}

// ---------- ZIP (docx / pptx / xlsx / odf / epub are all zip files) ----------
function unzip(buf) {
  let e = buf.length - 22; const min = Math.max(0, buf.length - 65557);
  while (e >= min && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < min) throw fail(422, 'This file is damaged or is not a valid archive.');
  const files = new Map(); let p = buf.readUInt32LE(e + 16);
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    files.set(buf.toString('utf8', p + 46, p + 46 + nl), () => {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(start, start + cs);
      return method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 100e6 });   // cap = zip-bomb guard
    });
    p += 46 + nl + el + cl;
  }
  return files;
}
const part = (z, name) => z.get(name)?.().toString('utf8') ?? '';
const numbered = (z, re) => [...z.keys()].map(k => [k, re.exec(k)?.[1]]).filter(x => x[1]).sort((a, b) => a[1] - b[1]).map(x => x[0]);

const docx = z => {
  if (!z.has('word/document.xml')) throw fail(422, 'Not a valid Word file.');
  const w = x => tidy(strip(x.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')));
  return [part(z, 'word/document.xml'), part(z, 'word/footnotes.xml'), part(z, 'word/endnotes.xml')].map(w).filter(Boolean).join('\n\n');
};
const pptx = z => {
  const a = x => tidy(strip(x.replace(/<a:br\s*\/>/g, '\n').replace(/<\/a:p>/g, '\n'))).replace(/^‹#›$|^<number>$/gm, '').trim(), out = [];
  for (const f of numbered(z, /^ppt\/slides\/slide(\d+)\.xml$/)) {
    const n = f.match(/(\d+)\.xml$/)[1], notes = a(part(z, `ppt/notesSlides/notesSlide${n}.xml`)).replace(/^\d+$/m, '').trim();
    out.push(`--- Slide ${n} ---\n${a(part(z, f))}` + (notes ? `\n[Notes] ${notes}` : ''));
  }
  return out.join('\n\n');
};
const colIdx = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const xlsx = z => {
  const ss = [...part(z, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec((m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || []).map(strip).join('')));
  const rels = Object.fromEntries([...part(z, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(m => { const a = attrs(m[0]); return [a.Id, a.Target]; }));
  let sheets = [...part(z, 'xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map(m => { const a = attrs(m[0]), t = rels[a['r:id']]; return t && { name: dec(a.name), file: t[0] === '/' ? t.slice(1) : 'xl/' + t }; }).filter(Boolean);
  if (!sheets.length) sheets = numbered(z, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((file, i) => ({ name: 'Sheet' + (i + 1), file }));
  return sheets.map(({ name, file }) => {
    const rows = [...part(z, file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(r => {
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = attrs(c[1]), body = c[2] || '', v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        cells[a.r ? colIdx(a.r) : cells.length] = a.t === 's' ? ss[+v] ?? '' : a.t === 'inlineStr' ? dec(strip(body)) : a.t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v == null ? '' : dec(v);
      }
      return Array.from(cells, x => x ?? '').join('\t').replace(/\t+$/, '');
    }).filter(Boolean);
    return rows.length ? `--- Sheet: ${name} ---\n${rows.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
};
const odf = z => tidy(strip(part(z, 'content.xml').replace(/<text:tab\s*\/>/g, '\t').replace(/<text:line-break\s*\/>/g, '\n').replace(/<text:s\b[^>]*?(?:text:c="(\d+)")?[^>]*\/>/g, (m, c) => ' '.repeat(+c || 1))
  .replace(/<\/draw:page>/g, '\n\n').replace(/<\/(text:p|text:h|table:table-row)>/g, '\n').replace(/<\/table:table-cell>/g, '\t')));
const epub = z => {
  const opfPath = attrs(part(z, 'META-INF/container.xml').match(/<rootfile\b[^>]*>/)?.[0] || '')['full-path'], opf = opfPath ? part(z, opfPath) : '', dir = opfPath?.includes('/') ? opfPath.replace(/[^/]*$/, '') : '';
  const href = Object.fromEntries([...opf.matchAll(/<item\b[^>]*>/g)].map(m => { const a = attrs(m[0]); return [a.id, a.href]; }));
  let files = [...opf.matchAll(/<itemref\b[^>]*>/g)].map(m => href[attrs(m[0]).idref]).filter(Boolean).map(h => dir + decodeURIComponent(h)).filter(f => z.has(f));
  if (!files.length) files = [...z.keys()].filter(k => /\.x?html?$/i.test(k)).sort();
  return files.map(f => html2text(part(z, f))).filter(Boolean).join('\n\n');
};
function zipKind(z) {
  if (z.has('word/document.xml')) return 'docx'; if (z.has('ppt/presentation.xml')) return 'pptx'; if (z.has('xl/workbook.xml')) return 'xlsx';
  if (z.has('content.xml') && z.has('mimetype')) return 'odf'; if (z.has('META-INF/container.xml')) return 'epub'; return null;
}

// ---------- RTF ----------
function rtf(s) {
  let out = '', d = 0, skip = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') { d++; if (skip < 0 && /^\{\\(\*|fonttbl|colortbl|stylesheet|info|pict|header|footer)/.test(s.slice(i, i + 14))) skip = d; }
    else if (c === '}') { if (skip === d) skip = -1; d--; }
    else if (c === '\\') {
      const n = s[i + 1];
      if (n === "'") { if (skip < 0) out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; }
      else if (/[\\{}]/.test(n)) { if (skip < 0) out += n; i++; }
      else if (n === '~') { if (skip < 0) out += ' '; i++; }
      else {
        const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i, i + 40)); if (!m) continue;
        i += m[0].length - 1;
        if (skip >= 0) continue;
        const w = m[1];
        if (w === 'par' || w === 'line' || w === 'row') out += '\n'; else if (w === 'tab' || w === 'cell') out += '\t';
        else if (w === 'u') { const v = +m[2]; out += String.fromCharCode(v < 0 ? v + 65536 : v); if (s[i + 1] === '\\' && s[i + 2] === "'") i += 4; else if (s[i + 1] && !/[\\{}]/.test(s[i + 1])) i++; }
      }
    } else if (skip < 0 && c !== '\r' && c !== '\n') out += c;
  }
  return tidy(out);
}

// ---------- PDF (built-in reader for ordinary text PDFs; pdftotext is preferred when installed) ----------
function pdfText(buf) {
  const s = buf.toString('latin1'), objs = new Map();
  if (/\/Encrypt\s*(<<|\d+\s+\d+\s+R)/.test(s)) throw fail(422, 'This PDF is password-protected. Remove the password and upload it again.');
  const a85 = str => {   // ASCII85
    const t = str.toString('latin1').replace(/\s/g, '').replace(/^<~/, ''), end = t.indexOf('~>'), c = end < 0 ? t : t.slice(0, end), out = []; let g = [];
    for (const ch of c) {
      if (ch === 'z' && !g.length) { out.push(0, 0, 0, 0); continue; }
      g.push(ch.charCodeAt(0) - 33);
      if (g.length === 5) { let v = 0; for (const x of g) v = v * 85 + x; out.push(v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255); g = []; }
    }
    if (g.length > 1) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const x of g) v = v * 85 + x; out.push(...[v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255].slice(0, n - 1)); }
    return Buffer.from(out);
  };
  const inflate = (dict, data) => {   // applies the stream's filter chain; returns latin1 text, or null if a filter is unsupported
    if (!data) return null;
    const names = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] || '').match(/\/\w+/g) || []; let d = data;
    try {
      for (const n of names) {
        if (n === '/FlateDecode' || n === '/Fl') d = zlib.inflateSync(d, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        else if (n === '/ASCII85Decode' || n === '/A85') d = a85(d);
        else if (n === '/ASCIIHexDecode' || n === '/AHx') d = Buffer.from(d.toString('latin1').replace(/[^0-9a-fA-F]/g, '').replace(/(..)/g, '$1 ').trim().split(' ').map(x => parseInt(x.padEnd(2, '0'), 16)));
        else return null;
      }
    } catch { return null; }
    return d.toString('latin1');
  };
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const start = re.lastIndex, end = s.indexOf('endobj', start); if (end < 0) break;
    const body = s.slice(start, end), sm = />>\s*stream(\r\n|\n|\r)/.exec(body); let dict = body, data = null;
    if (sm) { dict = body.slice(0, sm.index + 2); const ds = start + sm.index + sm[0].length, de = s.indexOf('endstream', ds); data = buf.subarray(ds, de < 0 ? end : de); }
    objs.set(+m[1], { dict, data, text: undefined });
    re.lastIndex = end + 6;
  }
  const stream = id => { const o = objs.get(id); if (!o) return ''; return o.text ??= inflate(o.dict, o.data) ?? ''; };
  for (const [, o] of [...objs]) {   // objects packed inside object streams (PDF 1.5+)
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const t = inflate(o.dict, o.data); if (!t) continue;
    const n = +o.dict.match(/\/N\s+(\d+)/)?.[1], first = +o.dict.match(/\/First\s+(\d+)/)?.[1], h = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) objs.set(h[2 * i], { dict: t.slice(first + h[2 * i + 1], i + 1 < n ? first + h[2 * i + 3] : undefined), data: null });
  }
  const getDict = (str, key) => {
    const mm = new RegExp('/' + key + '(?![A-Za-z])\\s*').exec(str); if (!mm) return null;
    const r = str.slice(mm.index + mm[0].length);
    if (r.startsWith('<<')) { let d = 0, i = 0; for (; i < r.length; i++) { if (r.startsWith('<<', i)) { d++; i++; } else if (r.startsWith('>>', i)) { d--; i++; if (!d) { i++; break; } } } return r.slice(0, i); }
    const rm = /^(\d+)\s+\d+\s+R/.exec(r); return rm ? objs.get(+rm[1])?.dict ?? '' : null;
  };
  const refs = (str, key) => { const mm = new RegExp('/' + key + '\\s*(\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R)').exec(str); return mm ? [...mm[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(x => +x[1]) : []; };
  const u = h => h.length <= 2 ? String.fromCharCode(parseInt(h || '0', 16)) : String.fromCharCode(...h.match(/.{1,4}/g).map(x => parseInt(x.padEnd(4, '0'), 16)));
  const cmaps = new Map(), fontOf = id => {
    if (cmaps.has(id)) return cmaps.get(id);
    const d = objs.get(id)?.dict || '', tu = d.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1], f = { two: /\/Subtype\s*\/Type0/.test(d), map: null };
    if (tu) {
      const t = stream(+tu), mp = f.map = new Map();
      for (const b of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) mp.set(parseInt(x[1], 16), u(x[2]));
      for (const b of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
        const lo = parseInt(x[1], 16), hi = Math.min(parseInt(x[2], 16), lo + 65535);
        if (x[3][0] === '[') { const arr = [...x[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(y => u(y[1])); for (let c = lo; c <= hi && c - lo < arr.length; c++) mp.set(c, arr[c - lo]); }
        else { const base = u(x[3].slice(1, -1)); for (let c = lo; c <= hi; c++) mp.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + c - lo)); }
      }
    }
    cmaps.set(id, f); return f;
  };
  const resources = dict => { for (let i = 0, d = dict; i < 12 && d != null; i++) { const r = getDict(d, 'Resources'); if (r != null) return r; const p = d.match(/\/Parent\s+(\d+)\s+\d+\s+R/)?.[1]; d = p ? objs.get(+p)?.dict : null; } return ''; };
  const sub = (res, key) => { const d = getDict(res, key) || ''; return Object.fromEntries([...d.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)].map(x => [x[1], +x[2]])); };

  function runContent(src, res, depth) {
    const fonts = sub(res, 'Font'), xobj = sub(res, 'XObject'); let font = null, out = '', st = [], arr = null, lastY = null, i = 0; const marks = [];
    const show = bytes => {
      if (!font) { out += bytes; return; }
      if (!font.map) { if (!font.two) out += bytes; return; }
      if (font.two) for (let k = 0; k + 1 < bytes.length; k += 2) out += font.map.get(bytes.charCodeAt(k) << 8 | bytes.charCodeAt(k + 1)) ?? '';
      else for (let k = 0; k < bytes.length; k++) out += font.map.get(bytes.charCodeAt(k)) ?? bytes[k];
    };
    const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const push = v => (arr ? arr : st).push(v);
    while (i < src.length) {
      const c = src[i];
      if (c <= ' ') { i++; continue; }
      if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
      if (c === '(') {
        let d = 1, str = ''; i++;
        while (i < src.length && d) {
          const ch = src[i++];
          if (ch === '\\') {
            const n = src[i++];
            if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(src[i] || '')) o += src[i++]; str += String.fromCharCode(parseInt(o, 8) & 255); }
            else if (n === 'n') str += '\n'; else if (n === 'r') str += '\r'; else if (n === 't') str += '\t'; else if (n === 'b') str += '\b'; else if (n === 'f') str += '\f';
            else if (n === '\r') { if (src[i] === '\n') i++; } else if (n !== '\n') str += n;
          } else if (ch === '(') { d++; str += ch; } else if (ch === ')') { if (--d) str += ch; } else str += ch;
        }
        push({ s: str }); continue;
      }
      if (c === '<') {
        if (src[i + 1] === '<') { i += 2; continue; }
        const j = src.indexOf('>', i); let hx = src.slice(i + 1, j < 0 ? src.length : j).replace(/\s+/g, ''); if (hx.length % 2) hx += '0';
        push({ s: String.fromCharCode(...(hx.match(/../g) || []).map(x => parseInt(x, 16))) }); i = j < 0 ? src.length : j + 1; continue;
      }
      if (c === '>') { i += src[i + 1] === '>' ? 2 : 1; continue; }
      if (c === '[') { arr = []; i++; continue; }
      if (c === ']') { if (arr) { st.push({ a: arr }); arr = null; } i++; continue; }
      if (c === '/') { let j = i + 1; while (j < src.length && !/[\s/<>\[\]()%]/.test(src[j])) j++; push({ n: src.slice(i + 1, j) }); i = j; continue; }
      let j = i; while (j < src.length && !/[\s/<>\[\]()%]/.test(src[j])) j++;
      const tok = src.slice(i, j); i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { push(parseFloat(tok)); continue; }
      const top = k => st[st.length - k];
      switch (tok) {
        case 'Tf': { const n = top(2)?.n; font = n && fonts[n] ? fontOf(fonts[n]) : null; break; }
        case 'Tj': if (top(1)?.s != null) show(top(1).s); break;
        case "'": nl(); if (top(1)?.s != null) show(top(1).s); break;
        case '"': nl(); if (top(1)?.s != null) show(top(1).s); break;
        case 'TJ': for (const e of top(1)?.a || []) { if (e?.s != null) show(e.s); else if (typeof e === 'number' && e < -200 && out && !/\s$/.test(out)) out += ' '; } break;
        case 'Td': case 'TD': if (Math.abs(top(1)) > 0.01) nl(); break;
        case 'T*': nl(); break;
        case 'Tm': { const y = top(1); if (lastY != null && Math.abs(y - lastY) > 1) nl(); lastY = y; break; }
        case 'BMC': case 'BDC': marks.push({ rev: st[0]?.n === 'ReversedChars', at: out.length }); break;
        case 'EMC': { const mk = marks.pop(); if (mk?.rev) out = out.slice(0, mk.at) + [...out.slice(mk.at)].reverse().join(''); break; }
        case 'BT': lastY = null; break;
        case 'ET': nl(); break;
        case 'ID': { const e = src.slice(i).search(/\sEI(?=\s|$)/); i = e < 0 ? src.length : i + e + 3; break; }   // skip inline image bytes
        case 'Do': { const id = xobj[top(1)?.n]; const o = id && objs.get(id);
          if (o && depth < 3 && /\/Subtype\s*\/Form/.test(o.dict)) { nl(); out += runContent(stream(id), getDict(o.dict, 'Resources') || res, depth + 1); nl(); } break; }
      }
      st = []; arr = null;
    }
    return out;
  }

  // page order: walk /Catalog -> /Pages -> /Kids
  const pages = [], seen2 = new Set();
  const walk = id => {
    if (seen2.has(id)) return; seen2.add(id); const o = objs.get(id); if (!o) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict) || (/\/Kids/.test(o.dict) && !/\/Type\s*\/Page\b/.test(o.dict))) refs(o.dict, 'Kids').forEach(walk); else pages.push(id);
  };
  const root = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const pr = root && root[1].dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/)?.[1]; if (pr) walk(+pr);
  if (!pages.length) for (const [id, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(id);
  const text = pages.map(id => { const d = objs.get(id).dict; return refs(d, 'Contents').map(stream).map(c => runContent(c, resources(d), 0)).join('\n'); });
  return { text: text.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), pages: pages.length };
}
const arabicShare = t => { const L = t.match(/\p{L}/gu) || []; return L.length ? (t.match(/[؀-ۿݐ-ݿ]/g) || []).length / L.length : 0; };
async function pdf(buf, meter) {
  let text = '';
  if (await has('pdftotext')) {
    text = await withTmp(async d => { const f = path.join(d, 'in.pdf'); fs.writeFileSync(f, buf);
      try { return (await run('pdftotext', ['-enc', 'UTF-8', f, '-'], { maxBuffer: 200e6, timeout: 120000 })).stdout.replace(/\f/g, '\n\n').trim(); }
      catch (e) { if (/Incorrect password|encrypted/i.test(e.stderr || '')) throw fail(422, 'This PDF is password-protected. Remove the password and upload it again.'); return ''; } });
  }
  let pages = 1;
  if (!text) { const r = pdfText(buf); text = r.text; pages = Math.max(1, r.pages); }
  text = text.replace(/[ﭐ-﷿ﹰ-﻿]+/g, m => m.normalize('NFKC')).replace(/[‎‏‪-‮⁦-⁩]/g, '');   // shaped Arabic glyphs -> ordinary letters; drop bidi control marks
  const real = text.replace(/\s/g, '').length, rtl = arabicShare(text) > .3, ai = !!E.AI_API_KEY;
  // Arabic PDFs store glyphs in visual order, so plain extraction can scramble word order / ligatures: let the AI read those when it is available. Same for scanned PDFs.
  if (real >= 20 * Math.min(pages, 3) && !(rtl && ai)) return { text, note: rtl ? 'rtl' : null };
  if (!ai) { if (real > 0) return { text, note: rtl ? 'rtl' : null }; throw fail(422, 'This PDF has no readable text (it looks scanned). Set AI_API_KEY on the server so Cogniva can read it with AI, or upload the pages as images.'); }
  if (buf.length > 18e6) { if (real > 0) return { text, note: rtl ? 'rtl' : null }; throw fail(413, 'This scanned PDF is too large for AI reading (max about 18 MB).'); }
  const data = 'data:application/pdf;base64,' + buf.toString('base64'), ask = 'Extract ALL the text of this document faithfully, in reading order, in its original language (keep Arabic in correct logical order). Put short descriptions of figures/diagrams in [square brackets]. Output only the content.';
  try {
    return { text: await meter(async () => {
      try { return await llm([{ type: 'text', text: ask }, { type: 'file', file: { filename: 'document.pdf', file_data: data } }], 'PDF reading', 240000); }
      catch (e) { if (e.code === 503) throw e; return llm([{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: data } }], 'PDF reading', 240000); } }) };
  } catch (e) {
    if (real > 0) return { text, note: rtl ? 'rtl' : null };   // the provider could not read PDFs: keep what we extracted locally
    throw fail(422, 'The AI provider could not read this scanned PDF. Try exporting its pages as images (PNG/JPG) and uploading those.');
  }
}

// ---------- images ----------
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
async function image(buf, ext, meter) {
  let data = buf, mime = IMG_MIME[ext];
  if (await has('ffmpeg') && (!mime || buf.length > 4e6)) {   // odd formats (bmp/tiff/heic/avif...) and big photos -> a JPEG of at most 2048 px
    data = await withTmp(async d => { const i = path.join(d, 'in.' + (ext || 'img')), o = path.join(d, 'out.jpg'); fs.writeFileSync(i, buf);
      try { await run('ffmpeg', ['-v', 'error', '-y', '-i', i, '-frames:v', '1', '-vf', 'scale=min(2048\\,iw):min(2048\\,ih):force_original_aspect_ratio=decrease', '-q:v', '3', o], { timeout: 60000 }); } catch { throw fail(422, 'Could not decode this image.'); }
      return fs.readFileSync(o); });
    mime = 'image/jpeg';
  }
  if (!mime) throw fail(415, `Images of type .${ext} need ffmpeg on the server. Convert it to PNG or JPG and upload again.`);
  if (data.length > 15e6) throw fail(413, 'Image is too large (max 15 MB).');
  return meter(() => llm([{ type: 'text', text: 'Transcribe ALL text visible in this image exactly as written (any language, including handwriting), keeping its structure. Then, if it contains diagrams, charts, tables, equations or photos, add a section "Visual content:" that explains them clearly enough to study from. Output only that.' },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } }], 'Image reading'));
}

// ---------- audio / video ----------
async function media(buf, ext, meter) {
  let parts;
  if (await has('ffmpeg')) {
    parts = await withTmp(async d => {
      fs.writeFileSync(path.join(d, 'in.bin'), buf);
      try { await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(d, 'in.bin'), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', path.join(d, 'p%03d.mp3')], { timeout: 600000 }); }
      catch (e) { throw fail(422, /does not contain any stream|no audio|matches no streams/i.test(e.stderr || '') ? 'No audio track was found in this file.' : 'Could not decode this audio/video file.'); }
      return fs.readdirSync(d).filter(f => /^p\d+\.mp3$/.test(f)).sort().map(f => ({ buf: fs.readFileSync(path.join(d, f)), ext: 'mp3' }));
    });
    if (!parts.length) throw fail(422, 'No audio track was found in this file.');
    if (parts.length * 10 > maxMediaMin()) throw fail(413, `Recording is too long (max ${maxMediaMin()} minutes).`);
  } else {
    const c = await caps();
    if (!c.direct.includes(ext) || buf.length > c.directMB * 1048576)
      throw fail(415, `This ${ext.toUpperCase()} file can't be read without ffmpeg on the server (the web page normally converts it for you). Install ffmpeg, or upload a smaller MP3/WAV.`);
    parts = [{ buf, ext }];
  }
  return meter(async () => { const texts = []; for (const p of parts) texts.push((await transcribe(p.buf, p.ext)).trim()); return texts.filter(Boolean).join('\n\n'); });
}

// ---------- legacy Office (.doc/.xls/.ppt) via LibreOffice when present ----------
async function legacy(buf, ext) {
  if (!await has('soffice')) throw fail(415, `Old Office files (.${ext}) aren't supported on this server. Save the file as .docx / .xlsx / .pptx (or PDF) and upload it again.`);
  const to = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }[ext];
  return withTmp(async d => {
    const f = path.join(d, 'in.' + ext); fs.writeFileSync(f, buf);
    try { await run('soffice', ['--headless', `-env:UserInstallation=file://${d}/profile`, '--convert-to', to, '--outdir', path.join(d, 'out'), f], { timeout: 120000 }); } catch { throw fail(422, 'Could not convert this old Office file.'); }
    const o = path.join(d, 'out', 'in.' + to); if (!fs.existsSync(o)) throw fail(422, 'Could not convert this old Office file.');
    return { to, text: { docx, xlsx, pptx }[to](unzip(fs.readFileSync(o))) };
  });
}

// ---------- entry point ----------
const EXT = { pdf: 'pdf', docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx', pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx', xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
  odt: 'odf', ott: 'odf', ods: 'odf', odp: 'odf', odg: 'odf', epub: 'epub', rtf: 'rtf', html: 'html', htm: 'html', xhtml: 'html', doc: 'legacy', xls: 'legacy', ppt: 'legacy', dot: 'legacy', pps: 'legacy' };
const IMG = new Set('png jpg jpeg jfif gif webp bmp tif tiff heic heif avif ico'.split(' '));
const AUD = new Set('mp3 wav m4a aac ogg oga opus flac wma amr aiff aif weba mka mpga ac3 caf'.split(' '));
const VID = new Set('mp4 mov mkv avi webm wmv flv m4v mpeg mpg 3gp mts m2ts ogv'.split(' '));

export async function extract(buf, name, mime, meter) {
  const ext = (/\.([^./\\]+)$/.exec(name)?.[1] || '').toLowerCase(); let kind = EXT[ext] || (IMG.has(ext) ? 'image' : AUD.has(ext) ? 'audio' : VID.has(ext) ? 'video' : null), z = null;
  if (!kind) {
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') kind = 'pdf';
    else if (buf[0] === 0x50 && buf[1] === 0x4b) { try { z = unzip(buf); kind = zipKind(z); } catch {} }
    else if (/^(image|audio|video)\//.test(mime)) kind = mime.split('/')[0];
    else if (looksText(buf)) kind = 'text';
  }
  if (!kind) throw fail(415, `Unsupported file type${ext ? ' (.' + ext + ')' : ''}. Supported: text/code, PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, HTML, images, audio and video.`);
  let text, note = null;
  switch (kind) {
    case 'text': text = decodeText(buf); break;
    case 'html': text = html2text(decodeText(buf)); break;
    case 'rtf': text = rtf(buf.toString('latin1')); break;
    case 'pdf': { const r = await pdf(buf, meter); text = r.text; note = r.note; break; }
    case 'docx': case 'pptx': case 'xlsx': case 'odf': case 'epub': text = { docx, pptx, xlsx, odf, epub }[kind](z || unzip(buf)); break;
    case 'legacy': { const r = await legacy(buf, ext); text = r.text; kind = r.to; break; }
    case 'image': text = await image(buf, ext, meter); break;
    default: text = await media(buf, ext, meter);   // audio | video
  }
  text = String(text).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw fail(422, kind === 'audio' || kind === 'video' ? 'No speech was detected in this file.' : 'No readable text was found in this file.');
  return { kind, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, note };
}
