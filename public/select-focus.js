// Native menus and TV pickers can return keyboard-style focus after a click.
// Keep the native focus and tab order when the picker closes.
let pointerControl;

function restoreFocusRing() {
  if (!pointerControl) return;
  delete pointerControl.dataset.pointerFocus;
  pointerControl = null;
}

document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Element)) return;
  const control = event.target.closest('select, button.video-tool') ?? event.target.closest('label')?.control;
  if (control === pointerControl) return;
  restoreFocusRing();
  if (control?.matches('select, button.video-tool')) {
    control.dataset.pointerFocus = '';
    pointerControl = control;
  }
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') restoreFocusRing();
}, true);
document.addEventListener('focusin', event => {
  if (event.target !== pointerControl) restoreFocusRing();
}, true);
