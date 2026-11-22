PAGE.en = { title:'Reset your password', sub:'Enter your email and we will send you a reset link.', email:'Email', send:'Send reset link',
  sent:'If this email is registered, a reset link has been sent. Check your inbox.' };
PAGE.ar = { title:'استعادة كلمة المرور', sub:'أدخل بريدك الإلكتروني وسنرسل لك رابطاً لإعادة التعيين.', email:'البريد الإلكتروني', send:'إرسال الرابط',
  sent:'إذا كان هذا البريد مسجّلاً فقد أُرسل إليه رابط إعادة التعيين. تحقّق من صندوق الوارد.' };
function onApply() { if (!$('go').disabled) $('go').textContent = t('send'); if (!$('alert').hidden && $('form').hidden) $('alert').textContent = t('sent'); }
$('form').addEventListener('submit', async e => {
  e.preventDefault(); showAlert('');
  const email = $('email').value.trim();
  if (setErrors({ eEmail: validEmail(email) ? '' : t('eEmail') })) return;
  busy(true, 'send');
  const r = await post('/api/forgot', { email });
  if (r.ok) { $('form').hidden = true; showAlert(t('sent'), true); return; }
  showAlert(errMsg(r)); busy(false, 'send');
});
apply();
