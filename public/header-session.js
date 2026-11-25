// A public page may be outside both session-cookie paths. Ask the workspace
// for the sign-out action without moving either credential to a broader path.
const template = document.querySelector('template[data-header-session]');
if (template) {
  let form;
  async function refresh() {
    form?.remove();
    try {
      const response = await fetch(template.dataset.headerSession, {
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store'
      });
      if (!response.ok) return;
      const session = await response.json();
      if (!session) return;
      form = template.content.firstElementChild.cloneNode(true);
      form.action = session.action;
      form.elements.csrf.value = session.csrf;
      template.after(form);
    } catch { /* Public pages stay usable if the session check is unavailable. */ }
  }
  refresh();
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
}
