import { infoFields, renderProgramEntry, selectedFields } from './film-embed.js';

const byId = id => document.getElementById(id);
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
  const show = new URLSearchParams(location.search).get('show');
  const fields = show === null ? infoFields : selectedFields(show);
  let program = initial, current, access;
  const versionBase = () => prefix + '/v/' + encodeURIComponent(program.revision);
  const titleBase = id => versionBase() + '/title/' + encodeURIComponent(id);

  function render() {
    byId('film-title').textContent = program.title;
    const byline = byId('poster-byline');
    if (byline) {
      byline.textContent = program.curator && fields.some(field => field.name === 'byline') ? 'Curated by ' + program.curator : '';
      byline.hidden = !byline.textContent;
    }
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
      const posterUrl = item.thumbnail ? titleBase(item.id) + '/thumbnail.jpg' : '';
      row.innerHTML = renderProgramEntry(item, fields, posterUrl);
      const still = row.querySelector('img');
      still?.addEventListener('error', () => still.remove(), {once:true});
      if (access) {
        const choose = document.createElement('button');
        choose.className = 'program-watch';
        choose.type = 'button';
        choose.textContent = 'Play';
        choose.setAttribute('aria-label', 'Play ' + item.title);
        choose.addEventListener('click', () => onNavigate(item.id, true));
        const actions = document.createElement('div');
        actions.className = 'program-actions';
        actions.append(choose);
        row.append(actions);
        if (access === 'buy') {
          const save = document.createElement('button');
          save.className = 'program-file';
          save.type = 'button';
          save.textContent = 'Download';
          save.setAttribute('aria-label', 'Download ' + item.title);
          save.addEventListener('click', () => onDownload(titleBase(item.id) + '/download', save));
          actions.append(save);
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
