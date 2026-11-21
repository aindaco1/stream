import { sumFilmStats } from './analytics.js';
import { filmPrices, previewSeconds, rentalHours, usdInput } from './prices.js';
import { payoutCountryOptions } from './payout-countries.js';
import { faqLink, siteFooter } from './site-frame.js';
import { firstSale, renderSetupCosts } from './filmmaker-help.js';
import { thumbnailEditor } from './thumbnail-view.js';
import { renderR2Card, renderR2TokenForm, renderStripeCard } from '@dustwave/admin-shell/provider-setup';

import { embedLayout, escapeHtml, iframeCode, infoFields, selectedFields } from './film-embed.js';

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

export function renderStripeCountryForm(csrf, mode) {
  const options = payoutCountryOptions.map(({ code, label }) => `<option value="${code}">${escapeHtml(label)}</option>`).join('');
  return `<p>Choose the country where your business is registered. If you operate as an individual, choose the country where you do business. Stripe uses it to determine your verification and payment requirements.</p>
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
  const payments = stripe.mode === 'test' ? 'test payments' : 'payments';
  const statuses = {
    unconnected: 'Not connected',
    ready: 'Connected',
    pending: 'Under review',
    unavailable: 'Needs a status check',
    action_required: 'More information needed',
    restricted: 'Payments unavailable'
  };
  let description = 'Use a new Stripe account or sign in to one you already have.';
  if (!stripe.configured) description = 'Dust Wave is still setting up Stripe for this workspace.';
  else if (ready) description = stripe.businessName ? `Payments account for ${stripe.businessName}.` : `Your Stripe account is ready for ${payments}.`;
  else if (stripe.status === 'pending') description = 'Stripe is reviewing your account information.';
  else if (stripe.status === 'unavailable') description = 'Check the connection again. If Stripe asks, reconnect the same account.';
  else if (stripe.reason) description = stripe.reason;

  return renderStripeCard({
    title: 'Get paid with Stripe',
    status: stripe.configured ? (statuses[stripe.status] || 'Not connected') : 'Payments setup unavailable',
    // The shared renderer uses this flag to hide onboarding controls. Status
    // text and payment authorization retain their independent provider values.
    description: ready ? description : firstSale + ' ' + description, csrfToken: csrf, ready: ready || stripe.status === 'pending' || stripe.unsupportedCountry, existingOAuth: stripe.existingAvailable === true,
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

export function renderBucketAccess(csrf, location, error, action = '/setup/r2/access') {
  return (error ? `<p class="feedback error" role="alert">${escapeHtml(error)}</p>` : '') +
    renderR2TokenForm({ ...location, ...uploadOptions, csrfToken: csrf, action }) +
    '<p><a href="/setup/settings#storage">Choose another bucket</a></p>';
}

function storageCard(r2, draft, csrf) {
  const connected = r2.status === 'ready';
  const jurisdiction = draft.jurisdiction ?? r2.jurisdiction;
  return renderR2Card({
    ...uploadOptions, title: 'Store your film on Cloudflare',
    status: connected ? 'Connected' : r2.status === 'error' ? 'Check connection' : 'Not connected',
    description: connected ? (r2.uploads ? `Films and thumbnails upload to ${r2.bucket} from Stream.` : `Stream has read access to ${r2.bucket}.`) :
      'Connect a private R2 bucket in your Cloudflare account. Your film stays in that bucket.',
    action: '/setup/r2', guideAction: '/setup/r2/location', csrfToken: csrf, connected,
    values: {
      accountId: draft.accountId ?? r2.accountId,
      bucket: draft.bucket ?? r2.bucket,
      jurisdiction: ['eu', 'us', 'fedramp'].includes(jurisdiction) ? jurisdiction : 'default'
    }
  });
}

function formatDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return '';
  const seconds = Math.round(duration);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && `${hours} h`, minutes && `${minutes} min`, seconds % 60 && `${seconds % 60} sec`]
    .filter(Boolean).join(' ');
}

function priceFields(film) {
  const prices = filmPrices(film.prices) ?? { rent: null, buy: null };
  const maxPreview = film.duration > 0 ? Math.min(30, Math.ceil(film.duration) - 1) : 30;
  return `<fieldset class="price-fields"><legend>Prices and playback</legend>
    <div class="field-stack">
      <p class="hint">Rental time starts at payment. Buyers can save the original film file. Leave a price blank to turn off that offer for new viewers.</p>
      <div class="price-grid">
        <label>Rental price (USD) <input type="number" name="rentPrice" min="0.50" max="999999.99" step="0.01" inputmode="decimal" value="${usdInput(prices.rent)}"></label>
        <label>Rental duration (hours) <input type="number" name="rentalHours" min="1" max="720" step="1" required value="${rentalHours(film.rentalHours)}"></label>
        <label>Download purchase (USD) <input type="number" name="buyPrice" min="0.50" max="999999.99" step="0.01" inputmode="decimal" value="${usdInput(prices.buy)}"></label>
        <label>Free preview (seconds) <input type="number" name="previewSeconds" min="0" max="${maxPreview}" step="1" required value="${previewSeconds(film.previewSeconds)}"></label>
      </div>
      <p class="hint">${maxPreview ? `Choose up to ${maxPreview} seconds. Set 0 to show the offers immediately. The preview must end before the film does.` :
        'This film is too short for a free preview. Set 0 to show the offers immediately.'}</p>
    </div>
  </fieldset>`;
}

function priceEditor(film, csrf) {
  return `<form class="price-editor" aria-label="Edit prices and playback for ${escapeHtml(film.title)}" method="post" action="/setup/dashboard/settings">${hidden('csrf', csrf)}${hidden('filmId', film.id)}
      ${priceFields(film)}<button type="submit">Save settings</button>
    </form>`;
}

export function filmSection({ r2, rights, draft, csrf }) {
  const fields = hidden('csrf', csrf) + hidden('draftId', draft.id);
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
      <p>Choose an MP4, MOV or MKV up to 10 GB and four hours long. Supported video formats are H.264, H.265 (HEVC), AV1 and VP9. Include subtitle tracks in the file if you want viewers to be able to turn them on.</p>
    </details>
    <form method="post" action="/setup/film" data-film-form>${fields}
      <label>Film title<input id="film-title" name="title" type="text" maxlength="160" required value="${escapeHtml(draft.title)}"></label>
      ${r2.uploads ? `<div class="video-upload">
        <label>Video file<input type="file" accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska" data-video></label>
        <p class="hint">MP4, MOV or MKV, up to 10 GB.</p>
        <p data-upload-status role="status" aria-live="polite"></p><progress data-upload-progress value="0" max="1" hidden></progress>
        <button class="secondary" type="button" data-cancel-upload hidden>Discard unfinished upload</button></div>` :
        '<p><a href="/setup/r2/uploads">Enable uploads in Storage settings</a> to choose a video from this device.</p>'}
      <details class="film-guide"${!r2.uploads ? ' open' : ''}><summary>Use an existing file</summary>
        <label>Object key<input id="object-key" name="objectKey" type="text" maxlength="1024" spellcheck="false"
          autocapitalize="none" value="${escapeHtml(draft.objectKey)}"></label>
        <p class="hint">Enter the exact path of a film already in your connected bucket.</p></details>
      ${priceFields(draft)}
      <div class="film-actions"><button type="submit">Check film and create preview</button>
        <button class="secondary" type="submit" name="intent" value="save" formnovalidate>Save draft</button></div>
    </form>`;
}

