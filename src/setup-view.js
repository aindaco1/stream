import { bucketSelection, hasVideoExtension } from './bucket-videos.js';
import { sumFilmStats } from './analytics.js';
import { savedPreviewSeconds } from './prices.js';
import { formatDuration, hidden, priceFields, programOfferSummary } from './offer-fields.js';
import { payoutCountryOptions } from './payout-countries.js';
import { faqLink, siteFooter } from './site-frame.js';
import { thumbnailEditor } from './thumbnail-view.js';
import { renderR2Card, renderR2TokenForm, renderStripeCard } from '@dustwave/admin-shell/provider-setup';

import { embedLayout, escapeHtml, iframeCode, infoFields, selectedFields } from './film-embed.js';

export function renderStripeCountryForm(csrf, mode) {
  const options = payoutCountryOptions.map(({ code, label }) => `<option value="${code}">${escapeHtml(label)}</option>`).join('');
  return `<p>Choose the country where your business is registered. If you work as an individual, choose where you do business.</p>
    <form method="post" action="/setup/stripe/start" class="provider-form">
      ${hidden('csrf', csrf)}${hidden('mode', mode)}
      <label>Business country or region <select name="country" required>
        <option value="" selected disabled>Choose a country or region</option>${options}</select></label>
      <button type="submit">Continue to Stripe</button>
    </form>
    <p><a href="/setup/settings#payments">Back to payments</a></p>`;
}

function stripeCard(stripe, csrf) {
  const ready = stripe.status === 'ready';
  const statuses = {
    unconnected: 'Not connected',
    ready: 'Connected',
    pending: 'Under review',
    unavailable: 'Needs a status check',
    action_required: 'More information needed',
    restricted: 'Payments unavailable'
  };
  let description = 'Connect Stripe to publish and get paid.';
  if (!stripe.configured) description = 'Dust Wave is still setting up Stripe for this workspace.';
  else if (ready) {
    description = stripe.businessName && stripe.businessName !== stripe.accountId ? stripe.businessName : '';
    if (!description && stripe.accountId) description = `Account ending in ${stripe.accountId.slice(-4)}`;
  }
  else if (stripe.status === 'pending') description = 'Stripe is reviewing your account information.';
  else if (stripe.status === 'unavailable') description = 'Check the connection again. If Stripe asks, reconnect the same account.';
  else if (stripe.reason) description = stripe.reason;

  return renderStripeCard({
    title: stripe.mode === 'test' ? 'Stripe · Test payments' : 'Stripe', showGuide: false,
    status: stripe.configured ? (statuses[stripe.status] || 'Not connected') : 'Payments setup unavailable',
    // The shared renderer uses this flag to hide onboarding controls. Status
    // text and payment authorization retain their independent provider values.
    description, csrfToken: csrf, ready: ready || stripe.status === 'pending' || stripe.unsupportedCountry, existingOAuth: stripe.existingAvailable === true,
    resume: stripe.hasAccount === true || stripe.creating === true,
    action: stripe.configured ? '/setup/stripe/start' : undefined,
    checkAction: stripe.configured && stripe.hasAccount ? '/setup/stripe/check' : undefined,
    resetHref: stripe.canReset ? '/setup/stripe/reset' : undefined
  });
}

export function renderStripeReset(csrf, mode, state, confirmation) {
  const name = state.businessName || state.accountId;
  const connection = name ? `<strong>${escapeHtml(name)}</strong>` : 'this unfinished connection';
  return `<p>Reset ${connection} for ${mode === 'test' ? 'sandbox' : 'live'} payments in Stream?</p>
    <p>New sales pause until you connect Stripe again. Earlier payments stay with their original account, and viewers keep access to paid rentals and purchases.</p>
    <p>Your Stripe account stays open. Stream keeps the connection needed to verify earlier payments.</p>
    <form method="post" action="/setup/stripe/reset">${hidden('csrf', csrf)}${hidden('confirmation', confirmation)}
      <div class="film-actions"><button type="submit">Reset Stripe connection</button><a href="/setup/settings#payments">Cancel</a></div></form>`;
}

const uploadOptions = { storageAccess: 'uploads', uploadConsent: 'I authorize Stream to encrypt and store this bucket key for video and thumbnail uploads.' };

