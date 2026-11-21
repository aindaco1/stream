// Only refresh the figures. A filmmaker may be editing a price or watching a preview.
const overview = document.querySelector('[data-report="overview"]');
if (overview?.hasAttribute('data-pending-fees')) {
  const csrf = document.querySelector('input[name="csrf"]').value;
  let timer, busy = false, finished = false;
  function schedule(delay = 30000) {
    clearTimeout(timer);
    if (!document.hidden && !busy && !finished) timer = setTimeout(refresh, delay);
  }
  async function refresh() {
    if (document.hidden || busy || finished) return;
    busy = true;
    try {
      const response = await fetch(location.href, {headers:{'X-Stream-Analytics':csrf},
        credentials:'same-origin', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000)});
      if (response.status === 401) finished = true;
      if (!response.ok || response.headers.get('X-Stream-Analytics') !== '1') return;
      const update = new DOMParser().parseFromString(await response.text(), 'text/html');
      for (const fresh of update.querySelectorAll('[data-report]')) {
        const card = document.querySelector('[data-report="' + CSS.escape(fresh.dataset.report) + '"]');
        if (!card) continue;
        for (const entry of fresh.querySelectorAll('[data-stat]')) {
          const current = card.querySelector('[data-stat="' + CSS.escape(entry.dataset.stat) + '"]');
          if (!current) continue;
          const label = current.querySelector('dt');
          label.dataset.fieldHelp = entry.querySelector('dt').dataset.fieldHelp;
          const tip = document.getElementById(label.querySelector('button')?.getAttribute('aria-describedby'));
          if (tip) tip.textContent = label.dataset.fieldHelp;
          current.querySelector('dd').textContent = entry.querySelector('dd').textContent;
        }
        const oldNote = card.querySelector('.net-calculation'), newNote = fresh.querySelector('.net-calculation');
        if (oldNote) oldNote.remove();
        if (newNote) card.querySelector('details').append(newNote);
        card.toggleAttribute('data-pending-fees', fresh.hasAttribute('data-pending-fees'));
      }
      for (const row of update.querySelectorAll('[data-report-row]')) {
        const existing = document.querySelector('[data-report-row="' + CSS.escape(row.dataset.reportRow) + '"]');
        if (!existing || existing.cells.length !== row.cells.length) continue;
        for (let i = 1; i < row.cells.length; i++) existing.cells[i].textContent = row.cells[i].textContent;
      }
      finished = !overview.hasAttribute('data-pending-fees');
    } catch { /* Retry when the dashboard is visible and connected again. */ }
    finally { busy = false; schedule(); }
  }
  document.addEventListener('visibilitychange', () => schedule(0));
  schedule();
}
