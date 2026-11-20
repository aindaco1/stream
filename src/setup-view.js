import { filmPrices, previewSeconds, rentalHours, usdInput } from './prices.js';
import { stripeBusinessCountries } from './setup-stripe.js';
import { renderR2Card, renderR2TokenForm, renderStripeCard } from '@dustwave/admin-shell/provider-setup';

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

export function renderStripeCountryForm(csrf, mode) {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const countries = stripeBusinessCountries.map(code => ({ code, label: names.of(code) }));
  countries.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  const options = countries.map(({ code, label }) => `<option value="${code}">${escapeHtml(label)}</option>`).join('');
  return `<p>Choose the country where your business is registered. If you operate as an individual, choose the country where you do business. Stripe uses it to determine your verification and payment requirements.</p>
    <form method="post" action="/setup/stripe/start" class="provider-form">
      ${hidden('csrf', csrf)}${hidden('mode', mode)}
      <label>Business country or region <select name="country" required>
        <option value="" selected disabled>Choose a country or region</option>${options}</select></label>
      <button type="submit">Continue to Stripe</button>
    </form>
    <p><a href="/setup#payments">Back to payments</a></p>`;
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
    restricted: 'Restricted by Stripe'
  };
  let description = stripe.mode === 'test' ? 'Connect on Stripe to receive sandbox rental and purchase payments.' : 'Connect on Stripe to receive rental and purchase payments.';
  if (!stripe.configured) description = 'You can connect storage and preview a film while Dust Wave configures Stripe.';
  else if (ready) description = stripe.businessName ? `Payments account for ${stripe.businessName}.` : `Your Stripe account is ready for ${payments}.`;
  else if (stripe.status === 'pending') description = 'Stripe is reviewing your information. You can prepare your film while you wait.';
  else if (stripe.status === 'unavailable') description = 'Check the connection again. If Stripe asks, reconnect the same account.';
  else if (stripe.reason) description = stripe.reason;

  return renderStripeCard({
    title: 'Get paid with Stripe',
    status: stripe.configured ? (statuses[stripe.status] || 'Not connected') : 'Payments setup unavailable',
    // The shared renderer uses this flag to hide onboarding controls. Status
    // text and payment authorization retain their independent provider values.
    description, csrfToken: csrf, ready: ready || stripe.status === 'pending', existingOAuth: stripe.existingAvailable === true,
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
      <div class="film-actions"><button type="submit">Reset Stripe connection</button><a href="/setup#payments">Cancel</a></div></form>`;
}

export function renderBucketAccess(csrf, location, error) {
  return (error ? `<p class="feedback error" role="alert">${escapeHtml(error)}</p>` : '') +
    renderR2TokenForm({ ...location, csrfToken: csrf, action: '/setup/r2/access' }) +
    '<p><a href="/setup#storage">Choose another bucket</a></p>';
}

function storageCard(r2, draft, csrf) {
  const connected = r2.status === 'ready';
  const jurisdiction = draft.jurisdiction ?? r2.jurisdiction;
  return renderR2Card({
    title: 'Store your film on Cloudflare',
    status: connected ? 'Connected' : r2.status === 'error' ? 'Check connection' : 'Not connected',
    description: connected ? `Stream verified read access to the bucket ${r2.bucket}.` :
      'Connect a private R2 bucket in your Cloudflare account. Your film stays in that bucket.',
    action: '/setup/r2', guideAction: '/setup/r2/location', csrfToken: csrf, connected,
    values: {
      accountId: draft.accountId ?? r2.accountId,
      bucket: draft.bucket ?? r2.bucket,
      jurisdiction: ['eu', 'us', 'fedramp'].includes(jurisdiction) ? jurisdiction : 'default'
    }
  });
}

function bucketDashboard({ accountId, bucket, jurisdiction = 'default' }) {
  if (/^[0-9a-f]{32}$/i.test(accountId) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) &&
    ['default', 'eu', 'us', 'fedramp'].includes(jurisdiction)) {
    return `https://dash.cloudflare.com/${accountId}/r2/${jurisdiction}/buckets/${bucket}`;
  }
  return 'https://dash.cloudflare.com/?to=/:account/r2/overview';
}

const privatePreview = path => typeof path === 'string' && /^\/setup\/preview\/[\w-]+$/.test(path);

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
      <p class="hint">Rental time starts at payment. Buyers can save the original MP4. Leave a price blank to turn off that offer for new viewers.</p>
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

function priceEditor(film, csrf, action = '/setup/film/prices') {
  const label = action === '/setup/dashboard/settings' ? 'Edit prices and playback' : 'Edit prices';
  return `<form class="price-editor" aria-label="${label} for ${escapeHtml(film.title)}" method="post" action="${action}">${hidden('csrf', csrf)}${hidden('filmId', film.id)}
      ${priceFields(film)}<button type="submit">Save settings</button>
    </form>`;
}

