import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorDirectory } from './operator.js';
import { openFilm } from './media.js';
import { filmPrices, priceFromInput } from './prices.js';
import { checkR2Bucket, createR2Source } from './source.js';
import { openSetupStore } from './setup-store.js';
import { createStripeSetup, StripeSetupError, stripeSetupStateForMode } from './setup-stripe.js';
import { escapeHtml, renderSetupPage, renderStripeCountryForm } from './setup-view.js';

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; form-action 'self' https://*.stripe.com; frame-ancestors 'none'; base-uri 'none'";
const commonHeaders = { 'Content-Security-Policy': csp, 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex' };
const previewPattern = /^\/setup\/preview\/(f-[a-f0-9-]{36})(\/clip\.mp4)?$/;
const callbackPattern = /^\/setup\/stripe\/(oauth|refresh|return)$/;
const rightsVersion = 'film-distribution-v1';
const rightsStatement = 'I own this film or have permission to distribute it through Dust Wave Stream.';

class SetupError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function page(title, inner, script = '') {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="/setup/style.css"><title>' + escapeHtml(title) + ' · Stream</title></head><body><main class="setup-shell"><h1>' +
    escapeHtml(title) + '</h1>' + inner + '</main>' + script + '</body></html>';
}

function signInPage(message = '') {
  const feedback = message ? '<p role="alert">' + escapeHtml(message) + '</p>' : '';
  return page('Filmmaker sign-in', feedback + '<p>Open the private invitation from Dust Wave, or paste your one-time code below. Returning filmmakers can request a fresh invitation to the same workspace.</p>' +
    '<form method="post" action="/setup/sign-in"><label>Invitation code <input name="code" type="password" required autocomplete="one-time-code" maxlength="64"></label> ' +
    '<button type="submit">Open filmmaker setup</button></form>', '<script src="/setup/sign-in.js" defer></script>');
}

async function readForm(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new SetupError('Use the setup form.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new SetupError('The form is too large.', 413);
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString());
  if ([...fields.keys()].length !== new Set(fields.keys()).size) throw new SetupError('Submit one value for each field.');
  return Object.fromEntries(fields);
}

function priceForm(data) {
  const prices = filmPrices({ rent: priceFromInput(data.rentPrice), buy: priceFromInput(data.buyPrice) });
  if (!prices) throw new SetupError('Enter USD prices from $0.50 to $999,999.99 with up to two decimal places, or leave an option blank.', 422);
  return prices;
}

function bucketForm(data) {
  const { accountId = '', bucket = '', jurisdiction = 'default', accessKeyId = '', secretAccessKey = '' } = data;
  if (!/^[a-f0-9]{32}$/i.test(accountId.trim()) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket.trim()) ||
      !['default', 'eu', 'us', 'fedramp'].includes(jurisdiction)) throw new SetupError('Check the account ID, exact bucket name and jurisdiction in Cloudflare.');
  if (![accessKeyId, secretAccessKey].every(v => /^\S{8,256}$/.test(v.trim()))) throw new SetupError('Paste both values from the R2 token screen.');
  if (data.privateConfirmed !== 'yes') throw new SetupError('Confirm the private bucket and its read-only token before connecting.');
  return { accountId: accountId.trim().toLowerCase(), bucket: bucket.trim(), jurisdiction, accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
}

export async function createSetup({
  directory = join(operatorDirectory(), 'filmmakers'), stripe, env = process.env,
  sourceFor = createR2Source, checkBucket = checkR2Bucket
} = {}) {
  const style = await readFile(new URL('../public/setup.css', import.meta.url));
  const store = openSetupStore(directory);
  const busy = new Set();
  const activePreviews = new Map();

  async function inspect(owner, bucket, objectKey, expectedRevision) {
    const film = await openFilm(sourceFor({ ...store.credentials(owner, bucket), objectKey }));
    try {
      if (expectedRevision && film.revision !== expectedRevision) throw new Error('The original changed.');
      const preview = await film.preview();
      return { revision: film.revision, duration: film.duration, preview };
    } finally { film.close(); }
  }

  async function handle(req, { path, origin, send, sendMp4 }) {
    const { searchParams } = new URL(req.url, origin);
    const redirect = (to, extra = {}) => send(303, 'text/plain', '', { ...commonHeaders, ...extra, Location: to });
    const html = (status, markup) => send(status, 'text/html; charset=utf-8', markup, commonHeaders);
    const reject = (status, message) => send(status, 'text/plain; charset=utf-8', message, commonHeaders);
    const method = req.method;
    const get = method === 'GET' || method === 'HEAD';
    const secure = origin.startsWith('https:');
    const cookieName = secure ? '__Secure-stream_setup' : 'stream_setup';
    const cookie = (value, age) => cookieName + '=' + value + '; Path=/setup; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
    const sessionId = req.headers.cookie?.split(/;\s*/).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const session = store.session(sessionId);
    const provider = stripe ?? createStripeSetup({ env, origin });
    const mode = env.STRIPE_CONNECT_LIVE === '1' ? 'live' : 'test';
    const display = (status = 200, feedback = {}) => {
      const { r2, stripe: savedStripe, draft } = store.maker(session.owner);
      const state = stripeSetupStateForMode(savedStripe, mode);
      const film = store.film(session.owner, draft.id);
      return html(status, renderSetupPage({
        filmmaker: { name: session.owner }, csrf: session.csrf,
        stripe: { configured: provider.configured, mode, existingAvailable: provider.existingOAuth, hasAccount: Boolean(state.accountId), creating: Boolean(state.createRequest),
          status: state.status || 'unconnected', reason: state.reason, businessName: state.businessName || state.accountId, checkedAt: state.checkedAt },
        r2: r2 ? { ...r2, status: 'ready' } : { status: 'unconnected' },
        rights: { accepted: Boolean(draft.rights), statement: rightsStatement }, draft: { ...draft, ...store.storageDraft(session.owner) },
        films: store.films(session.owner).map(row => ({ id: row.id, title: row.title, prices: row.prices, previewPath: '/setup/preview/' + row.id })),
        film: film && { id: film.id, title: film.title, prices: film.prices, duration: film.duration, previewPath: '/setup/preview/' + draft.id }, ...feedback
      }));
    };
    if (get && path === '/setup/style.css') return send(200, 'text/css', style, commonHeaders);
    if (get && path === '/setup/sign-in.js') {
      return send(200, 'text/javascript', "const code=location.hash.slice(1); if(code){history.replaceState(null,'',location.pathname); if(/^[\\w-]{43}$/.test(code)) document.querySelector('[name=code]').value=code;}", commonHeaders);
    }
    if (method === 'POST' && req.headers.origin !== origin) return reject(403, 'Open the form in your Stream workspace.');
    if (path === '/setup/sign-in') {
      if (get) return html(200, signInPage());
      if (method !== 'POST') return reject(405, 'Use the sign-in form.');
      try {
        const { code } = await readForm(req);
        const id = store.signIn(code || '');
        if (!id) return html(401, signInPage('This invitation has expired or was used. Ask Dust Wave for a fresh link.'));
        return redirect('/setup', { 'Set-Cookie': cookie(id, 14 * 86400) });
      } catch (e) { return reject(e.statusCode || 400, 'Check the sign-in form and try again.'); }
    }
    const preview = previewPattern.exec(path);
    if (!session) {
      if (get && path === '/setup') return redirect('/setup/sign-in');
      if (get && callbackPattern.test(path)) return html(401, signInPage('Your Stream session has ended. Sign in again and continue from the Stripe card.'));
      return reject(401, 'Sign in to your filmmaker workspace.');
    }
    if (get && path === '/setup') return display();
    const owner = session.owner;
    if (get && preview) {
      const film = store.film(owner, preview[1]);
      if (!film) return reject(404, 'Preview unavailable.');
      if (!preview[2]) return html(200, page(film.title, '<p>Private 10-second preview</p><video controls playsinline preload="metadata" src="' +
        path + '/clip.mp4"></video><p><a href="/setup">Back to filmmaker setup</a></p>'));
      if (!activePreviews.has(film.id)) {
        activePreviews.set(film.id, inspect(owner, film.bucket, film.objectKey, film.revision).finally(() => activePreviews.delete(film.id)));
      }
      try { return sendMp4((await activePreviews.get(film.id)).preview, commonHeaders); }
      catch { return reject(409, 'The film changed or storage is unavailable. Check the original in Cloudflare.'); }
    }
    const callback = callbackPattern.exec(path);
    if (!callback && method !== 'POST') return reject(404, 'Page unavailable.');
    if (callback && method !== 'GET') return reject(405, 'Return from Stripe using the original link.');
    if (busy.has(owner)) return display(409, { error: 'A setup step is still running. Wait a moment and reload.' });
    busy.add(owner);
    try {
      const data = callback ? {} : await readForm(req);
      if (!callback && data.csrf !== session.csrf) return reject(403, 'Reload setup before submitting this form.');
      if (path === '/setup/sign-out') { store.signOut(sessionId); return redirect('/setup/sign-in', { 'Set-Cookie': cookie('', 0) }); }
      const { stripe: savedStripe, r2, draft } = store.maker(owner);
      if (callback || path === '/setup/stripe/start' || path === '/setup/stripe/check') {
        const ctx = { creatorId: owner, state: stripeSetupStateForMode(savedStripe, mode), save: () => store.saveStripe(owner, savedStripe),
          claimAccount: (accountId, mode) => store.claimAccount(owner, accountId, mode) };
        const result = callback ? await provider.callback(ctx, callback[1], searchParams) :
          path === '/setup/stripe/start' ? await provider.start(ctx, data.mode, data.country) : await provider.refresh(ctx);
        if (result?.countryRequired) return html(200, page('Choose your business country', renderStripeCountryForm(session.csrf, data.mode)));
        return redirect(result?.redirect || '/setup#payments');
      }
      if (path === '/setup/r2') {
        const config = bucketForm(data);
        store.saveStorageDraft(owner, { accountId: config.accountId, bucket: config.bucket, jurisdiction: config.jurisdiction });
        try { await checkBucket(config); }
        catch { throw new SetupError('Cloudflare could not verify access. Check the account, bucket, jurisdiction and token, then try again.', 422); }
        store.saveBucket(owner, config);
        return redirect('/setup#storage');
      }
      if (path === '/setup/film/prices') {
        if (!store.setFilmPrices(owner, data.filmId || '', priceForm(data))) throw new SetupError('Saved film unavailable.', 404);
        return redirect('/setup#film');
      }
      if (!['/setup/rights', '/setup/film', '/setup/next'].includes(path)) return reject(404, 'Page unavailable.');
      if (data.draftId !== draft.id) throw new SetupError('This tab has an older draft. Reload setup to continue.', 409);
      if (!r2) throw new SetupError('Connect your R2 bucket first.');
      const completed = store.film(owner, draft.id);
      if (path === '/setup/next') {
        if (!completed) throw new SetupError('Finish the current film before starting another.');
        store.nextDraft(owner);
      } else if (completed) {
        return redirect('/setup#film');
      } else if (path === '/setup/rights') {
        if (data.rightsAccepted !== 'yes') throw new SetupError('Confirm your distribution rights before adding this film.');
        draft.rights ??= { version: rightsVersion, statement: rightsStatement, acceptedAt: new Date().toISOString() };
        store.saveDraft(owner, draft);
      } else {
        if (!draft.rights) throw new SetupError('Confirm your distribution rights before adding this film.', 403);
        const title = (data.title || '').trim();
        const objectKey = data.objectKey || '';
        const saving = data.intent === 'save';
        if (title.length > 160 || Buffer.byteLength(objectKey) > 1024 || (!saving && (!title || !objectKey)) ||
            /[\u0000-\u001f\u007f]/u.test(title + objectKey) || (objectKey && !saving && objectKey.split('/').some(part => !part || part === '.' || part === '..'))) {
          throw new SetupError('Enter a film title and the exact object key from your bucket, including any folder.');
        }
        // Previously saved drafts and older forms retain their rental default.
        const prices = data.buyPrice === undefined && data.rentPrice === undefined ? filmPrices(draft.prices) : priceForm(data);
        if (!prices) throw new SetupError('Check the film prices.', 422);
        store.saveDraft(owner, { ...draft, title, objectKey, prices });
        if (saving) return display(200, { notice: 'Draft saved. You can return to this film any time.' });
        let film;
        try { film = await inspect(owner, r2, objectKey); }
        catch { throw new SetupError('Stream could not make a preview. Check the exact object key, read access and supported MP4 settings below. You can retry this film.', 422); }
        store.saveFilm(owner, r2, { id: draft.id, title, objectKey, prices, rights: draft.rights, duration: film.duration, revision: film.revision });
      }
      return redirect('/setup#film');
    } catch (e) {
      if (e instanceof SetupError || e instanceof StripeSetupError) return display(e.statusCode || 400, { error: e.message });
      return display(503, { error: 'This step could not finish. Your completed steps are saved. Try again.' });
    } finally { busy.delete(owner); }
  }
  return { handle, store, close: () => store.close() };
}
