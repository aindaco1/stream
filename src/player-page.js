import { escapeHtml, filmByline, renderFilmInfo, selectedFields } from './film-embed.js';
import { formatDuration } from './offer-fields.js';
import { exampleTitle, examplePrices } from './example-checkout.js';
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
    downloadControl: example ? '<a id="example-download" href="/example/market-street/film.mp4" download="A Trip Down Market Street.mp4">Download the film (MP4, 18.4 MB)</a>'
      : '<form id="download" method="post"><input type="hidden" name="receipt"><button>Download film</button></form>',
    exampleOffers: example ? '<button type="button" id="example-offers" class="secondary" disabled>See rental and download options</button>' : '',
    previewSource: example ? ' src="/market-street-excerpt.mp4"' : '',
    masthead: `<header class="poster-head"><div class="poster-imprint"><span id="poster-byline"${byline ? '' : ' hidden'}>${escapeHtml(byline)}</span>${runtime}</div>${style === 'broadside' ? heading : ''}</header>`,
    detailsTitle: style === 'marquee' ? heading : '', filmInfo: renderFilmInfo(published?.info, fields),
    programStyles: program ? '<link rel="stylesheet" href="/program-lineup.css">' : '',
    program: program ? escapeHtml(JSON.stringify(program)) : '',
    checkout: String(payable), salesTerritory: escapeHtml(checkout?.salesTerritory ?? ''),
    manualNm: String(payable && checkout?.manualNmEnabled === true), preview: published ? previewSeconds ?? 10 : 0,
    emailRecovery: String(Boolean(recovery && payable)), published: String(Boolean(published)),
    couponField: payable && !example ? '<details id="coupon-choice"><summary>Have a coupon?</summary><label>Coupon code<input id="coupon-code" type="text" maxlength="40" autocapitalize="characters" autocomplete="off" spellcheck="false"></label></details>' : '',
    watermarkNotice: published?.screenerWatermark && published.prices?.rent ? '<p>This rental briefly displays a code linked to your order.</p>' : '',
    rent: published?.prices?.rent ?? '', buy: published?.prices?.buy ?? '', rentalHours: published?.rentalHours ?? 48
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
}

function paymentHeaders(ancestors) {
  return {
    'Referrer-Policy': 'strict-origin',
    'Content-Security-Policy': [
      "default-src 'none'", "script-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com",
      "style-src 'self'", "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://link.com https://*.link.com",
      "frame-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com https://link.com https://*.link.com",
      "img-src 'self' data: https://*.stripe.com https://*.link.com", "media-src 'self' blob:", "worker-src 'none'",
      'frame-ancestors ' + ancestors, "base-uri 'none'", "form-action 'self'"
    ].join('; ')
  };
}

export const stripePlayerHeaders = paymentHeaders('*');
export const exampleHeaders = { ...paymentHeaders("'self'"), 'X-Frame-Options': 'SAMEORIGIN' };

export function examplePlayer(template) {
  const film = {
    title: exampleTitle, duration: 579, prices: examplePrices, rentalHours: 48,
    info: { byline: 'the Miles Brothers', synopsis: 'A cable car threads its way through San Francisco traffic in 1906, days before the earthquake.',
      credits: [{role: 'Filmed by', name: 'Miles Brothers'}, {role: 'Archival print', name: 'Library of Congress'}] }
  };
  return renderPlayer(template, { published: film, fields: selectedFields('byline,synopsis,credits'), style: 'broadside',
    posterUrl: '/market-street-still.webp', previewSeconds: 10, mode: 'example', payable: false, example: true });
}
