PAGE.en = { title:'Create your account', name:'Full name', email:'Email', password:'Password', confirm:'Confirm password', role:'I am a',
  student:'Student', teacher:'Teacher', terms:'I accept the terms of use', create:'Create account', have:'Already have an account? Sign in',
  strength:['Too weak','Weak','Fair','Good','Strong'] };
PAGE.ar = { title:'أنشئ حسابك', name:'الاسم الكامل', email:'البريد الإلكتروني', password:'كلمة المرور', confirm:'تأكيد كلمة المرور', role:'أنا',
  student:'طالب', teacher:'معلم', terms:'أوافق على شروط الاستخدام', create:'إنشاء الحساب', have:'لديك حساب؟ سجّل الدخول',
  strength:['ضعيفة جداً','ضعيفة','متوسطة','جيدة','قوية'] };
const COLORS = ['#f87171', '#f87171', '#F59E0B', '#14B8A6', '#14B8A6'];
function score(p) {
  if (p.length < 8) return 0;
  let s = 1; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p) || p.length >= 12) s++;
  return s;
}
function onApply() {
  const p = $('pw').value, s = score(p);
  document.querySelectorAll('.meter i').forEach((b, i) => b.classList.toggle('on', p && i < s));
  $('meter').style.setProperty('--c', COLORS[s]);
  $('sTxt').textContent = p ? t('strength')[s] : '';
  if (!$('go').disabled) $('go').textContent = t('create');
}
$('pw').addEventListener('input', onApply);
$('role').addEventListener('change', () => { $('gg').href = '/auth/google?role=' + $('role').value; $('gh').href = '/auth/github?role=' + $('role').value; });
$('form').addEventListener('submit', async e => {
  e.preventDefault(); showAlert('');
  const v = { name: $('name').value.trim(), email: $('email').value.trim(), pw: $('pw').value };
  if (setErrors({ eName: v.name ? '' : t('eName'), eEmail: validEmail(v.email) ? '' : t('eEmail'), ePw: v.pw.length >= 8 ? '' : t('ePw'),
                  ePw2: $('pw2').value === v.pw ? '' : t('eMatch'), eTerms: $('terms').checked ? '' : t('eTerms') })) return;
  busy(true, 'create');
  const r = await post('/api/register', { name: v.name, email: v.email, password: v.pw, role: $('role').value });
  if (r.ok) { location.href = '/app'; return; }
  showAlert(errMsg(r)); busy(false, 'create');
});
apply();