export function renderBucketAccess(csrf, location, error, action, replacing) {
  const back = action === '/setup/r2/access' ? '<a href="/setup/settings?bucket=change#storage">Choose another bucket</a>' : '<a href="/setup/settings#storage">Back to Storage</a>';
  return (error ? `<p class="feedback error" role="alert">${escapeHtml(error)}</p>` : '') +
    renderR2TokenForm({ ...location, ...uploadOptions, csrfToken: csrf, action, buttonLabel: replacing ? 'Save replacement key' : undefined }) +
    `<p>${back}</p>`;
}

function storageCard(r2, draft, csrf, chooseBucket) {
  const connected = r2.status === 'ready';
  const choosing = !connected || chooseBucket;
  const card = renderR2Card({
    ...uploadOptions, title: 'Cloudflare R2', showGuide: false,
    status: connected ? 'Connected' : 'Not connected',
    description: connected ? `${r2.bucket}${r2.uploads ? '' : ' (read-only)'}` : 'Connect a private bucket for your films and thumbnails.',
    action: choosing ? '/setup/r2' : undefined, guideAction: choosing ? '/setup/r2/location' : undefined,
    csrfToken: csrf, values: draft
  });
  if (!connected) return card;
  const actions = choosing ? '<a href="/setup/settings#storage">Cancel bucket change</a>' :
    (r2.uploads ? '<a href="/setup/r2/uploads">Replace R2 key</a>' : '<a href="/setup/r2/uploads">Enable film and thumbnail uploads</a>') +
    '<a href="/setup/settings?bucket=change#storage">Use a different bucket</a>';
  return card + `<div class="film-actions">${actions}</div>`;
}

function priceEditor(film, csrf) {
  return `<form class="price-editor" aria-label="Edit prices and playback for ${escapeHtml(film.title)}" method="post" action="/setup/dashboard/settings">${hidden('csrf', csrf)}${hidden('filmId', film.id)}
      ${priceFields(film)}<button type="submit">Save settings</button>
    </form>`;
}

export function filmSection({ r2, rights, draft, csrf }) {
  const fields = hidden('csrf', csrf) + hidden('draftId', draft.id);
  const otherFile = draft.objectKey && !hasVideoExtension(draft.objectKey);
  if (r2.status !== 'ready') {
    return '<p>Connect your <a href="/setup/settings#storage">storage bucket</a> to add your first film.</p>';
  }
  if (!rights.accepted) {
    return `<p>Confirm your distribution rights before uploading or selecting this film.</p>
      <form method="post" action="/setup/rights">${fields}
        <label class="rights-choice"><input name="rightsAccepted" type="checkbox" value="yes" required>
          <span>${escapeHtml(rights.statement)}</span></label>
        <button type="submit">Confirm rights and continue</button>
      </form>`;
  }
  return `
    <details class="film-guide"><summary>Supported video settings</summary>
      <p>Choose an MP4, MOV or MKV up to 10 GB and four hours long. Supported video formats are H.264, H.265 (HEVC), AV1 and VP9. Include subtitle tracks in the file if you want viewers to be able to turn them on. <a href="/faq#tv">Recommended export settings for TV viewing</a></p>
    </details>
    <form method="post" action="/setup/film" data-film-form>${fields}
      <label>${draft.programTarget ? 'Video title' : 'Film title'}<input id="film-title" name="title" type="text" maxlength="160" required value="${escapeHtml(draft.title)}"></label>
      ${r2.uploads ? `<div class="video-upload">
        <label>Video file<input type="file" accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska" data-video></label>
        <p class="hint">MP4, MOV or MKV, up to 10 GB.</p>
        <p data-upload-status role="status" aria-live="polite"></p><progress data-upload-progress value="0" max="1" hidden></progress>
        <button class="secondary" type="button" data-cancel-upload hidden>Discard unfinished upload</button></div>` :
        '<p><a href="/setup/r2/uploads">Enable uploads in Storage settings</a> to choose a video from this device.</p>'}
      ${hidden('activeBucket', bucketSelection(r2))}
      <details class="film-guide file-picker" data-bucket-picker${!r2.uploads || draft.objectKey ? ' open' : ''}><summary>Use an existing file</summary>
        <label>Video in your bucket<select id="object-key" name="objectKey">
          <option value="">Choose a video</option>${draft.objectKey ? `<option selected${otherFile ? ' data-other="true"' : ''} value="${escapeHtml(draft.objectKey)}">${escapeHtml(draft.objectKey)}</option>` : ''}</select></label>
        <label class="rights-choice"><input type="checkbox" data-all-files${otherFile ? ' checked' : ''}>Show all files</label>
        <p class="hint" role="status" data-file-status></p>
        <div class="film-actions"><button type="button" class="secondary" data-more-files hidden>Load more files</button>
          <button type="button" class="secondary" data-preview-file${draft.objectKey ? '' : ' hidden'}>Preview selected video</button></div>
        <video data-file-preview controls playsinline preload="none" aria-label="Selected file preview" hidden></video>
      </details>
      ${draft.programTarget ? '' : priceFields(draft)}
      <div class="film-actions"><button type="submit">${draft.programTarget ? 'Add video to program' : 'Check film and create preview'}</button>
        <button class="secondary" type="submit" name="intent" value="save" formnovalidate>Save draft</button></div>
    </form>`;
}

