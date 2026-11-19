import { stripeBusinessCountries } from './setup-stripe.js';
import { renderR2Card, renderStripeCard } from '@dustwave/admin-shell/provider-setup';

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
  let description = stripe.mode === 'test' ? 'Use your Stripe test account to set up rental payments.' : 'Connect Stripe to accept rental payments.';
  if (!stripe.configured) description = 'You can connect storage and preview a film while Dust Wave configures Stripe.';
  else if (ready) description = stripe.businessName ? `Payments account for ${stripe.businessName}.` : `Your Stripe account is ready for ${payments}.`;
  else if (stripe.status === 'pending') description = 'Stripe is reviewing your information. You can prepare your film while you wait.';
  else if (stripe.status === 'unavailable') description = 'Check the connection again. If Stripe asks, reconnect the same account.';
  else if (stripe.reason) description = stripe.reason;

  return renderStripeCard({
    title: 'Get paid with Stripe',
    status: stripe.configured ? (statuses[stripe.status] || 'Not connected') : 'Payments setup unavailable',
    description, csrfToken: csrf, ready, existingOAuth: stripe.existingAvailable === true,
    resume: stripe.hasAccount === true || stripe.creating === true,
    action: stripe.configured ? '/setup/stripe/start' : undefined,
    checkAction: stripe.configured && stripe.hasAccount ? '/setup/stripe/check' : undefined
  });
}

function storageCard(r2, draft, csrf) {
  const connected = r2.status === 'ready';
  const jurisdiction = draft.jurisdiction ?? r2.jurisdiction;
  return renderR2Card({
    title: 'Store your film on Cloudflare',
    status: connected ? 'Connected' : r2.status === 'error' ? 'Check connection' : 'Not connected',
    description: connected ? `Stream verified read access to the bucket ${r2.bucket}.` :
      'Connect a private R2 bucket in your Cloudflare account. Your film stays in that bucket.',
    action: '/setup/r2', csrfToken: csrf, connected,
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

function filmSection({ r2, rights, film, draft, csrf }) {
  const fields = hidden('csrf', csrf) + hidden('draftId', draft.id);
  if (film) {
    const duration = formatDuration(film.duration);
    const preview = privatePreview(film.previewPath) ?
      `<a class="primary-link" href="${escapeHtml(film.previewPath)}">Watch private preview</a>` : '';
    return `<h2>${escapeHtml(film.title)}</h2><p>Private film${duration ? ' · ' + duration : ''}</p>
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
      <p>The current player supports films up to 1 GiB and four hours long. For the ten-second preview, choose a film longer than ten seconds.</p>
    </details>
    <form method="post" action="/setup/film">${fields}
      <label for="film-title">Film title</label><input id="film-title" name="title" type="text" maxlength="160" required value="${escapeHtml(draft.title)}">
      <label for="object-key">Object key</label><input id="object-key" name="objectKey" type="text" maxlength="1024" spellcheck="false"
        autocapitalize="none" required aria-describedby="object-hint" value="${escapeHtml(draft.objectKey)}">
      <p class="hint" id="object-hint">For example, films/My Feature.mp4. Copy the spelling and spaces exactly.</p>
      <div class="film-actions"><button type="submit">Check film and create preview</button>
        <button class="secondary" type="submit" name="intent" value="save" formnovalidate>Save draft</button></div>
    </form>`;
}

export function renderSetupPage({ filmmaker = {}, csrf, stripe = {}, r2 = {}, rights = {}, film, films = [], draft = {}, error, notice }) {
  const filmHTML = `<section class="film-card" id="film">${filmSection({ r2, rights, film, draft, csrf })}</section>`;
  const saved = !film && films.length ? films.filter(item => privatePreview(item.previewPath)).map(item =>
    `<li><a href="${escapeHtml(item.previewPath)}">${escapeHtml(item.title)}</a></li>`).join('') : '';
  const library = saved ? `<section class="film-card"><h2>Saved films</h2><ul>${saved}</ul></section>` : '';
  const connections = `<div id="payments">${stripeCard(stripe, csrf)}</div>
    <div id="storage">${storageCard(r2, draft, csrf)}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="same-origin">
    <title>Filmmaker setup · Dust Wave Stream</title><link rel="stylesheet" href="/setup/style.css"></head>
    <body><a class="skip" href="#main">Skip to setup</a>
    <header class="masthead"><div class="bar"><span class="brand">Dust Wave <strong>Stream</strong></span>
      <form method="post" action="/setup/sign-out">${hidden('csrf', csrf)}
      <button class="sign-out" type="submit">Sign out</button></form></div></header>
    <main id="main" tabindex="-1">
      <h1>Filmmaker setup</h1>
      ${filmmaker.name ? `<p class="account">Signed in as ${escapeHtml(filmmaker.name)}</p>` : ''}
      <nav class="section-links" aria-label="Setup sections"><a href="#payments">Payments</a>
        <a href="#storage">Storage</a><a href="#film">Film</a></nav>
      ${error ? `<div class="feedback error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${notice ? `<div class="feedback" role="status">${escapeHtml(notice)}</div>` : ''}
      ${r2.status === 'ready' ? filmHTML + library + connections : connections + filmHTML + library}
    </main></body></html>`;
}
