// Native selects can match :focus-visible after a mouse or touch selection.
// Keep native focus so Tab continues from the selected control.
let pointerSelect;

function restoreFocusRing() {
  if (!pointerSelect) return;
  delete pointerSelect.dataset.pointerFocus;
  pointerSelect = null;
}

document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Element)) return;
  const select = event.target.closest('select') ?? event.target.closest('label')?.control;
  if (!(select instanceof HTMLSelectElement) || select === pointerSelect) return;
  restoreFocusRing();
  select.dataset.pointerFocus = '';
  pointerSelect = select;
}, true);

document.addEventListener('keydown', restoreFocusRing, true);
document.addEventListener('focusout', event => {
  if (event.target === pointerSelect) restoreFocusRing();
}, true);