function sectionTabs(label, initial, sections) {
  const links = sections.map(({ id, name }) => `<a href="#${id}" id="tab-${id}" data-tab="${id}">${name}</a>`).join('');
  const panels = sections.map(({ id, content }) => `<div class="workspace-panel" id="${id}">${content}</div>`).join('');
  return `<div class="workspace-sections" data-initial="${initial}">
    <nav class="tab-bar subtabs" aria-label="${label}">${links}</nav>${panels}</div>`;
}

export function renderSettingsPage({ filmmaker = {}, csrf, stripe = {}, r2 = {}, draft = {}, error, notice, initialSection, chooseBucket = false }) {
  const initial = initialSection || 'storage';
  return workspacePage('Settings', csrf, `<div class="workspace-intro"><h1>Settings</h1>
      ${filmmaker.name ? `<p class="account">Signed in as ${escapeHtml(filmmaker.name)}</p>` : ''}</div>
      ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${notice ? `<div class="feedback" role="status">${escapeHtml(notice)}</div>` : ''}
      ${sectionTabs('Settings sections', initial, [
        { id: 'storage', name: 'Storage', content: storageCard(r2, draft, csrf, chooseBucket) +
          '<a href="/faq#storage">Storage setup and pricing FAQ</a>' },
        { id: 'payments', name: 'Payments', content: stripeCard(stripe, csrf) +
          '<a href="/faq#payments">Stripe setup, fees and payouts FAQ</a>' }
      ])}`);
}

