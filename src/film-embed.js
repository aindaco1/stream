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

export function embedLayout(base, fields, populated) {
  const url = new URL(base);
  const selection = fields.map(field => field.name).join(',');
  if (selection) url.searchParams.set('show', selection);
  else url.searchParams.delete('show');
  return { src: url.href, height: 480 + fields.filter(field => populated.includes(field.name)).length * 48 };
}

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

export function iframeCode({ src, height }, title, responsive = true) {
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" width="640" height="${height}" ${responsive ? 'style="width:100%;border:0" ' : ''}loading="lazy" allow="autoplay; payment; fullscreen" allowfullscreen></iframe>`;
}

export function renderFilmInfo(info, fields) {
  const rows = fields.filter(({ name }) => info?.[name]).map(({ name, label }) =>
    `<div><dt>${label}</dt><dd>${escapeHtml(info[name])}</dd></div>`);
  return rows.length ? '<dl class="film-info">' + rows.join('') + '</dl>' : '';
}
