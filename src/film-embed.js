// The URL carries display choices only. The public player reads current text from the film.
export const infoFields = [
  { name: 'synopsis', label: 'Synopsis', limit: 1200 },
  { name: 'byline', label: 'A film by', limit: 160 },
  { name: 'credits', label: 'Credits', limit: 1000 },
  { name: 'message', label: 'Filmmaker message', limit: 280 }
];

export const posterStyles = new Map([['broadside', 'Festival Broadside'], ['marquee', 'Midnight Marquee']]);
export const posterChoice = value => posterStyles.has(value) ? value : 'broadside';

export function selectedFields(value = '') {
  const names = value.split(',');
  return infoFields.filter(field => names.includes(field.name));
}

export function embedLayout(base, fields, populated, program = false, style, lineupSize = 0) {
  const url = new URL(base);
  url.searchParams.set('poster', posterChoice(style));
  const selection = fields.map(field => field.name).join(',');
  if (selection) url.searchParams.set('show', selection);
  else if (program) url.searchParams.set('show', 'none');
  else url.searchParams.delete('show');
  const populatedCount = fields.filter(field => populated.includes(field.name)).length;
  const height = 610 + populatedCount * 48 + (program ? 60 + lineupSize * 96 : 0);
  return { src: url.href, height };
}

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

export function posterFrameStyle(height) {
  return `width:100%;max-width:640px;height:auto;aspect-ratio:640/${height};min-height:${height - 180}px;max-height:${height}px;border:0`;
}

export function iframeCode({ src, height }, title, responsive = true) {
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" width="640" height="${height}" ${responsive ? `style="${posterFrameStyle(height)}" ` : ''}loading="lazy" allow="autoplay; payment; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

// Recognize explicit role labels in older free-form credits. Keep unfamiliar
// wording in one piece so it can be edited without losing any part of a name.
const legacyCredit = /^((?:dir\.|directed|written(?: and directed)?|produced|edited|music|sound|cinematography|photography) by|[^:]+:)\s+(.+)$/iu;
export function creditEntries(credits) {
  if (Array.isArray(credits)) return credits;
  return (credits || '').split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean)
    .map(line => {
      const match = legacyCredit.exec(line);
      return match ? {role:match[1], name:match[2]} : {role:'', name:line};
    });
}

export function creditText(entries) {
  return entries.map(({role, name}) => role ? role + ' ' + name : name).join(' ');
}

export function creditProblem(entries, limit) {
  if (entries.some(({role, name}) => /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(role + name)))
    return 'Enter each credit as plain text on one line.';
  if (entries.some(({role, name}) => role && !name))
    return 'Add a name or credit beside each role.';
  return creditText(entries).length > limit ? `Use up to ${limit} characters across all credits.` : '';
}

function renderCredits(credits) {
  const items = creditEntries(credits).map(({role, name}) => {
    const label = role ? `<span class="credit-role">${escapeHtml(role)}</span> ` : '';
    return `<span class="credit">${label}<span class="credit-name">${escapeHtml(name)}</span></span>`;
  });
  return items.length ? `<p class="film-credits">${items.join(' ')}</p>` : '';
}

export function renderFilmInfo(info, fields) {
  const visible = ['synopsis', 'message', 'credits'].filter(name =>
    info?.[name] && fields.some(field => field.name === name));
  if (!visible.length) return '';
  const paragraphs = visible.map(name => name === 'credits' ? renderCredits(info.creditEntries ?? info.credits) :
    `<p class="film-${name}">${escapeHtml(info[name])}</p>`);
  return '<div class="film-info">' + paragraphs.join('') + '</div>';
}

export function filmByline(info, fields) {
  return fields.some(field => field.name === 'byline') && info?.byline ? 'A film by ' + info.byline : '';
}

export function renderProgramEntry(film, fields, posterUrl) {
  const role = film.role === 'opening' ? 'Opening · ' : film.role === 'closing' ? 'Closing · ' : '';
  const seconds = Math.round(film.duration);
  const runtime = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const byline = filmByline(film.info, fields);
  const still = posterUrl ? `<img class="program-still" src="${escapeHtml(posterUrl)}" width="160" height="90" loading="lazy" alt="">` : '';
  return `<div class="program-entry"><div class="program-entry-heading">
    <h3 class="program-row-title">${escapeHtml(film.title)}</h3>${byline ? `<p class="member-byline">${escapeHtml(byline)}</p>` : ''}<span class="program-runtime">${role}${runtime}</span>
    </div>${still}${renderFilmInfo(film.info, fields)}</div>`;
}