function filmSection({ r2, rights, film, draft, csrf }) {
  const fields = hidden('csrf', csrf) + hidden('draftId', draft.id);
  if (film) {
    const duration = formatDuration(film.duration);
    const preview = privatePreview(film.previewPath) && previewSeconds(film.previewSeconds) ?
      `<a class="primary-link" href="${escapeHtml(film.previewPath)}">Watch private preview</a>` : '';
    return `<h2>${escapeHtml(film.title)}</h2><p>Saved film${duration ? ' · ' + duration : ''}</p>
      ${priceEditor(film, csrf)}
      <div class="film-actions">${preview}<form method="post" action="/setup/next">${fields}
      <button class="secondary" type="submit">Add another film</button></form></div>`;
  }
  if (r2.status !== 'ready') {
    return '<h2>Add a film</h2><p>Connect your <a href="#storage">storage bucket</a> to add your first film.</p>';
  }
  if (!rights.accepted) {
    return `<h2>Add a film</h2><p>Confirm your distribution rights before uploading or selecting this film.</p>
      <form method="post" action="/setup/rights">${fields}
        <label class="rights-choice"><input name="rightsAccepted" type="checkbox" value="yes" required>
          <span>${escapeHtml(rights.statement)}</span></label>
        <button type="submit">Confirm rights and continue</button>
      </form>`;
  }
  return `<h2>Add a film</h2>
    <p>Use an MP4 already in <strong>${escapeHtml(r2.bucket)}</strong>, or upload one to that bucket first.</p>
    <details class="film-guide"><summary>Upload a new film to Cloudflare</summary>
      <ol><li><a href="${bucketDashboard(r2)}" target="_blank" rel="noopener noreferrer">Open your R2 bucket in Cloudflare</a>.</li>
      <li>In <strong>Objects</strong>, select <strong>Upload</strong> and choose your MP4. Wait for Cloudflare to finish.</li>
      <li>Copy the object key, including any folders and the filename, then return here.</li></ol>
      <p>For a large file, Cloudflare also supports multipart uploads from your own storage tools.
      <a href="https://developers.cloudflare.com/r2/objects/upload-objects/" target="_blank" rel="noopener noreferrer">Cloudflare’s upload guide</a></p>
    </details>
    <details class="film-guide"><summary>Supported video settings</summary>
      <p>Use a seekable MP4 in the H.264 Baseline profile, with optional AAC-LC audio. Start with a keyframe and place keyframes at least every 12 seconds.</p>
      <p>The current player supports films up to 1 GiB and four hours long.</p>
    </details>
    <form method="post" action="/setup/film">${fields}
      <label>Film title<input id="film-title" name="title" type="text" maxlength="160" required value="${escapeHtml(draft.title)}"></label>
      <div><label>Object key<input id="object-key" name="objectKey" type="text" maxlength="1024" spellcheck="false"
        autocapitalize="none" required aria-describedby="object-hint" value="${escapeHtml(draft.objectKey)}"></label>
      <p class="hint" id="object-hint">For example, films/My Feature.mp4. Copy the spelling and spaces exactly.</p></div>
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

export function renderSetupPage({ filmmaker = {}, csrf, stripe = {}, r2 = {}, rights = {}, film, films = [], draft = {}, error, notice, initialSection }) {
  const filmHTML = `<section class="film-card">${filmSection({ r2, rights, film, draft, csrf })}</section>`;
  const saved = films.length ? films.filter(item => privatePreview(item.previewPath) && item.id !== film?.id).map(item =>
    `<li>${previewSeconds(item.previewSeconds) ? `<a href="${escapeHtml(item.previewPath)}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}${priceEditor(item, csrf)}</li>`).join('') : '';
  const library = saved ? `<section class="film-card"><h2>Saved films</h2><ul class="saved-films">${saved}</ul></section>` : '';
  const initial = initialSection || (r2.status === 'ready' ? 'film' : stripe.status === 'ready' ? 'storage' : 'payments');
  return workspacePage('Filmmaker setup', csrf, `<div class="workspace-intro"><h1>Filmmaker setup</h1>
      ${filmmaker.name ? `<p class="account">Signed in as ${escapeHtml(filmmaker.name)}</p>` : ''}</div>
      ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${notice ? `<div class="feedback" role="status">${escapeHtml(notice)}</div>` : ''}
      ${sectionTabs('Setup sections', initial, [
        { id: 'payments', name: 'Payments', content: stripeCard(stripe, csrf) +
          (['ready', 'pending'].includes(stripe.status) ? (r2.status === 'ready' ? '<a href="#film">Continue to film</a>' : '<a href="#storage">Continue to storage</a>') : '') },
        { id: 'storage', name: 'Storage', content: storageCard(r2, draft, csrf) +
          (r2.status === 'ready' ? '<a href="#film">Continue to film</a>' : '') },
        { id: 'film', name: 'Film', content: filmHTML + library }
      ])}`);
}

