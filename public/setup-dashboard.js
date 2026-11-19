document.addEventListener('click', async event => {
  const button = event.target.closest('.copy-embed');
  if (!button) return;
  const card = button.closest('.dashboard-film');
  const field = card.querySelector('textarea');
  const status = card.querySelector('.copy-status');
  try {
    await navigator.clipboard.writeText(field.value);
    status.textContent = 'Embed code copied.';
  } catch {
    field.focus();
    field.select();
    status.textContent = 'Copy the selected embed code.';
  }
});
