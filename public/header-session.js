// A public page may be outside both session-cookie paths. Ask the workspace
// for the sign-out action without moving either credential to a broader path.
const template = document.querySelector('template[data-header-session]');
if (template) {
  const guestLink = document.querySelector('[data-guest-sign-in]');
  const homeAccount = document.querySelector('[data-home-account]');
  const signupHref = homeAccount?.getAttribute('href');
  const signupLabel = homeAccount?.textContent;
  let form;
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    let session;
    try {
      const response = await fetch(template.dataset.headerSession, {
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store'
      });
      if (response.ok) session = await response.json();
    } catch { /* Keep public navigation available if the session check fails. */ }
    if (current !== revision) return;
    if (guestLink) guestLink.hidden = Boolean(session);
    if (homeAccount) {
      homeAccount.href = session?.dashboard ?? signupHref;
      homeAccount.textContent = session ? 'Go to dashboard' : signupLabel;
    }
    if (session) {
      if (!form) {
        form = template.content.firstElementChild.cloneNode(true);
        template.after(form);
      }
      form.action = session.action;
      form.elements.csrf.value = session.csrf;
    } else {
      form?.remove();
      form = null;
    }
  }
  refresh();
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
