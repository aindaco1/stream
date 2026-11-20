import { embedLayout, iframeCode, selectedFields } from './film-embed.js';

function openFilmAtFragment() {
  const target = document.getElementById(location.hash.slice(1));
  const card = target?.closest('details.dashboard-film');
  if (card && !card.open) {
    card.open = true;
    target.scrollIntoView({ block: 'start' });
  }
}

openFilmAtFragment();
window.addEventListener('hashchange', openFilmAtFragment);

for (const builder of document.querySelectorAll('.film-sharing')) {
  const populated = builder.dataset.populated.split(',');
  const form = builder.querySelector('form');
  const frame = builder.querySelector('iframe');
  const code = builder.querySelector('.embed-code');
  const status = builder.querySelector('.copy-status');
  const card = builder.closest('.dashboard-film');
  function update() {
    const selection = new FormData(form).getAll('include').join(',');
    const fields = selectedFields(selection);
    const layout = embedLayout(builder.dataset.player, fields, populated);
    const preview = embedLayout(builder.dataset.preview, fields, populated);
    if (frame.src !== preview.src) frame.src = preview.src;
    frame.height = layout.height;
    code.value = iframeCode(layout, frame.title);
    builder.querySelector('.public-player').href = layout.src;
    card.querySelector('[name=show]').value = selection;
    status.textContent = '';
  }
  // A history traversal may restore checkbox values without firing change.
  window.addEventListener('pageshow', () => requestAnimationFrame(update));
  form.addEventListener('change', update);
  form.addEventListener('submit', event => { event.preventDefault(); update(); });
  builder.querySelector('.copy-embed').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      status.textContent = 'Embed code copied.';
    } catch {
      code.focus();
      code.select();
      status.textContent = 'Copy the selected embed code.';
    }
  });
}
