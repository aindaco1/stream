// The URL carries display choices only. The public player reads current text from the film.
export const infoFields = [
  { name: 'synopsis', label: 'Synopsis', limit: 1200 },
  { name: 'credits', label: 'Credits', limit: 1000 },
  { name: 'message', label: 'Filmmaker message', limit: 280 }
];

export function selectedFields(value = '') {
  const names = value.split(',');
  return infoFields.filter(field => names.includes(field.name));
}

export function embedLayout(base, fields, populated, program = false) {
  const url = new URL(base);
  const selection = fields.map(field => field.name).join(',');
  if (selection) url.searchParams.set('show', selection);
  else if (program) url.searchParams.set('show', 'none');
  else url.searchParams.delete('show');
  const populatedCount = fields.filter(field => populated.includes(field.name)).length;
  return { src: url.href, height: (program ? 680 : 480) + populatedCount * 48, populatedCount };
}

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

export function iframeCode({ src, height }, title, responsive = true) {
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" width="640" height="${height}" ${responsive ? 'style="width:100%;border:0" ' : ''}loading="lazy" allow="autoplay; payment; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

export function renderFilmInfo(info, fields) {
  const visible = ['synopsis', 'message', 'credits'].filter(name =>
    info?.[name] && fields.some(field => field.name === name));
  if (!visible.length) return '';
  const paragraphs = visible.map(name =>
    `<p class="film-${name}">${escapeHtml(info[name])}</p>`);
  return '<section class="film-info" aria-label="About the film">' + paragraphs.join('') + '</section>';
}

export function renderProgramEntry(film, fields, posterUrl) {
  const role = film.role === 'opening' ? 'Opening · ' : film.role === 'closing' ? 'Closing · ' : '';
  const seconds = Math.round(film.duration);
  const runtime = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const still = posterUrl ? `<img class="program-still" src="${escapeHtml(posterUrl)}" width="160" height="90" loading="lazy" alt="">` : '';
  return `<div class="program-entry"><div class="program-entry-heading">
    <h3 class="program-row-title">${escapeHtml(film.title)}</h3><span class="program-runtime">${role}${runtime}</span>
    </div>${still}${renderFilmInfo(film.info, fields)}</div>`;
}
