import { privacyPage } from '../src/privacy-policy.js';
import playerTemplate from '../public/player.html';
import { examplePath, exampleResponse } from '../src/example-checkout.js';
import { exampleHeaders, examplePlayer } from '../src/player-page.js';
import { rangeFor } from '../src/http-range.js';
import { filmmakerSettings, filmmakerDashboard, workspaceCsp, dashboardCsp } from '../src/filmmaker-pages.js';
import { stripeSetupConfiguration } from '../src/setup-stripe.js';
import { workspaceAssets } from '../src/workspace-assets.js';
import { filmmakerHome } from '../src/filmmaker-home.js';
import { verifyTurnstile } from '@dustwave/worker-core/turnstile';
import { readBoundedText } from '@dustwave/worker-core/response-body';
import { accessPage, accessPath, handleAccess, headerSession, readSessionCookie, sessionCookie, signInPath, signUpPath } from '../src/workspace-access.js';
import { headerSessionPath, workspacePage } from '../src/workspace-page.js';
import { agreementModeForPath, renderFilmmakerAgreement } from '../src/filmmaker-agreement.js';
import { renderFilmmakerFaq } from '../src/filmmaker-help.js';
import { liveSalesTerritory } from '../src/marketplace-checkout.js';
import { streamSender } from '../src/stream-email.js';
import { escapeHtml } from '../src/film-embed.js';
import { renderPlatformDashboard } from '../src/setup-view.js';

const csp =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const pilotNotice = 'Sign-ups are open. Film uploads and paid screenings are being prepared.';
export const hostedViewerOrigin = 'https://watch.streamyourfilm.com';
const privatePages = new Set(['/setup/admin', '/setup/dashboard', '/setup/settings']);

// Some asset bindings return the entire file for a byte-range request. Safari
// starts video playback with a two-byte probe. Only the fixed home sample needs this fallback.
async function homeExcerpt(request, assets) {
  const asset = await assets.fetch(request);
  const range = request.headers.get('Range');
  if (request.method !== 'GET' || asset.status !== 200 || !range) return asset;
  const validator = request.headers.get('If-Range');
  if (validator && validator !== asset.headers.get('ETag') && validator !== asset.headers.get('Last-Modified')) return asset;
  const bytes = await asset.arrayBuffer();
  const bounds = rangeFor(range, bytes.byteLength);
  if (!bounds) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + bytes.byteLength } });
  const [start, end] = bounds;
  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

// Static files bypass both Durable Objects. Account pages run beside their SQLite data.
export function routeWorkspace(request, env, { signupOnly = false } = {}) {
  const url = new URL(request.url);
  if (url.origin !== env.STREAM_PUBLIC_ORIGIN) return new Response('Unknown host.', { status: 404 });
  const path = url.pathname;
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (read && Object.hasOwn(workspaceAssets, path)) {
    return path === '/market-street-excerpt.mp4' ? homeExcerpt(request, env.ASSETS) : env.ASSETS.fetch(request);
  }
  if (read && path === examplePath) return new Response(request.method === 'HEAD' ? null : examplePlayer(playerTemplate), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', ...exampleHeaders }
  });
  if (path.startsWith(examplePath + '/')) return exampleResponse(request, env);
  const page = read && (privatePages.has(path) || agreementModeForPath(path) ||
    ['/', '/privacy', '/setup', '/setup/home', headerSessionPath, '/faq', '/setup/faq', '/setup/admin/faq'].includes(path));
  const signOut = request.method === 'POST' && (path === '/setup/sign-out' || path === '/setup/admin/sign-out');
  if (signupOnly || page || signOut || accessPath(path)) return env.STREAM_STORE.getByName('pilot-live').workspace(request);
}

