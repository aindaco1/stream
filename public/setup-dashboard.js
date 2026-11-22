import { creditProblem, embedLayout, iframeCode, posterFrameStyle, selectedFields } from './film-embed.js';

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

for (const editor of document.querySelectorAll('.credit-editor')) {
  const list = editor.querySelector('.credit-rows');
  const add = editor.querySelector('.add-credit');
  // The server leaves an empty row for editing without JavaScript.
  const blank = list.lastElementChild.cloneNode(true);
  if (list.children.length > 1) list.lastElementChild.remove();
  const roleOf = row => row.querySelector('[name=creditRole]');
  const nameOf = row => row.querySelector('[name=creditName]');

  function updateRows() {
    const rows = [...list.children];
    const entries = rows.map(row => ({role:roleOf(row).value.trim(), name:nameOf(row).value.trim()}));
    const problem = creditProblem(entries.filter(entry => entry.name || entry.role), Number(editor.dataset.limit));
    for (const [index, row] of rows.entries()) {
      row.querySelector('.credit-actions').hidden = false;
      row.querySelector('[data-credit-action=up]').disabled = index === 0;
      row.querySelector('[data-credit-action=down]').disabled = index === rows.length - 1;
      const name = nameOf(row);
      name.required = Boolean(entries[index].role);
      name.setCustomValidity('');
    }
    const incomplete = rows.find((row, i) => entries[i].role && !entries[i].name);
    nameOf(incomplete || rows[rows.length - 1]).setCustomValidity(problem);
  }

  add.hidden = false;
  add.addEventListener('click', () => {
    const row = blank.cloneNode(true);
    list.append(row);
    updateRows();
    roleOf(row).focus();
  });
  list.addEventListener('input', updateRows);
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-credit-action]');
    if (!button) return;
    const row = button.closest('.credit-row');
    const action = button.dataset.creditAction;
    let focusRow = row;
    if (action === 'up') row.previousElementSibling.before(row);
    if (action === 'down') row.nextElementSibling.after(row);
    if (action === 'remove') {
      focusRow = row.nextElementSibling || row.previousElementSibling || blank.cloneNode(true);
      if (list.children.length === 1) list.append(focusRow);
      row.remove();
    }
    updateRows();
    roleOf(focusRow).focus();
  });
  updateRows();
}
