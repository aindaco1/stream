const byId = id => document.getElementById(id);
const duration = seconds => {
  const minutes = Math.floor(seconds / 60);
  return minutes + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
};
function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const unit = bytes >= 1e9 ? 'GB' : 'MB';
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}).format(bytes / (unit === 'GB' ? 1e9 : 1e6)) + ' ' + unit;
}

export function attachProgram(initial, prefix, onNavigate, onDownload) {
  const lineup = byId('program-lineup'), list = lineup.querySelector('ol');
  // Keep the player and offer together when a wide embed puts the lineup beside them.
  const screening = document.createElement('div');
  screening.className = 'program-screening';
  while (lineup.previousElementSibling) screening.prepend(lineup.previousElementSibling);
  lineup.before(screening);
  const previous = byId('previous-title'), next = byId('next-title');
  const watching = byId('program-now'), summary = byId('program-summary');
  const zip = byId('download').querySelector('button');
  const fields = new URLSearchParams(location.search).get('show')?.split(',') ?? ['synopsis','credits','message'];
  let program = initial, current, access;
  const versionBase = () => prefix + '/v/' + encodeURIComponent(program.revision);
  const titleBase = id => versionBase() + '/title/' + encodeURIComponent(id);

  function render() {
    byId('film-title').textContent = program.title;
    document.title = program.title + ' · Stream';
    list.replaceChildren();
    const items = program.lineup;
    const films = items.filter(item => item.role === 'film').length;
    const total = items.reduce((value, item) => value + item.duration, 0);
    const bytes = items.every(item => item.size > 0) ? items.reduce((sum, item) => sum + item.size, 0) : 0;
    const size = fileSize(bytes);
    zip.textContent = 'Download program (.zip)' + (size ? ' · ' + size : '');
    summary.hidden = lineup.hidden = !items.length;
    summary.textContent = films + (films === 1 ? ' film' : ' films') + ' · ' + Math.ceil(total / 60) + ' min';
    for (const item of items) {
      const row = document.createElement('li');
      row.dataset.member = item.id;
      const meta = document.createElement('span');
      meta.className = 'program-runtime';
      const role = item.role === 'opening' ? 'Opening' : item.role === 'closing' ? 'Closing' : '';
      meta.textContent = (role ? role + ' · ' : '') + duration(item.duration);
      const title = document.createElement('span');
      title.className = 'program-row-title';
      title.textContent = item.title;
      const details = document.createElement('details');
      const header = document.createElement('summary');
      header.append(title, meta);
      const content = document.createElement('div');
      content.className = 'program-notes';
      if (item.thumbnail) {
        const poster = document.createElement('img');
        poster.loading = 'lazy';
        poster.alt = '';
        poster.src = titleBase(item.id) + '/thumbnail.jpg';
        poster.addEventListener('error', () => poster.remove(), {once:true});
        content.append(poster);
      }
      for (const field of ['synopsis','message','credits']) {
        if (!fields.includes(field) || !item.info?.[field]) continue;
        const para = document.createElement('p');
        para.className = 'film-' + field;
        para.textContent = item.info[field];
        content.append(para);
      }
      if (content.childElementCount) {
        details.append(header, content);
        row.append(details);
      } else {
        const heading = document.createElement('div');
        heading.className = 'program-row-heading';
        heading.append(title, meta);
        row.append(heading);
      }
      if (access) {
        const choose = document.createElement('button');
        choose.className = 'program-watch';
        choose.type = 'button';
        choose.textContent = 'Play';
        choose.setAttribute('aria-label', 'Play ' + item.title);
        choose.addEventListener('click', () => onNavigate(item.id, true));
        row.append(choose);
        if (access === 'buy') {
          const save = document.createElement('button');
          save.className = 'program-file';
          save.type = 'button';
          save.textContent = 'Download';
          save.setAttribute('aria-label', 'Download ' + item.title);
          save.addEventListener('click', () => onDownload(titleBase(item.id) + '/download', save));
          row.append(save);
        }
      }
      list.append(row);
    }
    activate(current?.id);
  }

  function activate(id) {
    const index = program.lineup.findIndex(item => item.id === id);
    current = program.lineup[index];
    for (const row of list.children) {
      const selected = Boolean(access && current?.id === row.dataset.member);
      if (selected) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    previous.hidden = next.hidden = !access;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= program.lineup.length - 1;
    watching.hidden = !(access && current);
    watching.textContent = watching.hidden ? '' : (index + 1) + ' of ' + program.lineup.length + ' · ' + current.title;
    document.querySelector('video').setAttribute('aria-label', access && current ? current.title : program.title);
  }

  function move(offset, play) {
    const index = program.lineup.indexOf(current);
    const item = program.lineup[index + offset];
    if (!access || !item || index < 0) return false;
    onNavigate(item.id, play);
    return true;
  }
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  byId('close-checkout').textContent = 'Back to program';
  render();
  return {
    activate,
    advance: () => move(1, true),
    get revision() { return program.revision; },
    get id() { return current?.id; },
    get titleBase() { return current && titleBase(current.id); },
    get versionBase() { return versionBase(); },
    unlock(purchased, memberId, kind) {
      program = purchased;
      access = kind;
      current = program.lineup.find(item => item.id === memberId) || program.lineup[0];
      render();
    },
    lock() {
      program = initial;
      current = access = undefined;
      render();
    }
  };
}