function sectionTabs(label, initial, sections) {
  const links = sections.map(({ id, name }) => `<a href="#${id}" id="tab-${id}" data-tab="${id}">${name}</a>`).join('');
  const panels = sections.map(({ id, content }) => `<div class="workspace-panel" id="${id}">${content}</div>`).join('');
  return `<div class="workspace-sections" data-initial="${initial}">
    <nav class="tab-bar subtabs" aria-label="${label}">${links}</nav>${panels}</div>`;
}

export function renderSettingsPage({ filmmaker = {}, csrf, stripe = {}, r2 = {}, draft = {}, error, notice, initialSection }) {
  const initial = initialSection || 'storage';
  return workspacePage('Settings', csrf, `<div class="workspace-intro"><h1>Settings</h1>
      ${filmmaker.name ? `<p class="account">Signed in as ${escapeHtml(filmmaker.name)}</p>` : ''}</div>
      ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${notice ? `<div class="feedback" role="status">${escapeHtml(notice)}</div>` : ''}
      ${sectionTabs('Settings sections', initial, [
        { id: 'storage', name: 'Storage', content: storageCard(r2, draft, csrf) +
          (r2.status === 'ready' ? (r2.uploads ? '' : '<a class="primary-link" href="/setup/r2/uploads">Enable film and thumbnail uploads</a>') + '<a href="/setup/dashboard#films">Go to films</a>' : '') + renderSetupCosts('r2') },
        { id: 'payments', name: 'Payments', content: stripeCard(stripe, csrf) +
          (['ready', 'pending'].includes(stripe.status) ? (r2.status === 'ready' ? '<a href="/setup/dashboard#films">Go to films</a>' : '<a href="#storage">Go to storage</a>') : '') + renderSetupCosts('stripe') }
      ])}`);
}

