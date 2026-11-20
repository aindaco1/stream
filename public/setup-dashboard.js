import { embedLayout, iframeCode, selectedFields } from './film-embed.js';

for (const builder of document.querySelectorAll('.film-sharing')) {
  const populated = builder.dataset.populated.split(',');
  const form = builder.querySelector('form');
  const frame = builder.querySelector('iframe');
  const code = builder.querySelector('.embed-code');
  const status = builder.querySelector('.copy-status');
  const card = builder.closest('.dashboard-film');
  function update() {
    const selection = new FormData(form).getAll('include').join(',');
    const layout = embedLayout(builder.dataset.player, selectedFields(selection), populated);
    if (frame.src !== layout.src) frame.src = layout.src;
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