export async function workspaceResponse(
  request,
  env,
  ctx,
  store,
  { verifyChallenge = verifyTurnstile, mailFetch = fetch } = {}
) {
  const url = new URL(request.url);
  const origin = env.STREAM_PUBLIC_ORIGIN;
  if (url.origin !== origin) return new Response('Unknown host.', { status: 404 });
  const { pathname: path } = url;
  const get = ['GET', 'HEAD'].includes(request.method);
  if (get && path === headerSessionPath) {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(headerSession(store, request.headers.get('cookie'), true)), {
      headers: {'Content-Type':'application/json', 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
        'Cross-Origin-Resource-Policy':'same-origin'}
    });
  }
  const admins = path === '/setup/admin' || path.startsWith('/setup/admin/');
  const audience = admins ? 'admin' : 'filmmaker';
  const base = admins ? '/setup/admin' : '/setup';
  const cookie = (value, age) => sessionCookie(value, age, audience, true);
  const id = readSessionCookie(request.headers.get('cookie'), audience, true);
  const session = store.session(id, audience);
  const response = (status, content, extra = {}) =>
    new Response(request.method === 'HEAD' ? null : content, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-Robots-Tag': 'noindex',
        ...extra
      }
    });
  if (get && path === '/privacy') return response(200, privacyPage());
  const redirect = (path, headers) => response(303, '', { Location: path, ...headers });
  const reject = (status, msg) => response(status, msg, { 'Content-Type': 'text/plain; charset=utf-8' });
  const formData = async () => {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
      throw Error('Invalid form.');
    const data = new URLSearchParams(await readBoundedText(request, 8192));
    if (new Set(data.keys()).size !== data.size) throw Error('Duplicate form fields.');
    return Object.fromEntries(data);
  };
  if (request.method === 'POST' && request.headers.get('origin') !== origin)
    return reject(403, 'Open the form on Stream.');
  if (get && ['/faq', '/setup/faq', '/setup/admin/faq'].includes(path)) {
    return response(
      200,
      workspacePage('FAQ', session?.csrf, renderFilmmakerFaq('live', env.STREAM_WORKSPACE_PHASE === 'full' ? liveSalesTerritory(env.STREAM_SALES_TERRITORIES) : 'closed'), { faq: true, admin: admins })
    );
  }
  const edition = agreementModeForPath(path);
  if (get && edition)
    return response(
      200,
      workspacePage('Filmmaker agreement', session?.csrf, renderFilmmakerAgreement(edition), { reference: true })
    );
  const from = streamSender(env);
  const testWidget = [env.STREAM_TURNSTILE_SITE_KEY, env.STREAM_TURNSTILE_SECRET_KEY].some((value) =>
    /^[123]x0{10,}/.test(value || '')
  );
  const siteKey = !testWidget && from && env.STREAM_TURNSTILE_SECRET_KEY && env.STREAM_TURNSTILE_SITE_KEY;
  const signup = accessPath(path) === signUpPath;
  const showAccess = (status, message, error) =>
    response(status, accessPage({ signup, siteKey, message, error, mode: 'live', pilotNotice:env.STREAM_WORKSPACE_PHASE === 'full' ? '' : pilotNotice }));
  if (get && path === '/') return response(200, filmmakerHome(), {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; frame-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
  if (get && path === '/setup' && env.STREAM_WORKSPACE_PHASE === 'full') return redirect(session ? '/setup/settings' : '/setup/home');
  if (get && ['/setup/home', '/setup'].includes(path))
    return redirect(session ? '/setup/dashboard' : '/');
  if (accessPath(path))
    return handleAccess({
      path,
      method: request.method,
      get,
      origin,
      env,
      store,
      mode: 'live',
      siteKey,
      from,
      showAccess,
      redirect,
      reject,
      formData,
      verifyChallenge,
      mailFetch,
      queue: (task) => ctx.waitUntil(task)
    });
  if (path === base + '/sign-out' && request.method === 'POST') {
    let form;
    try {
      form = await formData();
    } catch {
      return reject(400, 'Use the sign-out form.');
    }
    if (!session || session.csrf !== form.csrf) return reject(403, 'Open the sign-out form on Stream.');
    store.signOut(id);
    return redirect(signInPath, { 'Set-Cookie': cookie('', 0) });
  }
  if (get && privatePages.has(path)) {
    const full = env.STREAM_WORKSPACE_PHASE === 'full';
    const analytics = full && request.headers.has('X-Stream-Analytics');
    if (analytics && (!session || request.headers.get('X-Stream-Analytics') !== session.csrf)) return reject(401, 'Sign in again.');
    if (!session) return redirect(signInPath);
    const headers = { 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': workspaceCsp };
    if (admins) {
      const report = store.platformReport(url.searchParams.get('maker'), Number(url.searchParams.get('page') || 1));
      if (!report) return reject(404, 'Filmmaker unavailable.');
      const markup = renderPlatformDashboard(session.csrf, report, analytics, full);
      return response(200, markup, { ...headers, 'Content-Security-Policy': workspaceCsp + "; connect-src 'self'",
        ...(analytics && { 'X-Stream-Analytics': '1' }) });
    }
    const dashboard = path === '/setup/dashboard';
    if (full) {
      if (dashboard) headers['Content-Security-Policy'] = dashboardCsp(hostedViewerOrigin);
      if (dashboard && analytics) headers['X-Stream-Analytics'] = '1';
      if (request.method === 'HEAD') return response(200, null, headers);
      const markup = dashboard
        ? filmmakerDashboard({ store, session, searchParams: url.searchParams, viewer: hostedViewerOrigin, metricsOnly: analytics })
        : filmmakerSettings({ store, session, path, searchParams: url.searchParams,
          provider: stripeSetupConfiguration(env, origin, 'live'), salesTerritory: liveSalesTerritory(env.STREAM_SALES_TERRITORIES) });
      return response(200, markup, headers);
    }
    const heading = dashboard ? 'Dashboard' : 'Settings';
    return response(
      200,
      workspacePage(
        heading,
        session.csrf,
        '<h1>' +
          heading +
          '</h1><p>Signed in as ' +
          escapeHtml(session.email) +
          '.</p><p>Your workspace is ready. Film uploads and paid screenings will open when the media service is available.</p><p><a href="/faq">Read the filmmaker FAQ</a></p>',
        { dashboard }
      )
    );
  }
  return reject(404, 'Page unavailable.');
}
