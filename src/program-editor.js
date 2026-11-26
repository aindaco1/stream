import { escapeHtml as esc, infoFields, renderProgramEntry } from './film-embed.js';
import { formatDuration, hidden, priceFields, programOfferSummary } from './offer-fields.js';
import { maxPreviewSeconds } from './prices.js';
import { thumbnailEditor } from './thumbnail-view.js';

export const programRights = 'I own these videos or have permission to offer the entire lineup for the rental and purchase options I selected.';

export function submittedLineup(data) {
  const films = Object.keys(data).filter(key => key.startsWith('main-') && data[key] === 'yes')
    .map(key => ({ filmId: key.slice(5), role: 'film' }));
  function extra(role) {
    if (!data[role] || data.action === 'remove-' + role) return [];
    const title = data[role + 'TitleFor'] === data[role] && data[role + 'Title'];
    return [{filmId:data[role], role, ...(title && {title})}];
  }
  return [...extra('opening'), ...films, ...extra('closing')];
}

function options(films, selected, empty) {
  return '<option value="" data-preview-max="' + maxPreviewSeconds() + '">' + empty + '</option>' + films.map(film =>
    `<option value="${esc(film.id)}" data-duration="${esc(film.duration)}" data-preview-max="${maxPreviewSeconds(film.duration)}"${selected === film.id ? ' selected' : ''}>${esc(film.title)}</option>`).join('');
}

export function renderProgramEditor(program, films, csrf, error, notice) {
  const byId = new Map(films.map(film => [film.id, film]));
  const ordered = program.members.filter(item => item.role === 'film').map(item => byId.get(item.filmId)).filter(Boolean);
  const selected = new Set(ordered.map(film => film.id));
  const previewSource = byId.get(program.previewFilmId) ?? ordered[0];
  const duration = program.members.reduce((sum, item) => sum + (byId.get(item.filmId)?.duration || 0), 0);
  const extras = new Set(program.members.filter(item => item.role !== 'film').map(item => item.filmId));
  function extraSlot(role, title) {
    const member = program.members.find(item => item.role === role);
    const film = byId.get(member?.filmId);
    return `<div class="program-extra" data-slot="${role}"><div class="extra-picker"><label for="program-${role}">${title} video</label>
      <select id="program-${role}" name="${role}">${options(films, film?.id, 'None')}</select></div>
      <div class="extra-title"${film ? '' : ' hidden'}><label>${title} title in this program<input name="${role}Title" type="text" maxlength="160" placeholder="${esc(film?.title)}" value="${esc(member?.title || film?.title)}"></label>
        ${hidden(role + 'TitleFor',film?.id)}</div>
      <div class="film-actions"><button class="secondary" name="action" value="upload-${role}">${film ? 'Replace ' + role + ' video' : 'Add a new ' + role + ' video'}</button>
      <button class="secondary" name="action" value="remove-${role}"${film ? '' : ' hidden'}>Remove ${role}</button>${film ? '<a href="/setup/subtitles/'+esc(film.id)+'">Manage '+role+' subtitles</a>' : ''}</div></div>`;
  }
  function filmRow(film) {
    const checked = selected.has(film.id);
    return `<li data-id="${esc(film.id)}" data-duration="${esc(film.duration)}" data-preview-max="${maxPreviewSeconds(film.duration)}"${extras.has(film.id) ? ' hidden' : ''}>
      <label><input type="checkbox" name="main-${esc(film.id)}" value="yes"${checked ? ' checked' : ''}><span>${esc(film.title)}</span></label>
      <small>${formatDuration(film.duration)}</small>
      <div class="lineup-moves" hidden>
        <button type="button" class="secondary" data-move="-1" aria-label="Move ${esc(film.title)} up">↑</button>
        <button type="button" class="secondary" data-move="1" aria-label="Move ${esc(film.title)} down">↓</button>
        <span aria-hidden="true" class="drag-handle" title="Drag to reorder">⠿</span>
      </div></li>`;
  }
  const available = films.filter(film => !film.programId && !selected.has(film.id));
  const id = esc(program.id);
  return `<div class="workspace-intro"><a href="/setup/dashboard#${id}">Back to Dashboard</a>
    <h1>${esc(program.title || 'Create program')}</h1>
    ${program.published ? '<p class="hint">Save draft keeps your edits private. Choose Publish changes to update prices and playback in every embed.</p>' : ''}</div>
    ${error ? `<p class="feedback error" role="alert">${esc(error)}</p>` : notice ? `<p class="feedback" role="status">${esc(notice)}</p>` : ''}
    <form method="post" action="/setup/program/${id}" class="film-card program-editor">
      ${hidden('csrf', csrf)}${hidden('version', program.version)}
      <label>Program title<input name="title" maxlength="160" value="${esc(program.title)}"></label>
      <label>Curated by <small>(optional)</small><input name="curator" maxlength="160" value="${esc(program.curator)}" placeholder="Curator’s name or names"></label>
      <fieldset class="program-lineup"><legend>Screening order</legend><div class="field-stack">
        ${extraSlot('opening', 'Opening')}
        <div data-slot="films"><strong>Films</strong>
          <ol class="program-library" aria-label="Films in screening order">${ordered.map(filmRow).join('')}</ol>
          <p class="hint" data-empty-order${ordered.length ? ' hidden' : ''}>Choose at least two films below.</p>
        </div>
        ${extraSlot('closing', 'Closing')}
        <p class="hint" data-runtime aria-live="polite">${ordered.length} films · ${formatDuration(duration) || '0 min'} total</p>
      </div></fieldset>
      <fieldset class="program-choices"${films.length && available.every(film => extras.has(film.id)) ? ' hidden' : ''}><legend>Films to add</legend>
        ${films.length ? `<ul class="program-library" aria-label="Available films">${available.map(filmRow).join('')}</ul>` : '<p>Your library is empty. Add films from the Dashboard to build your lineup.</p>'}
      </fieldset>
      <label>Preview video<select name="previewFilmId">${options(films, program.previewFilmId, 'First film in the lineup')}</select></label>
      ${priceFields({ ...program, duration:previewSource?.duration }, true)}
      <label class="rights-choice"><input type="checkbox" name="rightsAccepted" value="yes"${program.rights ? ' checked' : ''}><span>${esc(programRights)}</span></label>
      <div class="film-actions"><button class="secondary" name="action" value="save">Save draft</button>
        <button class="secondary" name="action" value="preview">Save and preview</button>
        <button name="action" value="publish">${program.published ? 'Publish changes' : 'Publish program'}</button></div>
    </form>
    ${program.bucket ? `<div class="film-card">${thumbnailEditor({ ...program, uploads: program.bucket.uploads }, csrf, 'h2')}
      <p class="hint">The first film’s thumbnail appears until you add a program image.</p></div>` :
      '<p><a href="/setup/settings#storage">Connect storage</a> to upload a program thumbnail.</p>'}`;
}

