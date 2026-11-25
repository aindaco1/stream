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
const assets =
  /^\/(?:favicon\.ico|favicon\.svg|apple-touch-icon\.png|dust-wave-square\.webp|site-frame\.css|play-excerpt\.js|filmmaker-home\.css|market-street-(?:still\.webp|excerpt\.mp4)|filmmaker(?:-dark)?\.css|appearance\.js|select-focus\.js|setup\/(?:field-help|header-session|navigation|tabs|tabs-browser|analytics-refresh|sign-in|turnstile-size)\.js)$/;

// Public identity and information share one owner in both deployment stages.
// Route these before starting a container, including one-time form submissions.
export function isPublicWorkspaceRequest(request) {
  const path = new URL(request.url).pathname;
  if (accessPath(path)) return true;
  if (request.method === 'POST') return path === '/setup/sign-out' || path === '/setup/admin/sign-out';
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return assets.test(path) || Boolean(agreementModeForPath(path)) ||
    ['/', '/setup/home', headerSessionPath, '/faq', '/setup/faq', '/setup/admin/faq'].includes(path);
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
  if (get && assets.test(path)) return env.ASSETS.fetch(request);
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
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
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
  if (['/setup/admin', '/setup/dashboard', '/setup/settings'].includes(path) && get) {
    if (!session) return redirect(signInPath);
    if (admins) {
      const report = store.platformReport(
        url.searchParams.get('maker'),
        Number(url.searchParams.get('page') || 1)
      );
      if (!report) return reject(404, 'Filmmaker unavailable.');
      return response(200, renderPlatformDashboard(session.csrf, report));
    }
    const dashboard = path === '/setup/dashboard';
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
