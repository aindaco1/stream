import { escapeHtml, filmByline, renderFilmInfo, selectedFields } from './film-embed.js';
import { formatDuration } from './offer-fields.js';
import { siteIcons } from './site-frame.js';

export function renderPlayer(template, { published, style, fields, program, posterUrl, previewSeconds, payable, checkout, recovery, mode, example = false }) {
  const title = escapeHtml(published?.title || 'Private screening');
  const heading = `<h1 id="film-title">${title}</h1>`;
  const byline = program ? '' : filmByline(published?.info, fields);
  const runtime = program ? '<p id="program-summary" hidden></p>' : `<span>${escapeHtml(formatDuration(published?.duration))}</span>`;
  const description = published?.info?.synopsis && fields.some(field => field.name === 'synopsis')
    ? published.info.synopsis : published ? `Watch ${published.title} in the filmmaker’s Stream player.` : 'Private screening.';
  const values = {
    siteIcons, paymentMode: mode, playerScript: example ? '/play-excerpt.js' : '/app.js',
    title, description: escapeHtml(description), style, poster: posterUrl ? ` poster="${escapeHtml(posterUrl)}"` : '',
    exampleOffers: example ? '<button type="button" id="example-offers" class="secondary" disabled>See rental and download options</button>' : '',
    previewSource: example ? ' src="/market-street-excerpt.mp4"' : '',
    masthead: `<header class="poster-head"><div class="poster-imprint"><span id="poster-byline"${byline ? '' : ' hidden'}>${escapeHtml(byline)}</span>${runtime}</div>${style === 'broadside' ? heading : ''}</header>`,
    detailsTitle: style === 'marquee' ? heading : '', filmInfo: renderFilmInfo(published?.info, fields),
    programStyles: program ? '<link rel="stylesheet" href="/program-lineup.css">' : '',
    program: program ? escapeHtml(JSON.stringify(program)) : '',
    checkout: String(payable), salesTerritory: escapeHtml(checkout?.salesTerritory ?? ''),
    manualNm: String(payable && checkout?.manualNmEnabled === true), preview: published ? previewSeconds ?? 10 : 0,
    emailRecovery: String(Boolean(recovery && payable)), published: String(Boolean(published)),
    rent: published?.prices?.rent ?? '', buy: published?.prices?.buy ?? '', rentalHours: published?.rentalHours ?? 48
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
}

export const examplePath = '/example/market-street';
export const exampleHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'SAMEORIGIN'
};

export function examplePlayer(template) {
  const film = {
    title: 'A Trip Down Market Street', duration: 503, prices: {rent: 500, buy: 1000}, rentalHours: 48,
    info: { byline: 'the Miles Brothers', synopsis: 'A cable car threads its way through San Francisco traffic in 1906, days before the earthquake.',
      credits: [{role: 'Filmed by', name: 'Miles Brothers'}, {role: 'Archival print', name: 'Library of Congress'}] }
  };
  return renderPlayer(template, { published: film, fields: selectedFields('byline,synopsis,credits'), style: 'broadside',
    posterUrl: '/market-street-still.webp', previewSeconds: 10, mode: 'example', payable: false, example: true });
}