export function workspacePage(title, csrf, content, { dashboard = false, builder = false, filmUpload = false, programEditor = false, programPreview = false, admin = false } = {}) {
  const current = ' aria-current="page"';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    <title>${escapeHtml(title)} · Stream</title><link rel="stylesheet" href="/site-frame.css"><link rel="stylesheet" href="/setup/style.css">
    <link rel="stylesheet" href="/setup/dark.css" media="(prefers-color-scheme: dark)" data-appearance-dark>
    ${programPreview ? '<link rel="stylesheet" href="/program-lineup.css">' : ''}
    <script src="/setup/appearance.js" data-appearance-key="stream.filmmaker.appearance"></script>
    <script type="module" src="/select-focus.js"></script>
    ${csrf ? '<script type="module" src="/setup/field-help.js"></script>' : ''}
    ${!csrf ? '<script src="/setup/sign-in.js" defer></script>' : !admin ? '<script type="module" src="/setup/navigation.js"></script>' : ''}
    ${builder ? '<script type="module" src="/setup/dashboard.js"></script><script type="module" src="/setup/thumbnail.js"></script>' : ''}
    ${programEditor ? '<script type="module" src="/setup/program-editor.js"></script><script type="module" src="/setup/thumbnail.js"></script>' : ''}
    ${filmUpload ? '<script type="module" src="/setup/video-upload.js"></script>' : ''}</head>
    <body><a class="skip" href="#main">Skip to content</a>
    <header class="masthead"><div class="bar"><strong class="brand">Stream</strong>
      ${faqLink()}
      <label class="appearance" title="Appearance"><span aria-hidden="true">🌓</span><select aria-label="Appearance" data-appearance-select>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      ${csrf ? `<form method="post" action="${admin ? '/setup/admin/sign-out' : '/setup/sign-out'}">${hidden('csrf', csrf)}
        <button class="sign-out" type="submit">Sign out</button></form>` : ''}</div>
      ${csrf && !admin ? `<nav class="workspace-nav" aria-label="Filmmaker workspace"><div class="tab-bar">
        <a href="/setup/dashboard"${dashboard ? current : ''}>Dashboard</a>
        <a href="/setup/settings"${dashboard ? '' : current}>Settings</a>
      </div></nav>` : ''}</header>
    <main class="setup-shell" id="main" tabindex="-1">${content}</main>
    ${siteFooter(admin ? '/setup/admin' : '/setup/dashboard')}</body></html>`;
}

const primaryLabels = { plays: 'Paid plays', averageWatch: 'Avg. watch time', sales: 'Sales', netRevenue: 'Net Revenue' };
const detailLabels = {
  previews: 'Preview starts', rentals: 'Rentals', purchases: 'Purchases', revenue: 'Revenue',
  estimatedFees: 'Estimated card fees', filmTaxFees: 'Film share of Stripe Tax fees', taxCollected: 'Tax charged'
};
const platformDetails = { ...detailLabels, platformTips: 'Platform tips after tax and fees', tipTaxFees: 'Tip share of Stripe Tax fees', transfersToReview: 'Transfers to review' };
const platformLabels = {...primaryLabels, ...platformDetails};
const moneyFields = new Set(['revenue', 'netRevenue', 'estimatedFees', 'filmTaxFees', 'tipTaxFees', 'platformTips', 'taxCollected']);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function displayStat(stats, key) {
  if (key === 'sales') return String(stats.rentals + stats.purchases);
  if (key === 'averageWatch') {
    if (!stats.timedPlays) return '—';
    return formatDuration(Math.round(stats.watchSeconds / stats.timedPlays)) || '0 sec';
  }
  return moneyFields.has(key) ? usd.format(stats[key] / 100) : String(stats[key]);
}
function statsList(stats, details = detailLabels) {
  const reported = stats.rentals + stats.purchases - stats.estimatedOrders;
  const payments = n => n + (n === 1 ? ' payment' : ' payments');
  const explanations = {
    previews: 'How many times a free preview started. Someone can watch more than once.',
    plays: 'How many times a rented or purchased video started playing. Watching another title in a program can count as another play.',
    averageWatch: 'How long viewers watched, on average, each time they played a paid title. Pauses, buffering and skipped footage add no time. A dash means no plays have been timed yet.',
    sales: 'Completed rentals and purchases combined. Buying or renting an entire program counts as one sale.',
    rentals: 'Completed rental payments. Renting a whole program counts once.',
    purchases: 'Completed purchases that include a download. Buying a whole program counts once.',
    revenue: 'The film and program prices viewers paid, before fees or refunds. Tips and sales tax are counted separately.',
    netRevenue: 'What filmmakers keep after card fees, their share of confirmed Stripe Tax fees, and any recorded refunds up to the film price.' +
      (stats.estimatedOrders ? ' Card fees are still estimated for ' + payments(stats.estimatedOrders) + '.' : '') +
      (stats.pendingTaxFees ? ' The Stripe Tax fee is still pending for ' + payments(stats.pendingTaxFees) + '.' : ''),
    estimatedFees: 'Stream estimates card fees at the U.S. domestic rate of 2.9% plus 30¢ per payment, including tips and tax.' +
      (reported ? ' Stripe has reported ' + usd.format(stats.reportedFees / 100) + ' in processing fees on ' + payments(reported) + '.' : ''),
    filmTaxFees: 'The filmmaker’s share of the fee Stripe charges to calculate tax. When a payment includes a tip, Dust Wave covers the tip’s share.',
    taxCollected: 'Tax charged at checkout, including any tax already included in a platform tip. This shows the original tax at the time of sale.',
    platformTips: 'Optional tips left for Dust Wave, after any tax included in the tip and the tip’s share of confirmed Stripe Tax fees.',
    tipTaxFees: 'The part of the confirmed Stripe Tax fee paid from Dust Wave’s tip.',
    transfersToReview: 'Payments with refunds or disputes that may need a transfer adjustment. Open Stripe to review them.'
  };
  const list = labels => '<dl class="film-stats">' + Object.entries(labels).map(([key, label]) =>
    `<div><dt data-field-help="${escapeHtml(explanations[key])}">${label}</dt><dd>${displayStat(stats, key)}</dd></div>`
  ).join('') + '</dl>';
  return `<div class="analytics-summary">${list(primaryLabels)}
    <details class="analytics-breakdown"><summary>Viewing and sales breakdown</summary>${list(details)}</details></div>`;
}

const analyticsGuide = '<p class="hint"><a href="/faq#dashboard-analytics">How these numbers are calculated</a></p>';

export function renderPlatformDashboard(csrf, report) {
  const { owner, rows, page, pages, total, makers } = report;
  const url = (maker, number = 1) => {
    const query = new URLSearchParams();
    if (maker !== null) query.set('maker', maker);
    if (number > 1) query.set('page', String(number));
    return '/setup/admin' + (query.size ? '?' + escapeHtml(query.toString()) : '');
  };
  const platform = owner === null;
  const detailColumn = key => key in platformDetails ? ' class="detail-column"' : '';
  const headers = Object.entries(platformLabels).map(([key, label]) => `<th scope="col"${detailColumn(key)}>${label}</th>`).join('');
  const tableRows = rows.map(row => {
    const name = platform ? `<a href="${url(row.name)}">${escapeHtml(row.name)}</a>` : escapeHtml(row.title);
    const cells = Object.keys(platformLabels).map(key => `<td${detailColumn(key)}>${displayStat(row, key)}</td>`).join('');
    return `<tr><th scope="row">${name}</th>${platform ? `<td>${row.films}</td>` : ''}${cells}</tr>`;
  }).join('');
  const paging = pages > 1 ? `<nav class="film-actions" aria-label="Report pages">
    ${page > 1 ? `<a href="${url(owner, page - 1)}">Previous</a>` : ''} Page ${page} of ${pages}
    ${page < pages ? `<a href="${url(owner, page + 1)}">Next</a>` : ''}</nav>` : '';
  return workspacePage('Platform analytics', csrf, `
    <div class="workspace-intro">${platform ? '' : '<a href="/setup/admin">All filmmakers</a>'}
      <h1>${platform ? 'Platform analytics' : escapeHtml(owner)}</h1>
      <p class="account">${platform ? makers + ' filmmakers · ' : ''}${total.films} films${total.programs ? ' · ' + total.programs + ' programs' : ''}</p></div>
    <section class="film-card"><h2>Overview</h2>${statsList(total, platformDetails)}${analyticsGuide}
      ${total.transfersToReview ? '<p class="hint">Review refunded or disputed marketplace charges in Stripe. An adjustment can hold an unpaid transfer or require a reversal after funds were sent.</p>' : ''}</section>
    <section class="film-list"><h2>${platform ? 'Filmmakers' : total.programs ? 'Films and programs' : 'Films'}</h2>
      ${tableRows ? `<label class="analytics-columns"><input type="checkbox"> Show detailed metrics</label><div class="analytics-table" role="region" aria-label="${platform ? 'Filmmaker' : 'Film'} analytics" tabindex="0"><table><thead><tr>
        <th scope="col">${platform ? 'Filmmaker' : 'Film'}</th>${platform ? '<th scope="col">Films</th>' : ''}${headers}</tr></thead><tbody>${tableRows}</tbody></table></div>` : '<p>No results yet.</p>'}
      ${paging}</section>`, { admin: true });
}

function filmInfoEditor(film, csrf, selection, saved) {
  const fields = infoFields.map(({ name, label, limit }) =>
    `<div><label for="${escapeHtml(film.id)}-${name}">${label}</label>
      <textarea id="${escapeHtml(film.id)}-${name}" name="${name}" rows="2" maxlength="${limit}">${escapeHtml(film.info?.[name])}</textarea></div>`).join('');
  return `<form id="info-${escapeHtml(film.id)}" class="film-info-editor" method="post" action="/setup/dashboard/info">
    ${hidden('csrf', csrf)}${hidden('filmId', film.id)}${hidden('show', selection)}
    <h4>Film details</h4><p class="hint">Each embed can show any of these fields. Saved edits appear wherever that field is included.</p>
    <div class="info-fields">${fields}</div><div class="film-actions"><button type="submit">Save film details</button>
    ${saved ? '<span role="status">Film details saved.</span>' : ''}</div></form>`;
}

function embedBuilder(film, url, previewUrl, selection, program = false) {
  const fields = selectedFields(selection);
  const populated = infoFields.filter(({ name }) => program || film.info?.[name]).map(field => field.name);
  const layout = embedLayout(url, fields, populated, program);
  const code = iframeCode(layout, film.title);
  const options = infoFields.map(field =>
    `<label><input type="checkbox" name="include" value="${field.name}"${fields.includes(field) ? ' checked' : ''}> ${field.label}</label>`).join('');
  let pricingNote = '';
  if (program && film.publishedOffer) {
    const published = programOfferSummary(film.publishedOffer);
    const draft = programOfferSummary(film);
    if (published !== draft) {
      pricingNote = `<aside class="offer-difference" aria-label="Unpublished pricing">
        <p><strong>Published</strong> ${escapeHtml(published)}</p>
        <p><strong>Saved draft</strong> ${escapeHtml(draft)}</p>
        <p><a href="/setup/preview/${escapeHtml(film.id)}">Preview saved draft</a> · <a href="/setup/program/${escapeHtml(film.id)}">Review and publish</a></p></aside>`;
    }
  }
  return `<section class="film-sharing"${program ? ' data-program' : ''} id="embed-${escapeHtml(film.id)}" data-player="${escapeHtml(url)}" data-preview="${escapeHtml(previewUrl)}" data-populated="${populated.join(',')}">
    <div class="embed-controls"><h4>Embed this ${program ? 'program' : 'film'}</h4>
      <form method="get" action="/setup/dashboard#embed-${escapeHtml(film.id)}">${hidden('film', film.id)}
        <fieldset class="embed-options"><legend>Include in this embed</legend><div class="embed-checks">${options}</div><p class="hint">Only fields with saved text will appear.</p></fieldset>
        <noscript><button>Update preview and code</button></noscript></form>
      <div><label for="code-${escapeHtml(film.id)}">Embed code</label>
        <textarea id="code-${escapeHtml(film.id)}" class="embed-code" readonly spellcheck="false" rows="3">${escapeHtml(code)}</textarea></div>
      <div class="film-actions"><button class="secondary copy-embed" type="button">Copy embed code</button><span class="copy-status" role="status"></span></div>
    </div>
    <div class="embed-preview"><div class="preview-heading"><h5>${program ? 'Published embed preview' : 'Live preview'}</h5><a class="public-player" href="${escapeHtml(layout.src)}">Open public player</a></div>
      ${pricingNote}${iframeCode(embedLayout(previewUrl, fields, populated, program), film.title, false)}</div>
    </section>`;
}

export function renderDashboard({ csrf, owner, error, films, programs = [], origin, previewOrigin = origin, draft, completedDraft = films.some(film => film.id === draft.id), selectionFilm, selection = '', infoSaved = false }) {
  const totals = sumFilmStats([...films, ...programs]);
  const cards = films.map(film => {
    const path = '/embed/' + encodeURIComponent(film.id);
    const fields = selectionFilm === film.id ? selection : '';
    const preview = savedPreviewSeconds(film.previewSeconds, film.duration) ? `<a class="primary-link secondary" href="/setup/preview/${escapeHtml(film.id)}">Watch private preview</a>` : '';
    const terms = film.published ? 'Unpublishing closes the preview and new sales. Existing viewers retain paid access.' :
      'Publishing makes this film available to viewers and allows other sites to embed it.';
    return `<details class="dashboard-film" name="films" id="${escapeHtml(film.id)}"${selectionFilm === film.id ? ' open' : ''}>
      <summary><span class="film-title">${escapeHtml(film.title)}</span><span class="film-meta">${film.published ? 'Published' : 'Private'} · ${formatDuration(film.duration)}</span></summary>
      <div class="film-panel">${preview}
      ${film.unsupportedSubtitles?.length ? '<p class="hint">The player could not use these subtitle tracks: ' + film.unsupportedSubtitles.map(escapeHtml).join(', ') + '. Include a text, DVD or Blu-ray subtitle track when preparing the film.</p>' : ''}
      ${statsList(film.stats)}${thumbnailEditor(film, csrf)}${priceEditor(film, csrf)}${filmInfoEditor(film, csrf, fields, infoSaved && selectionFilm === film.id)}
      ${film.published ? embedBuilder(film, origin + path, previewOrigin + path, fields) : ''}
      <form class="film-publication" action="/setup/dashboard/publication" method="post">${hidden('csrf', csrf)}${hidden('filmId', film.id)}
        <p class="hint">${terms}</p><button type="submit" class="${film.published ? 'secondary' : 'primary'}" name="visibility" value="${film.published ? 'private' : 'public'}">
          ${film.published ? 'Unpublish film' : 'Publish film'}</button></form></div></details>`;
  }).join('');
  const programCards = programs.map(program => {
    const id = escapeHtml(program.id), path = '/embed/' + id;
    const fields = selectionFilm === program.id ? selection : infoFields.map(field => field.name).join(',');
    const count = program.members.filter(item => item.role === 'film').length;
    const status = program.published ? 'Published' : program.unavailableTitle ? 'Sales paused' : 'Draft';
    return `<details class="dashboard-film" name="programs" id="${id}"${selectionFilm === program.id ? ' open' : ''}>
      <summary><span class="film-title">${escapeHtml(program.title || 'Untitled program')}</span><span class="film-meta">${status} · ${count} ${count === 1 ? 'film' : 'films'}</span></summary>
      <div class="film-panel">${program.unavailableTitle ? `<p class="feedback error">Sales are paused because the original file for <strong>${escapeHtml(program.unavailableTitle)}</strong> changed or is missing. Restore the original in storage, or edit the lineup to replace or remove this title. Publish the program again to reopen sales.</p>` : ''}
      <div class="film-actions"><a class="primary-link" href="/setup/program/${id}">Edit program</a>
      ${count >= 2 ? `<a href="/setup/preview/${id}">Private program preview</a>` : ''}</div>
      ${statsList({...program.stats, ...program.lineupViews})}
      ${program.published ? embedBuilder(program, origin + path, previewOrigin + path, fields, true) +
        `<form method="post" action="/setup/program/${id}">${hidden('csrf', csrf)}${hidden('version', program.version)}
        <button class="secondary" name="action" value="unpublish">Unpublish program</button></form>` : ''}
      </div></details>`;
  }).join('');
  const createProgram = films.length >= 2 ? `<form action="/setup/program/create" method="post">${hidden('csrf', csrf)}<button type="submit" class="primary">Create program</button></form>` : '';
  const pendingProgramVideo = !completedDraft && draft.programTarget;
  const continueVideo = pendingProgramVideo ? `<a class="primary-link${createProgram ? ' secondary' : ''}" href="/setup/dashboard/new">Continue ${escapeHtml(draft.programTarget.role)} video</a>` : '';
  const add = completedDraft
    ? `<form method="post" action="/setup/next">${hidden('csrf', csrf)}${hidden('draftId', draft.id)}<button>Add a film</button></form>`
    : pendingProgramVideo ? '' : `<a class="primary-link" href="/setup/dashboard/new">${draft.title || draft.rights ? 'Continue film draft' : 'Add a film'}</a>`;
  return workspacePage('Dashboard', csrf, `<div class="workspace-intro"><h1>Dashboard</h1>
    <p class="account">Signed in as ${escapeHtml(owner)}</p></div>
    ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
    <section class="film-card" id="overview"><h2>Overview</h2>${statsList(totals)}
      <div class="analytics-links">${analyticsGuide}<a href="/setup/settings#payments">Payment settings</a></div></section>
    <section class="film-list" id="films"><header class="film-list-header"><h2>Films</h2><div class="film-actions">${add}</div></header>
      ${cards || '<p>You have no saved films yet.</p>'}</section>
    <section class="film-list" id="programs"><header class="film-list-header"><h2>Programs</h2><div class="film-actions">${continueVideo}${createProgram}</div></header>
      ${programCards || '<p>Group your films into one screening with one embed and one checkout.</p>'}</section>`, { dashboard: true, builder: true });
}
