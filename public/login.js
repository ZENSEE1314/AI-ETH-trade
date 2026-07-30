// Login / register page logic.

const $ = (id) => document.getElementById(id);
let mode = 'login';

async function refreshBootstrap() {
  try {
    const me = await fetch('/auth/me').then((r) => r.json());
    if (me.user) { location.href = '/'; return; } // already signed in
    if (me.needsBootstrap) {
      setMode('register');
      $('bootstrapNote').classList.remove('hidden');
      $('code').removeAttribute('required');
      $('codeRow').classList.add('hidden'); // no code needed for first account
    }
  } catch { /* offline; let the form try anyway */ }
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === next));
  $('submitBtn').textContent = next === 'login' ? 'Log in' : 'Create account';
  const bootstrap = !$('bootstrapNote').classList.contains('hidden');
  $('codeRow').classList.toggle('hidden', next === 'login' || bootstrap);
  $('authError').textContent = '';
}

document.querySelectorAll('.auth-tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  const payload = { username: $('username').value, password: $('password').value };
  if (mode === 'register') payload.code = $('code').value;
  const url = mode === 'login' ? '/auth/login' : '/auth/register';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
    location.href = '/';
  } catch (err) {
    $('authError').textContent = err.message;
  }
});

refreshBootstrap();
