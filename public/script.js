// ---- Settings ----
const API_LOGIN = '/api/login';   // Cogniva backend endpoint
const REDIRECT  = '/app';            // where to go after a successful login
const COLORS = ['#38BDF8', '#3B82F6', '#14B8A6', '#F59E0B', '#F43F5E', '#A78BFA'];

const T = {
  en: { sub:'Sign in to continue learning', email:'Email', password:'Password', login:'Sign in', show:'Show', hide:'Hide',
        light:'Light', dark:'Dark', loading:'Signing in…', color:'Light color',
        forgot:'Forgot password?', or:'or', google:'Google', github:'GitHub', authNotConf:'This sign-in method is not set up yet.', authFailed:'Sign-in with the provider failed. Please try again.', authNoEmail:'Your account has no verified email address.', authSuspended:'This account is suspended.', newAcc:'Create account', hintOff:'Pull the cord to turn on the light', hintOn:'Pull the cord again to hide the form',
        eEmail:'Enter a valid email address', ePw:'Password must be at least 8 characters',
        net:'Cannot reach the server. Check your connection.', fail:'Sign-in failed. Please try again.' },
  ar: { sub:'سجّل دخولك لمتابعة التعلّم', email:'البريد الإلكتروني', password:'كلمة المرور', login:'تسجيل الدخول', show:'إظهار', hide:'إخفاء',
        light:'فاتح', dark:'داكن', loading:'جارٍ تسجيل الدخول…', color:'لون الضوء',
        forgot:'نسيت كلمة المرور؟', or:'أو', google:'Google', github:'GitHub', authNotConf:'طريقة الدخول هذه لم تُفعَّل بعد.', authFailed:'فشل الدخول عبر الموقع. حاول مرة أخرى.', authNoEmail:'حسابك لا يحتوي على بريد إلكتروني موثّق.', authSuspended:'هذا الحساب موقوف.', newAcc:'إنشاء حساب جديد', hintOff:'اسحب الخيط لإضاءة المصباح', hintOn:'اسحب الخيط مرة أخرى لإخفاء النموذج',
        eEmail:'أدخل بريداً إلكترونياً صحيحاً', ePw:'كلمة المرور 8 أحرف على الأقل',
        net:'تعذّر الاتصال بالخادم. تحقّق من اتصالك.', fail:'فشل تسجيل الدخول. حاول مرة أخرى.' }
};
const SERVER_AR = {
  'Invalid email or password':'البريد الإلكتروني أو كلمة المرور غير صحيحة',
  'Too many attempts. Try again later.':'محاولات كثيرة. حاول لاحقاً.',
  'Account suspended':'هذا الحساب موقوف'
};

const $ = id => document.getElementById(id);
const state = { lang: localStorage.lang || 'en', theme: localStorage.theme || 'dark', color: localStorage.color || COLORS[0], on: false };
const t = k => T[state.lang][k];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- UI text / theme / color ----
function apply() {
  const d = document.documentElement;
  d.lang = state.lang; d.dir = state.lang === 'ar' ? 'rtl' : 'ltr'; d.dataset.theme = state.theme;
  d.style.setProperty('--lc', state.color);
  document.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  $('go').textContent = $('go').disabled ? t('loading') : t('login');
  $('toggle').textContent = t($('pw').type === 'password' ? 'show' : 'hide');
  $('hint').textContent = t(state.on ? 'hintOn' : 'hintOff');
  $('lang').textContent = state.lang === 'en' ? 'العربية' : 'English';
  $('theme').textContent = state.theme === 'dark' ? t('light') : t('dark');
  $('colors').setAttribute('aria-label', t('color'));
  document.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c.toLowerCase() === state.color.toLowerCase()));
  $('custom').value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : COLORS[0];
}
function setColor(c) { state.color = c; localStorage.color = c; apply(); }
COLORS.forEach(c => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'sw'; b.dataset.c = c; b.style.setProperty('--c', c); b.setAttribute('aria-label', c);
  b.onclick = () => setColor(c); $('colors').append(b);
});
$('custom').oninput = e => setColor(e.target.value);
$('lang').onclick  = () => { state.lang  = state.lang  === 'en'   ? 'ar'    : 'en';    localStorage.lang  = state.lang;  apply(); };
$('theme').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.theme = state.theme; apply(); };
$('toggle').onclick = () => { $('pw').type = $('pw').type === 'password' ? 'text' : 'password'; apply(); };

// ---- Lamp: drag the cord in any direction to toggle ----
const svg = $('lampSvg'), knobG = $('knobG');
const AX = 196, AY = 198, LEN = 150, MAXLEN = LEN + 90, TRIGGER = 45;
const REST = { x: AX, y: AY + LEN };
let pos = { ...REST }, dragging = false, fired = false, raf = 0;

