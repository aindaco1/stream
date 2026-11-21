import { embedLayout, iframeCode, posterFrameStyle, selectedFields } from './film-embed.js';

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
  const program = builder.hasAttribute('data-program');
  function update() {
    const data = new FormData(form);
    const selection = data.getAll('include').join(',');
    const fields = selectedFields(selection);
    const style = data.get('poster');
    const layoutFor = source => embedLayout(source, fields, populated, program, style, Number(builder.dataset.lineupSize));
    const layout = layoutFor(builder.dataset.player);
    const preview = layoutFor(builder.dataset.preview);
    if (frame.src !== preview.src) frame.src = preview.src;
    frame.height = layout.height;
    frame.style.cssText = posterFrameStyle(layout.height);
    code.value = iframeCode(layout, frame.title);
    builder.querySelector('.public-player').href = layout.src;
    if (!program) {
      const editor = card.querySelector('.film-info-editor');
      editor.elements.show.value = selection;
      editor.elements.poster.value = style;
    }
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
