const form = document.querySelector('[data-exchange]');
const signInStatus = document.querySelector('[data-email-sign-in]');
let pendingSignIn = false;

function signInWhenVisible() {
  if (!pendingSignIn || document.visibilityState !== 'visible') return;
  pendingSignIn = false;
  form.requestSubmit();
}

function openPrivateLink() {
  const fragment = location.hash.slice(1);
  if (!fragment) return;
  const emailCode = new URLSearchParams(fragment).get('magic-link');
  const code = emailCode || fragment;
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[\w-]{43}$/.test(code)) return;

  form.elements.code.value = code;
  document.querySelector('[data-request-link]').hidden = true;
  // Sign-up confirms the agreement; older operator invitations use the manual form.
  pendingSignIn = Boolean(emailCode && signInStatus);
  form.hidden = pendingSignIn;
  if (signInStatus) signInStatus.hidden = !pendingSignIn;
  if (pendingSignIn) signInWhenVisible();
  else form.querySelector('button').focus();
}

window.addEventListener('hashchange', openPrivateLink);
document.addEventListener('visibilitychange', signInWhenVisible);
openPrivateLink();

const widget = document.querySelector('.cf-turnstile');
if (widget && !widget.closest('[hidden]')) {
  widget.dataset.size = window.DustWaveAdminShellTurnstile.responsiveSize(widget);
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.append(script);
}
