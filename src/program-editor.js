import { escapeHtml as esc, infoFields, renderFilmInfo } from './film-embed.js';
import { formatDuration, hidden, priceFields } from './offer-fields.js';
import { thumbnailEditor } from './thumbnail-view.js';

export const programRights = 'I own these videos or have permission to offer the entire lineup for the rental and purchase options I selected.';

export function submittedLineup(data) {
  const films = Object.keys(data).filter(key => key.startsWith('main-') && data[key] === 'yes')
    .map(key => ({ filmId: key.slice(5), role: 'film' }));
  return [...(data.opening ? [{ filmId: data.opening, role: 'opening' }] : []), ...films,
    ...(data.closing ? [{ filmId: data.closing, role: 'closing' }] : [])];
}

function options(films, selected, empty) {
  return '<option value="">' + empty + '</option>' + films.map(film =>
    `<option value="${esc(film.id)}"${selected === film.id ? ' selected' : ''}>${esc(film.title)}</option>`).join('');
}

export function renderProgramEditor(program, films, csrf, error, notice) {
  const byId = new Map(films.map(film => [film.id, film]));
  const ordered = program.members.filter(item => item.role === 'film').map(item => byId.get(item.filmId)).filter(Boolean);
  const selected = new Set(ordered.map(film => film.id));
  const duration = program.members.reduce((sum, item) => sum + (byId.get(item.filmId)?.duration || 0), 0);
  const extras = ['opening','closing'].map(role => {
    const title = role === 'opening' ? 'Opening' : 'Closing';
    return `<div class="program-extra"><label>${title} video <select name="${role}">${options(films, program.members.find(item => item.role === role)?.filmId, 'None')}</select></label>
      <button class="secondary" name="action" value="upload-${role}">Add a new ${role} video</button></div>`;
  }).join('');
  const rows = [...ordered, ...films.filter(film => !selected.has(film.id))].map(film => {
    const checked = selected.has(film.id);
    return `<li data-id="${esc(film.id)}" data-duration="${esc(film.duration)}">
      <label><input type="checkbox" name="main-${esc(film.id)}" value="yes"${checked ? ' checked' : ''}><span>${esc(film.title)}</span></label>
      <small>${formatDuration(film.duration)}</small>
      <div class="lineup-moves" hidden>
        <button type="button" class="secondary" data-move="-1" aria-label="Move ${esc(film.title)} up">↑</button>
        <button type="button" class="secondary" data-move="1" aria-label="Move ${esc(film.title)} down">↓</button>
        <span aria-hidden="true" class="drag-handle" title="Drag to reorder">⠿</span>
      </div></li>`;
  }).join('');
  const id = esc(program.id);
  return `<div class="workspace-intro"><a href="/setup/dashboard#${id}">Back to Dashboard</a>
    <h1>${esc(program.title || 'Create program')}</h1>
    ${program.published ? '<p class="hint">Save a draft while the current program stays on sale. Choose Publish changes when the new lineup is ready for future viewers.</p>' : ''}</div>
    ${error ? `<p class="feedback error" role="alert">${esc(error)}</p>` : notice ? `<p class="feedback" role="status">${esc(notice)}</p>` : ''}
    <form method="post" action="/setup/program/${id}" class="film-card program-editor">
      ${hidden('csrf', csrf)}${hidden('version', program.version)}
      <label>Program title<input name="title" maxlength="160" value="${esc(program.title)}"></label>
      <fieldset class="program-lineup"><legend>Screening order</legend><div class="field-stack">
        <p class="hint">Choose at least two films. Move your selections into screening order.</p>
        ${rows ? `<ul class="program-library">${rows}</ul>` : '<p>Your library is empty. Add films from the Dashboard to build your lineup.</p>'}
        <p class="hint" data-runtime aria-live="polite">${ordered.length} films · ${formatDuration(duration) || '0 min'}</p>
      </div></fieldset>
      <fieldset><legend>Opening and closing videos</legend><div class="program-extras">${extras}</div></fieldset>
      <label>Preview video<select name="previewFilmId">${options(films, program.previewFilmId, 'First film in the lineup')}</select></label>
      ${priceFields(program, true)}
      <label class="rights-choice"><input type="checkbox" name="rightsAccepted" value="yes"${program.rights ? ' checked' : ''}><span>${esc(programRights)}</span></label>
      <div class="film-actions"><button name="action" value="save">Save draft</button>
        <button class="secondary" name="action" value="preview">Save and preview</button>
        <button class="secondary" name="action" value="publish">${program.published ? 'Publish changes' : 'Publish program'}</button></div>
    </form>
    ${program.bucket ? `<div class="film-card">${thumbnailEditor({ ...program, uploads: program.bucket.uploads }, csrf)}
      <p class="hint">The first film’s thumbnail appears until you add a program image.</p></div>` :
      '<p><a href="/setup/settings#storage">Connect storage</a> to upload a program thumbnail.</p>'}`;
}

export function renderPrivateProgram(program, films, path) {
  const byId = new Map(films.map(film => [film.id, film]));
  const first = program.members.find(item => item.role === 'film');
  const posterId = program.thumbnail ? program.id : byId.get(first?.filmId)?.thumbnail ? first.filmId : '';
  const poster = posterId ? `/setup/thumbnail/${esc(posterId)}/poster.jpg` : '';
  const video = program.previewSeconds ? `<video controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ''} src="${esc(path)}/clip.mp4"></video>` :
    (poster ? `<img class="program-poster" src="${poster}" alt="Program thumbnail">` : '');
  const offers = [['rent','Rent'],['buy','Buy']].filter(([key]) => Number.isInteger(program.prices[key])).map(([key, label]) =>
    `${label} $${(program.prices[key] / 100).toFixed(2)}${key === 'rent' ? ` · ${program.rentalHours} hours` : ' · includes ZIP'}`);
  const items = program.members.map(item => {
    const film = byId.get(item.filmId);
    if (!film) return '';
    const role = item.role === 'opening' ? 'Opening · ' : item.role === 'closing' ? 'Closing · ' : '';
    return `<li><details><summary>${role}${esc(film.title)} · ${formatDuration(film.duration)}</summary>
      ${renderFilmInfo(film.info, infoFields)}</details></li>`;
  }).join('');
  return `<p class="account">Private program preview</p>${video}<p>${esc(offers.join(' / '))}</p>
    <ol class="private-lineup">${items}</ol><a href="/setup/program/${esc(program.id)}">Back to program</a>`;
}
