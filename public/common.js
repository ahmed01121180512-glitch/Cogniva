// Shared by register / forgot / reset pages: language, theme, color, helpers.
const $ = id => document.getElementById(id);
const state = { lang: localStorage.lang || 'en', theme: localStorage.theme || 'dark', color: localStorage.color || '#38BDF8' };
const BASE = {
  en: { light:'Light', dark:'Dark', show:'Show', hide:'Hide', loading:'Please wait…', eEmail:'Enter a valid email address',
        or:'or', google:'Google', github:'GitHub', ePw:'Password must be at least 8 characters', eName:'Enter your name', eMatch:'Passwords do not match', eTerms:'You must accept the terms',
        net:'Cannot reach the server. Check your connection.', fail:'Something went wrong. Please try again.', back:'Back to sign in' },
  ar: { light:'فاتح', dark:'داكن', show:'إظهار', hide:'إخفاء', loading:'من فضلك انتظر…', eEmail:'أدخل بريداً إلكترونياً صحيحاً',
        or:'أو', google:'Google', github:'GitHub', ePw:'كلمة المرور 8 أحرف على الأقل', eName:'أدخل اسمك', eMatch:'كلمتا المرور غير متطابقتين', eTerms:'يجب الموافقة على الشروط',
        net:'تعذّر الاتصال بالخادم. تحقّق من اتصالك.', fail:'حدث خطأ. حاول مرة أخرى.', back:'العودة لتسجيل الدخول' }
};
const SERVER_AR = {
  'Email already registered':'هذا البريد مسجّل بالفعل',
  'Valid email and a password of at least 8 characters are required':'أدخل بريداً صحيحاً وكلمة مرور من 8 أحرف على الأقل',
  'Password must be at least 8 characters':'كلمة المرور 8 أحرف على الأقل',
  'Invalid or expired link':'الرابط غير صالح أو منتهي الصلاحية',
  'Too many attempts. Try again later.':'محاولات كثيرة. حاول لاحقاً.'
};
let PAGE = { en: {}, ar: {} };
const t = k => PAGE[state.lang][k] ?? BASE[state.lang][k] ?? k;

function apply() {
  const d = document.documentElement;
  d.lang = state.lang; d.dir = state.lang === 'ar' ? 'rtl' : 'ltr'; d.dataset.theme = state.theme;
  d.style.setProperty('--lc', state.color);
  document.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  document.querySelectorAll('.tg').forEach(b => { b.textContent = t($(b.dataset.for).type === 'password' ? 'show' : 'hide'); });
  $('lang').textContent = state.lang === 'en' ? 'العربية' : 'English';
  $('theme').textContent = state.theme === 'dark' ? t('light') : t('dark');
  if (window.onApply) window.onApply();
}
$('lang').onclick  = () => { state.lang  = state.lang  === 'en'   ? 'ar'    : 'en';    localStorage.lang  = state.lang;  apply(); };
$('theme').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.theme = state.theme; apply(); };
document.querySelectorAll('.tg').forEach(b => b.onclick = () => {
  const ids = (b.dataset.all || b.dataset.for).split(','), type = $(b.dataset.for).type === 'password' ? 'text' : 'password';
  ids.forEach(id => $(id).type = type); apply();
});

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, net: true, data: {} }; }
}
const errMsg = r => r.net ? t('net') : (state.lang === 'ar' ? (SERVER_AR[r.data.error] || t('fail')) : (r.data.error || t('fail')));
function showAlert(m, good) { const a = $('alert'); a.textContent = m || ''; a.hidden = !m; a.className = 'alert' + (good ? ' okbox' : ''); }
const validEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
function setErrors(map) { let bad = false; for (const [k, m] of Object.entries(map)) { $(k).textContent = m; if (m) bad = true; } return bad; }
function busy(on, key) { $('go').disabled = on; $('go').textContent = t(on ? 'loading' : key); }
