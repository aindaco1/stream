const form = document.querySelector('.program-editor');

if (form) {
  const library = form.querySelector('[data-slot=films] ol');
  const choices = form.querySelector('.program-choices');
  const available = choices.querySelector('ul');
  const rows = () => [...form.querySelectorAll('.program-library li')];
  const checkbox = row => row.querySelector('input');
  const chosen = () => [...library.children];
  const { opening, closing, previewFilmId, rightsAccepted } = form.elements;
  const runtime = form.querySelector('[data-runtime]');
  const previewSeconds = form.elements.previewSeconds;
  let editedPreview = false;
  previewSeconds.addEventListener('input', () => { editedPreview = true; });
  function refresh() {
    const lineup = chosen();
    const selected = new Set(lineup.map(row => row.dataset.id));
    const extras = new Set([opening.value, closing.value].filter(Boolean));
    for (const row of rows()) {
      const input = checkbox(row);
      row.hidden = input.disabled = extras.has(row.dataset.id);
      const controls = row.querySelector('.lineup-moves');
      controls.hidden = !input.checked;
      row.draggable = input.checked;
      const [before, after] = controls.querySelectorAll('button');
      before.disabled = row === lineup[0];
      after.disabled = row === lineup.at(-1);
    }
    form.querySelector('[data-empty-order]').hidden = Boolean(lineup.length);
    choices.hidden = Boolean(available && !available.querySelector('li:not([hidden])'));
    for (const [menu, other] of [[opening, closing], [closing, opening]]) {
      const role = menu.name, slot = menu.closest('[data-slot]');
      const input = form.elements[role + 'Title'], titleFor = form.elements[role + 'TitleFor'];
      input.placeholder = menu.value ? menu.selectedOptions[0].textContent : '';
      if (titleFor.value !== menu.value) { input.value = input.placeholder; titleFor.value = menu.value; }
      input.closest('.extra-title').hidden = !menu.value;
      slot.querySelector('[value="remove-' + role + '"]').hidden = !menu.value;
      slot.querySelector('[value="upload-' + role + '"]').textContent = menu.value ? 'Replace ' + role + ' video' : 'Add a new ' + role + ' video';
      for (const option of menu.options) option.disabled = Boolean(option.value && (selected.has(option.value) || option.value === other.value));
    }
    for (const option of previewFilmId.options) {
      option.hidden = option.disabled = Boolean(option.value && !selected.has(option.value) && !extras.has(option.value));
    }
    if (previewFilmId.selectedOptions[0]?.disabled) previewFilmId.value = '';
    const source = previewFilmId.value ? previewFilmId.selectedOptions[0] : lineup[0];
    const max = source ? Math.min(30, Math.max(0, Math.ceil(Number(source.dataset.duration)) - 1)) : 30;
    previewSeconds.max = String(max);
    if (!editedPreview && Number(previewSeconds.value) > max) previewSeconds.value = String(max);
    const seconds = Math.round([...lineup, opening.selectedOptions[0], closing.selectedOptions[0]]
      .reduce((sum, item) => sum + Number(item?.dataset.duration || 0), 0));
    runtime.textContent = lineup.length + (lineup.length === 1 ? ' film' : ' films') + ' · ' +
      Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' sec total';
  }
  function changeLineup() {
    rightsAccepted.checked = false;
    refresh();
  }
  form.addEventListener('change', event => {
    const row = event.target.closest('.program-library li');
    if (!row) return;
    (checkbox(row).checked ? library : available).append(row);
    changeLineup();
    checkbox(row).focus();
  });
  library?.addEventListener('click', event => {
    const button = event.target.closest('[data-move]');
    if (!button) return;
    const row = button.closest('li');
    const lineup = chosen();
    const neighbor = lineup[lineup.indexOf(row) + Number(button.dataset.move)];
    if (!neighbor) return;
    library.insertBefore(row, button.dataset.move === '-1' ? neighbor : neighbor.nextSibling);
    refresh();
    checkbox(row).focus();
  });
  let dragged;
  library?.addEventListener('dragstart', event => {
    dragged = event.target.closest('li[draggable="true"]');
    if (dragged) event.dataTransfer.setData('text/plain', dragged.dataset.id);
  });
  library?.addEventListener('dragover', event => { if (dragged) event.preventDefault(); });
  library?.addEventListener('drop', event => {
    event.preventDefault();
    const neighbor = event.target.closest('li[draggable="true"]');
    if (dragged && neighbor && dragged !== neighbor) {
      const bounds = neighbor.getBoundingClientRect();
      library.insertBefore(dragged, event.clientY < bounds.top + bounds.height / 2 ? neighbor : neighbor.nextSibling);
      refresh();
    }
    dragged = null;
  });
  library?.addEventListener('dragend', () => { dragged = null; });
  previewFilmId.addEventListener('change', refresh);
  for (const menu of [opening, closing]) menu.addEventListener('change', changeLineup);
  refresh();
}