export function workspacePage(title, csrf, content, { dashboard = false, builder = false, filmUpload = false, admin = false } = {}) {
  const current = ' aria-current="page"';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    <title>${escapeHtml(title)} · Stream</title><link rel="stylesheet" href="/site-frame.css"><link rel="stylesheet" href="/setup/style.css">
    <link rel="stylesheet" href="/setup/dark.css" media="(prefers-color-scheme: dark)" data-appearance-dark>
    <script src="/setup/appearance.js" data-appearance-key="stream.filmmaker.appearance"></script>
    <script type="module" src="/select-focus.js"></script>
    ${!csrf ? '<script src="/setup/sign-in.js" defer></script>' : !admin ? '<script type="module" src="/setup/navigation.js"></script>' : ''}
    ${builder ? '<script type="module" src="/setup/dashboard.js"></script><script type="module" src="/setup/thumbnail.js"></script>' : ''}
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

const statsLabels = {
  previews: 'Preview starts', plays: 'Paid plays', rentals: 'Rentals', purchases: 'Purchases',
  revenue: 'Revenue', netRevenue: 'Net Revenue', estimatedFees: 'Estimated card fees', filmTaxFees: 'Film share of Stripe Tax fees', taxCollected: 'Tax charged'
};
const platformLabels = { ...statsLabels, platformTips: 'Platform tips after tax and fees', tipTaxFees: 'Tip share of Stripe Tax fees', transfersToReview: 'Transfers to review' };
const moneyFields = new Set(['revenue', 'netRevenue', 'estimatedFees', 'filmTaxFees', 'tipTaxFees', 'platformTips', 'taxCollected']);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const displayStat = (stats, key) => moneyFields.has(key) ? usd.format(stats[key] / 100) : String(stats[key]);
function statsList(stats, labels = statsLabels) {
  return '<dl class="film-stats">' + Object.entries(labels).map(([key, label]) =>
    `<div><dt>${label}</dt><dd>${displayStat(stats, key)}</dd></div>`
  ).join('') + '</dl>';
}
function revenueNote(stats) {
  const reported = stats.rentals + stats.purchases - stats.estimatedOrders;
  const fees = reported ? `Stripe has reported ${usd.format(stats.reportedFees / 100)} in processing fees on ${reported} ${reported === 1 ? 'payment' : 'payments'}. ` : '';
  const estimated = stats.estimatedOrders ? 'Net revenue uses the estimate while Stripe confirms the remaining fees. ' : '';
  const pending = stats.pendingTaxFees ? `Net revenue is provisional for ${stats.pendingTaxFees} ${stats.pendingTaxFees === 1 ? 'payment' : 'payments'} awaiting the Stripe Tax fee. ` : '';
  return `<p class="hint">Sandbox amounts in USD. Revenue counts film prices before refunds. Net revenue deducts card fees, the film’s confirmed share of Stripe Tax fees and recorded refunds up to the film price. Tax charged includes any tax within the tip and is shown at purchase. The fee estimate uses the standard U.S. domestic card rate on the full charge. ${fees}${estimated}${pending}See Stripe for payouts and dispute adjustments.</p>`;
}

export function renderPlatformDashboard(csrf, report) {
  const { owner, rows, page, pages, total, makers } = report;
  const url = (maker, number = 1) => {
    const query = new URLSearchParams();
    if (maker !== null) query.set('maker', maker);
    if (number > 1) query.set('page', String(number));
    return '/setup/admin' + (query.size ? '?' + escapeHtml(query.toString()) : '');
  };
  const platform = owner === null;
  const headers = Object.values(platformLabels).map(label => `<th scope="col">${label}</th>`).join('');
  const tableRows = rows.map(row => {
    const name = platform ? `<a href="${url(row.name)}">${escapeHtml(row.name)}</a>` : escapeHtml(row.title);
    const cells = Object.keys(platformLabels).map(key => `<td>${displayStat(row, key)}</td>`).join('');
    return `<tr><th scope="row">${name}</th>${platform ? `<td>${row.films}</td>` : ''}${cells}</tr>`;
  }).join('');
  const paging = pages > 1 ? `<nav class="film-actions" aria-label="Report pages">
    ${page > 1 ? `<a href="${url(owner, page - 1)}">Previous</a>` : ''} Page ${page} of ${pages}
    ${page < pages ? `<a href="${url(owner, page + 1)}">Next</a>` : ''}</nav>` : '';
  return workspacePage('Platform analytics', csrf, `
    <div class="workspace-intro">${platform ? '' : '<a href="/setup/admin">All filmmakers</a>'}
      <h1>${platform ? 'Platform analytics' : escapeHtml(owner)}</h1>
      <p class="account">${platform ? makers + ' filmmakers · ' : ''}${total.films} films</p></div>
    <section class="film-card"><h2>Overview</h2>${statsList(total, platformLabels)}${revenueNote(total)}
      ${total.transfersToReview ? '<p class="hint">Review refunded or disputed marketplace charges in Stripe. An adjustment can hold an unpaid transfer or require a reversal after funds were sent.</p>' : ''}</section>
    <section class="film-list"><h2>${platform ? 'Filmmakers' : 'Films'}</h2>
      ${tableRows ? `<div class="analytics-table" role="region" aria-label="${platform ? 'Filmmaker' : 'Film'} analytics" tabindex="0"><table><thead><tr>
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

function embedBuilder(film, url, previewUrl, selection) {
  const fields = selectedFields(selection);
  const populated = infoFields.filter(({ name }) => film.info?.[name]).map(field => field.name);
  const layout = embedLayout(url, fields, populated);
  const code = iframeCode(layout, film.title);
  const options = infoFields.map(field =>
    `<label><input type="checkbox" name="include" value="${field.name}"${fields.includes(field) ? ' checked' : ''}> ${field.label}</label>`).join('');
  return `<section class="film-sharing" id="embed-${escapeHtml(film.id)}" data-player="${escapeHtml(url)}" data-preview="${escapeHtml(previewUrl)}" data-populated="${populated.join(',')}">
    <div class="embed-controls"><h4>Embed this film</h4>
      <form method="get" action="/setup/dashboard#embed-${escapeHtml(film.id)}">${hidden('film', film.id)}
        <fieldset class="embed-options"><legend>Include in this embed</legend><div class="embed-checks">${options}</div><p class="hint">Only fields with saved text will appear.</p></fieldset>
        <noscript><button>Update preview and code</button></noscript></form>
      <div><label for="code-${escapeHtml(film.id)}">Embed code</label>
        <textarea id="code-${escapeHtml(film.id)}" class="embed-code" readonly spellcheck="false" rows="3">${escapeHtml(code)}</textarea></div>
      <div class="film-actions"><button class="secondary copy-embed" type="button">Copy embed code</button><span class="copy-status" role="status"></span></div>
    </div>
    <div class="embed-preview"><div class="preview-heading"><h5>Live preview</h5><a class="public-player" href="${escapeHtml(layout.src)}">Open public player</a></div>
      ${iframeCode(embedLayout(previewUrl, fields, populated), film.title, false)}</div>
    </section>`;
}

export function renderDashboard({ csrf, owner, error, films, origin, previewOrigin = origin, draft, selectionFilm, selection = '', infoSaved = false }) {
  const totals = sumFilmStats(films);
  const cards = films.map(film => {
    const path = '/embed/' + encodeURIComponent(film.id);
    const fields = selectionFilm === film.id ? selection : '';
    const preview = previewSeconds(film.previewSeconds) ? `<a class="primary-link secondary" href="/setup/preview/${escapeHtml(film.id)}">Watch private preview</a>` : '';
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
  const add = films.some(film => film.id === draft.id)
    ? `<form method="post" action="/setup/next">${hidden('csrf', csrf)}${hidden('draftId', draft.id)}<button>Add a film</button></form>`
    : `<a class="primary-link" href="/setup/dashboard/new">${draft.title || draft.rights ? 'Continue film draft' : 'Add a film'}</a>`;
  return workspacePage('Dashboard', csrf, `<div class="workspace-intro"><h1>Dashboard</h1>
    <p class="account">Signed in as ${escapeHtml(owner)}</p></div>
    ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
    <section class="film-card" id="overview"><h2>Overview</h2>${statsList(totals)}
      ${revenueNote(totals)}
      <a href="/setup/settings#payments">Payment settings</a></section>
    <section class="film-list" id="films"><header class="film-list-header"><h2>Films</h2>${add}</header>
      ${cards || '<p>You have no saved films yet.</p>'}</section>`, { dashboard: true, builder: true });
}
