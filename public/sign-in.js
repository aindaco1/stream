const fragment = location.hash.slice(1);
if (fragment) {
  const code = new URLSearchParams(fragment).get('magic-link') || fragment;
  history.replaceState(null, '', location.pathname + location.search);
  if (/^[\w-]{43}$/.test(code)) {
    const form = document.querySelector('[data-exchange]');
    form.elements.code.value = code;
    form.hidden = false;
    document.querySelector('[data-request-link]').hidden = true;
    form.querySelector('button').focus();
  }
}

const widget = document.querySelector('.cf-turnstile');
if (widget && !widget.closest('[hidden]')) {
  widget.dataset.size = window.DustWaveAdminShellTurnstile.responsiveSize(widget);
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.append(script);
}
