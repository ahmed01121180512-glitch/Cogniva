PAGE.en = { title:'Choose a new password', password:'New password', confirm:'Confirm password', save:'Save password',
  done:'Your password was updated. You can sign in now.', noToken:'This reset link is missing or invalid.', again:'Request a new link' };
PAGE.ar = { title:'اختر كلمة مرور جديدة', password:'كلمة المرور الجديدة', confirm:'تأكيد كلمة المرور', save:'حفظ كلمة المرور',
  done:'تم تحديث كلمة المرور. يمكنك تسجيل الدخول الآن.', noToken:'رابط إعادة التعيين مفقود أو غير صالح.', again:'اطلب رابطاً جديداً' };
const token = new URLSearchParams(location.search).get('token');
let finished = false;
function onApply() {
  if (!$('go').disabled) $('go').textContent = t('save');
  if (!token) $('alert').textContent = t('noToken'); else if (finished) $('alert').textContent = t('done');
}
if (!token) { $('form').hidden = true; showAlert(' '); $('again').hidden = false; }
$('form').addEventListener('submit', async e => {
  e.preventDefault(); showAlert('');
  const pw = $('pw').value;
  if (setErrors({ ePw: pw.length >= 8 ? '' : t('ePw'), ePw2: $('pw2').value === pw ? '' : t('eMatch') })) return;
  busy(true, 'save');
  const r = await post('/api/reset', { token, password: pw });
  if (r.ok) { finished = true; $('form').hidden = true; showAlert(t('done'), true); return; }
  showAlert(errMsg(r)); busy(false, 'save');
  if (r.data.error === 'Invalid or expired link') $('again').hidden = false;
});
apply();