export function workspacePage(title, csrf, content, { dashboard = false } = {}) {
  const current = ' aria-current="page"';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    <title>${escapeHtml(title)} · Stream</title><link rel="stylesheet" href="/setup/style.css">
    <script type="module" src="/setup/navigation.js"></script>${dashboard ? '<script src="/setup/dashboard.js" defer></script>' : ''}</head>
    <body><a class="skip" href="#main">Skip to content</a>
    <header class="masthead"><div class="bar"><strong class="brand">Stream</strong>
      <form method="post" action="/setup/sign-out">${hidden('csrf', csrf)}
      <button class="sign-out" type="submit">Sign out</button></form></div>
      <nav class="workspace-nav" aria-label="Filmmaker workspace"><div class="tab-bar">
        <a href="/setup/dashboard"${dashboard ? current : ''}>Film dashboard</a>
        <a href="/setup"${dashboard ? '' : current}>Filmmaker setup</a>
      </div></nav></header>
    <main class="setup-shell" id="main" tabindex="-1">${content}</main></body></html>`;
}

const statsLabels = { previews: 'Preview starts', plays: 'Paid plays', rentals: 'Rentals', purchases: 'Purchases',
  gross: 'Test payments', refunded: 'Refunds' };
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function statsList(stats) {
  return '<dl class="film-stats">' + Object.entries(statsLabels).map(([key, label]) =>
    `<div><dt>${label}</dt><dd>${['gross', 'refunded'].includes(key) ? usd.format(stats[key] / 100) : stats[key]}</dd></div>`
  ).join('') + '</dl>';
}

export function renderDashboard({ csrf, owner, error, films, origin }) {
  const totals = Object.fromEntries(Object.keys(statsLabels).map(key => [key, films.reduce((total, film) => total + film.stats[key], 0)]));
  const cards = films.map(film => {
    const url = origin + '/embed/' + encodeURIComponent(film.id);
    const embed = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(film.title)}" width="640" height="480" style="width:100%;border:0" allow="autoplay; payment; fullscreen" allowfullscreen></iframe>`;
    const share = film.published ? `<div class="film-sharing"><a href="${escapeHtml(url)}">Open public player</a>
      <label>Embed code<textarea readonly rows="3">${escapeHtml(embed)}</textarea></label>
      <div class="film-actions"><button class="secondary copy-embed" type="button">Copy embed code</button><span class="copy-status" role="status"></span></div></div>` : '';
    const terms = film.published ? 'Unpublishing closes the preview and new sales. Existing viewers retain paid access.' :
      'Publishing makes this film available to viewers and allows other sites to embed it.';
    return `<article class="film-card dashboard-film" id="${escapeHtml(film.id)}">
      <header><h2>${escapeHtml(film.title)}</h2><p>${film.published ? 'Published' : 'Private'} · ${formatDuration(film.duration)}</p></header>
      ${statsList(film.stats)}${priceEditor(film, csrf, '/setup/dashboard/settings')}${share}
      <form class="film-publication" action="/setup/dashboard/publication" method="post">${hidden('csrf', csrf)}${hidden('filmId', film.id)}
        <p class="hint">${terms}</p><button type="submit" class="${film.published ? 'secondary' : 'primary'}" name="visibility" value="${film.published ? 'private' : 'public'}">
          ${film.published ? 'Unpublish film' : 'Publish film'}</button></form></article>`;
  }).join('');
  const overview = `<section class="film-card"><h2>All films</h2>${statsList(totals)}
    <p class="hint">Counts include repeat viewings. Sales are final. Test payments show settled viewer orders before fees and refunds. Refunds show amounts returned through Stripe.</p>
    <a href="/setup#payments">Payment settings</a></section>`;
  return workspacePage('Film dashboard', csrf, `<div class="workspace-intro"><h1>Film dashboard</h1>
    <p class="account">Signed in as ${escapeHtml(owner)}</p></div>
    ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
    ${sectionTabs('Dashboard sections', 'films', [
      { id: 'films', name: 'Films', content: `<div class="film-actions"><a class="primary-link" href="/setup#film">Add a film</a></div>` +
        (cards || '<p>You have no saved films yet. Add your first film to publish it here.</p>') },
      { id: 'overview', name: 'Overview', content: overview }
    ])}`, { dashboard: true });
}