export function renderPrivateProgram(program, films, path, tracks = '') {
  const byId = new Map(films.map(film => [film.id, film]));
  const first = program.members.find(item => item.role === 'film');
  const posterId = program.thumbnail ? program.id : byId.get(first?.filmId)?.thumbnail ? first.filmId : '';
  const poster = posterId ? `/setup/thumbnail/${esc(posterId)}/poster.jpg` : '';
  const video = program.previewSeconds ? `<video controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ''} src="${esc(path)}/clip.mp4">${tracks}</video>` :
    (poster ? `<img class="program-poster" src="${poster}" alt="Program thumbnail">` : '');
  const items = program.members.map(item => {
    const film = byId.get(item.filmId);
    if (!film) return '';
    const posterUrl = film.thumbnail ? `/setup/thumbnail/${encodeURIComponent(film.id)}/poster.jpg` : '';
    return `<li>${renderProgramEntry({...film, title:item.title || film.title, role:item.role}, infoFields, posterUrl)}</li>`;
  }).join('');
  return `<p class="account">Private program preview</p><div class="private-screening">
    <div class="private-player">${program.curator ? `<p>Curated by ${esc(program.curator)}</p>` : ''}${video}<p>${esc(programOfferSummary(program))}</p></div>
    <section><h2>In this program</h2><ol class="program-list private-lineup" role="list">${items}</ol></section></div>
    <a href="/setup/program/${esc(program.id)}">Back to program</a>`;
}