function draw() {
  $('cord').setAttribute('x2', pos.x); $('cord').setAttribute('y2', pos.y);
  for (const id of ['knob', 'grab']) { $(id).setAttribute('cx', pos.x); $(id).setAttribute('cy', pos.y); }
}
function toSvg(e) { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
function spring() {                                     // cord snaps back with a small bounce
  cancelAnimationFrame(raf);
  if (reduced) { pos = { ...REST }; draw(); return; }
  const v = { x: 0, y: 0 };
  const step = () => {
    v.x = (v.x + (REST.x - pos.x) * 0.18) * 0.78; v.y = (v.y + (REST.y - pos.y) * 0.18) * 0.78;
    pos.x += v.x; pos.y += v.y; draw();
    if (Math.hypot(v.x, v.y) > 0.05 || Math.hypot(REST.x - pos.x, REST.y - pos.y) > 0.2) raf = requestAnimationFrame(step);
    else { pos = { ...REST }; draw(); }
  };
  raf = requestAnimationFrame(step);
}
function toggle() {
  state.on = !state.on;
  $('stage').classList.toggle('on', state.on);
  knobG.setAttribute('aria-pressed', state.on);
  if (state.on) { if (matchMedia('(hover:hover)').matches) setTimeout(() => $('email').focus(), 400); }
  else { $('pw').value = ''; $('pw').type = 'password'; showAlert(''); }
  apply();
}
knobG.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
knobG.addEventListener('pointerdown', e => { dragging = true; fired = false; cancelAnimationFrame(raf); knobG.setPointerCapture(e.pointerId); e.preventDefault(); });
knobG.addEventListener('pointermove', e => {
  if (!dragging) return;
  const p = toSvg(e); let dx = p.x - AX, dy = p.y - AY; const len = Math.hypot(dx, dy);
  if (len > MAXLEN) { dx *= MAXLEN / len; dy *= MAXLEN / len; }   // the cord can only stretch so far
  pos = { x: AX + dx, y: AY + dy }; draw();
  if (!fired && Math.hypot(pos.x - REST.x, pos.y - REST.y) > TRIGGER) { fired = true; toggle(); }  // one "click" per pull
});
const release = () => { if (dragging) { dragging = false; spring(); } };
knobG.addEventListener('pointerup', release); knobG.addEventListener('pointercancel', release);
knobG.addEventListener('keydown', e => {                // keyboard: Enter / Space
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); pos = { x: REST.x, y: REST.y + 40 }; draw(); spring(); }
});

// ---- Login form ----
function validate() {
  const email = $('email').value.trim(), pw = $('pw').value;
  const okE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), okP = pw.length >= 8;
  $('eEmail').textContent = okE ? '' : t('eEmail'); $('email').classList.toggle('bad', !okE);
  $('ePw').textContent    = okP ? '' : t('ePw');    $('pw').classList.toggle('bad', !okP);
  return okE && okP;
}
const showAlert = m => { $('alert').textContent = m || ''; $('alert').hidden = !m; };

$('form').addEventListener('submit', async e => {
  e.preventDefault(); showAlert('');
  if (!validate()) return;
  const btn = $('go'); btn.disabled = true; apply();
  try {
    const r = await fetch(API_LOGIN, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('pw').value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { location.href = REDIRECT; return; }
    showAlert(state.lang === 'ar' ? (SERVER_AR[d.error] || t('fail')) : (d.error || t('fail')));
  } catch { showAlert(t('net')); }
  btn.disabled = false; apply();
});

apply(); draw();
// Errors coming back from Google/GitHub sign-in (/?auth_error=...): open the lamp and show the message
const AUTH_ERR = { not_configured:'authNotConf', failed:'authFailed', no_email:'authNoEmail', suspended:'authSuspended' };
const authErr = new URLSearchParams(location.search).get('auth_error');
if (authErr && AUTH_ERR[authErr]) { toggle(); showAlert(t(AUTH_ERR[authErr])); history.replaceState(null, '', '/'); }

// ---- Intro: the logo draws itself, then flies into its place in the lamp's light ----
if (document.documentElement.classList.contains('intro')) {
  let started = false;
  const start = () => {
    if (started) return; started = true;
    const il = $('ilogo');
    il.querySelectorAll('.arc,.dot').forEach(e => e.getAnimations().forEach(a => a.finish()));   // clicking early skips the drawing
    const r = il.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const m = svg.getScreenCTM(), pt = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(m); };
    const a = pt(107, 318), b = pt(107 + 86.4, 318 + 86.4), w = b.x - a.x;          // the logo's slot under the lamp (same numbers as in index.html)
    const tx = a.x + w / 2 - cx, ty = a.y + w / 2 - cy, s = w / r.width;
    $('iword').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    document.querySelector('.ibg').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, delay: 150, fill: 'forwards' });
    il.animate([{ transform: 'none', opacity: 1, filter: getComputedStyle(il).filter }, { transform: `translate(${tx}px,${ty}px) scale(${s})`, opacity: .28, filter: 'drop-shadow(0 0 0 transparent)' }],
      { duration: 1050, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' }).finished.then(() => {
        const h = document.documentElement; h.classList.add('intro-done'); h.classList.remove('intro'); $('intro').remove();
        requestAnimationFrame(() => requestAnimationFrame(() => h.classList.remove('intro-done')));
      });
  };
  $('intro').addEventListener('click', start); addEventListener('keydown', start, { once: true });
  setTimeout(start, 2100);
}
