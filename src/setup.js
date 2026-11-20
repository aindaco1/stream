import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorDirectory } from './operator.js';
import { openFilm } from './media.js';
import { filmPrices, priceFromInput, previewSeconds, rentalHours } from './prices.js';
import { createPublicFilms } from './public-films.js';
import { checkR2Bucket, createR2Source } from './source.js';
import { guidedBucketForm, parseR2BucketUrl, R2SetupError } from './setup-r2.js';
import { openSetupStore } from './setup-store.js';
import { createViewerCheckout } from './viewer-checkout.js';
import { createStripeSetup, StripeSetupError, stripeSetupStateForMode } from './setup-stripe.js';
import { escapeHtml, renderBucketAccess, renderDashboard, renderSetupPage, renderStripeCountryForm, renderStripeReset, workspacePage } from './setup-view.js';

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; form-action 'self' https://*.stripe.com; frame-ancestors 'none'; base-uri 'none'";
const commonHeaders = { 'Content-Security-Policy': csp, 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex' };
const previewPattern = /^\/setup\/preview\/(f-[a-f0-9-]{36})(\/clip\.mp4)?$/;
const callbackPattern = /^\/setup\/stripe\/(oauth|refresh|return)$/;
const rightsVersion = 'film-distribution-v1';
const rightsStatement = 'I own this film or have permission to distribute it through Dust Wave Stream.';

class SetupError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function signInPage(message = '') {
  const feedback = message ? '<p role="alert">' + escapeHtml(message) + '</p>' : '';
  return workspacePage('Filmmaker sign-in', null, '<h1>Filmmaker sign-in</h1>' + feedback + '<p>Open the private invitation from Dust Wave, or paste your one-time code below. Returning filmmakers can request a fresh invitation to the same workspace.</p>' +
    '<form method="post" action="/setup/sign-in"><label>Invitation code <input name="code" type="password" required autocomplete="one-time-code" maxlength="64"></label> ' +
    '<button type="submit">Open filmmaker setup</button></form>');
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

function settingsForm(data, saved) {
  const read = (name, validate) => data[name] === undefined ? validate(saved[name]) :
    /^\d{1,3}$/.test(data[name]) ? validate(Number(data[name])) : null;
  const seconds = read('previewSeconds', previewSeconds), hours = read('rentalHours', rentalHours);
  if (seconds === null || (saved.duration && seconds >= saved.duration)) {
    throw new SetupError('Choose 0 to 30 seconds for the free preview. The preview must be shorter than the film.', 422);
  }
  if (hours === null) throw new SetupError('Choose a rental duration from 1 to 720 whole hours.', 422);
  const prices = data.buyPrice === undefined && data.rentPrice === undefined ? filmPrices(saved.prices) : priceForm(data);
  if (!prices) throw new SetupError('Check the film prices.', 422);
  return { prices, previewSeconds: seconds, rentalHours: hours };
}

function viewerOrigin(env, origin) {
  const value = env.STREAM_VIEWER_ORIGIN || (new URL(origin).protocol === 'http:' ? 'http://127.0.0.1:8793' : origin);
  const url = new URL(value);
  if (url.origin !== value || !(url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid viewer origin.');
  return url.origin;
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
  directory = join(operatorDirectory(), 'filmmakers'), stripe, viewerCheckout, env = process.env,
  sourceFor = createR2Source, checkBucket = checkR2Bucket, resolveBucket = guidedBucketForm
} = {}) {
  const style = await readFile(new URL('../public/setup.css', import.meta.url));
  const darkStyle = await readFile(new URL('../public/setup-dark.css', import.meta.url));
  const scripts = new Map(await Promise.all(Object.entries({
    '/setup/appearance.js': new URL(import.meta.resolve('@dustwave/admin-shell/appearance-browser')),
    '/setup/dashboard.js': new URL('../public/setup-dashboard.js', import.meta.url),
    '/setup/navigation.js': new URL('../public/setup-navigation.js', import.meta.url),
    '/setup/tabs.js': new URL(import.meta.resolve('@dustwave/admin-shell/tabs')),
    '/setup/tabs-browser.js': new URL(import.meta.resolve('@dustwave/admin-shell/tabs-browser'))
  }).map(async ([route, file]) => [route, await readFile(file)])));
  const store = openSetupStore(directory);
  const checkout = viewerCheckout ?? createViewerCheckout({store,env});
  const publications = createPublicFilms({ store, env, sourceFor });
  const busy = new Set();
  const activePreviews = new Map();

  async function inspect(owner, bucket, objectKey, expectedRevision, seconds = 10) {
    const film = await openFilm(sourceFor({ ...store.credentials(owner, bucket), objectKey }), { previewSeconds: seconds });
    try {
      if (expectedRevision && film.revision !== expectedRevision) throw new Error('The original changed.');
      if (seconds >= film.duration) throw new SetupError('Choose a free preview shorter than this film, or set the preview to 0.', 422);
      const preview = seconds ? await film.preview() : null;
      if (!seconds) await film.segment(0);
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
        initialSection: path.startsWith('/setup/stripe/') ? 'payments' : path.startsWith('/setup/r2') ? 'storage' :
          ['/setup/film', '/setup/film/prices', '/setup/rights', '/setup/next'].includes(path) ? 'film' : undefined,
        stripe: { configured: provider.configured, mode, existingAvailable: provider.existingOAuth, hasAccount: Boolean(state.accountId), creating: Boolean(state.createRequest),
          canReset: Boolean(state.accountId || state.flow || state.createRequest),
          status: state.status || 'unconnected', reason: state.reason, businessName: state.businessName || state.accountId, checkedAt: state.checkedAt },
        r2: r2 ? { ...r2, status: 'ready' } : { status: 'unconnected' },
        rights: { accepted: Boolean(draft.rights), statement: rightsStatement }, draft: { ...draft, ...store.storageDraft(session.owner) },
        films: store.films(session.owner).map(row => ({ ...row, previewPath: '/setup/preview/' + row.id })),
        film: film && { id: film.id, title: film.title, prices: film.prices, duration: film.duration, previewSeconds: film.previewSeconds,
          rentalHours: film.rentalHours, previewPath: '/setup/preview/' + draft.id }, ...feedback
      }));
    };
    if (get && path === '/setup/style.css') return send(200, 'text/css', style, commonHeaders);
    if (get && path === '/setup/dark.css') return send(200, 'text/css', darkStyle, commonHeaders);
    if (get && scripts.has(path)) return send(200, 'text/javascript', scripts.get(path), commonHeaders);
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
      if (get && (path === '/setup' || path === '/setup/dashboard')) return redirect('/setup/sign-in');
      if (get && callbackPattern.test(path)) return html(401, signInPage('Your Stream session has ended. Sign in again and continue from the Stripe card.'));
      return reject(401, 'Sign in to your filmmaker workspace.');
    }
    if (get && path === '/setup') return display();
    const owner = session.owner;
    const step = (title, inner) => workspacePage(title, session.csrf, '<h1>' + escapeHtml(title) + '</h1>' + inner);
    const dashboard = (status = 200, error) => html(status, renderDashboard({ csrf: session.csrf, owner, error,
      origin: viewerOrigin(env, origin), films: store.dashboardFilms(owner).map(film => ({
        ...film, published: publications.isPublished(owner, film.id)
      })) }));
    if (get && path === '/setup/dashboard') return dashboard();
    if (get && path === '/setup/stripe/reset') {
      const { state, confirmation } = store.stripeContext(owner, mode);
      if (!state.accountId && !state.flow && !state.createRequest) return redirect('/setup#payments');
      return html(200, step('Reset Stripe connection', renderStripeReset(session.csrf, mode, state, confirmation)));
    }
    const bucketAccess = (status, location, error) => html(status, step('Connect your private bucket', renderBucketAccess(session.csrf, location, error)));
    if (get && path === '/setup/r2/access') {
      const location = store.storageDraft(owner);
      return location ? bucketAccess(200, location) : redirect('/setup#storage');
    }
    if (get && preview) {
      const film = store.film(owner, preview[1]);
      const seconds = film && previewSeconds(film.previewSeconds);
      if (!film || !seconds) return reject(404, 'Preview unavailable.');
      if (!preview[2]) return html(200, step(film.title, '<p>Private ' + seconds + '-second preview</p><video controls playsinline preload="metadata" src="' +
        path + '/clip.mp4"></video><p><a href="/setup#film">Back to filmmaker setup</a></p>'));
      const key = film.id + '/' + seconds;
      if (!activePreviews.has(key)) {
        activePreviews.set(key, inspect(owner, film.bucket, film.objectKey, film.revision, seconds).finally(() => activePreviews.delete(key)));
      }
      try { return sendMp4((await activePreviews.get(key)).preview, commonHeaders); }
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
      const { r2, draft } = store.maker(owner);
      if (callback || path === '/setup/stripe/start' || path === '/setup/stripe/check') {
        const ctx = store.stripeContext(owner, mode);
        const result = callback ? await provider.callback(ctx, callback[1], searchParams) :
          path === '/setup/stripe/start' ? await provider.start(ctx, data.mode, data.country) : await provider.refresh(ctx);
        if (result?.countryRequired) return html(200, step('Choose your business country', renderStripeCountryForm(session.csrf, data.mode)));
        return redirect(result?.redirect || '/setup#payments');
      }
      if (path === '/setup/stripe/reset') {
        if (!store.resetStripe(owner, mode, data.confirmation)) {
          throw new SetupError('The Stripe connection changed. Review the current connection before resetting it.', 409);
        }
        if (mode === 'test' && await checkout.closeWithdrawnSessions(owner)) {
          return display(200, { notice: 'Stripe was reset. Stream is closing unfinished checkouts and will retry automatically.' });
        }
        return redirect('/setup#payments');
      }
      if (['/setup/r2', '/setup/r2/location', '/setup/r2/access'].includes(path)) {
        const guided = path !== '/setup/r2';
        const location = guided ? parseR2BucketUrl(data.bucketUrl) : bucketForm(data);
        const { accountId, bucket, jurisdiction } = location;
        store.saveStorageDraft(owner, { accountId, bucket, jurisdiction });
        if (path === '/setup/r2/location') return redirect('/setup/r2/access');
        let config;
        try {
          config = guided ? await resolveBucket(data) : location;
          await checkBucket(config);
        } catch (error) {
          const message = error instanceof R2SetupError ? error.message :
            'Cloudflare could not verify access. Check the selected bucket, jurisdiction and token, then try again.';
          const code = error instanceof R2SetupError ? error.statusCode : 422;
          if (guided) return bucketAccess(code, location, message);
          throw new SetupError(message, code);
        }
        store.saveBucket(owner, config);
        return redirect('/setup#storage');
      }
      if (['/setup/film/prices', '/setup/dashboard/settings', '/setup/dashboard/publication'].includes(path)) {
        const saved = store.film(owner, data.filmId || '');
        if (!saved) throw new SetupError('Saved film unavailable.', 404);
        if (path === '/setup/dashboard/publication') {
          if (data.visibility === 'private') {
            store.setFilmPublication(owner, saved.id, false);
            if (await checkout.closeWithdrawnSessions(owner,saved.id)) {
              throw new SetupError('Your film is private. Stripe is still closing unfinished checkouts. Stream will retry automatically.',503);
            }
          }
          else if (data.visibility === 'public') {
            try { await publications.publish(owner, saved.id); }
            catch { throw new SetupError('Publishing requires a ready Stripe test account, confirmed rights and access to the saved original in R2. Check your connections and try again.', 422); }
          } else throw new SetupError('Choose whether to publish this film.');
        } else store.setFilmSettings(owner, saved.id, settingsForm(data, saved));
        return redirect(path.startsWith('/setup/dashboard/') ? '/setup/dashboard#' + saved.id : '/setup#film');
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
        const settings = settingsForm(data, draft);
        store.saveDraft(owner, { ...draft, title, objectKey, ...settings });
        if (saving) return display(200, { notice: 'Draft saved. You can return to this film any time.' });
        let film;
        try { film = await inspect(owner, r2, objectKey, undefined, settings.previewSeconds); }
        catch (error) {
          if (error instanceof SetupError) throw error;
          throw new SetupError('Stream could not read this film. Check the exact object key, read access and supported MP4 settings below. You can retry this film.', 422);
        }
        store.saveFilm(owner, r2, { id: draft.id, title, objectKey, ...settings, rights: draft.rights, duration: film.duration, revision: film.revision });
      }
      return redirect('/setup#film');
    } catch (e) {
      if (path.startsWith('/setup/dashboard/')) return dashboard(e instanceof SetupError ? e.statusCode : 503,
        e instanceof SetupError ? e.message : 'This change could not finish. Try again.');
      if (e instanceof SetupError || e instanceof StripeSetupError || e instanceof R2SetupError) return display(e.statusCode || 400, { error: e.message });
      return display(503, { error: 'This step could not finish. Your completed steps are saved. Try again.' });
    } finally { busy.delete(owner); }
  }
  return { handle, store, close: () => store.close() };
}
