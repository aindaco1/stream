import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unpack } from '../src/store-wire.js';

// Run against workerd and a disposable persistent SQL volume. All provider calls stay inside the harness.
const root = await mkdtemp(join(tmpdir(), 'stream-worker-tests-'));
const messages = [];
async function bundleWorker(entry) {
  const bundle = join(root, entry);
  // Bundle the deployed entry points without provisioning a media runtime in this test.
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', 'worker/' + entry + '.js',
    '--dry-run', '-c', 'wrangler.edge.jsonc', '--outdir', bundle], { stdio: 'pipe' });
  return { modulesRoot: bundle, modules: [
    { type: 'ESModule', path: join(bundle, entry + '.js') },
    ...(await readdir(bundle)).filter(name => name.endsWith('.html')).map(name => ({ type: 'Text', path: join(bundle, name) }))
  ] };
}
const options = {
  outboundService: async (req) => {
    if (req.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const body = await req.json();
      return Response.json({ success: body.response === 'valid' });
    }
    if (req.url === 'https://api.resend.com/emails') {
      messages.push(await req.json());
      return Response.json({ id: 'test-delivery' });
    }
    throw Error('Unexpected outbound request.');
  },
  name: 'stream-pilot',
  compatibilityDate: '2026-10-30',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: { STREAM_STORE: { className: 'StreamStore', useSQLite: true } },
  bindings: {
    STREAM_PUBLIC_ORIGIN: 'https://streamyourfilm.com',
    STREAM_VAULT_KEY: randomBytes(32).toString('base64url'),
    STREAM_ADMIN_EMAIL: 'operator@example.test',
    STREAM_RECOVERY_FROM: 'identity@example.test',
    RESEND_API_KEY: 'mock',
    STREAM_TURNSTILE_SECRET_KEY: 'mock-secret',
    STREAM_TURNSTILE_SITE_KEY: 'mock-site'
  },
  serviceBindings: { ASSETS: () => new Response('asset') }
};
let mf;
try {
  const start = async (entry, bindings = {}) => new Miniflare({ ...convertV4MiniflareOptions({
    ...options, ...await bundleWorker(entry), bindings: { ...options.bindings, ...bindings }
  }), resourcePersistencePath: root });
  mf = await start('edge', { STREAM_WORKSPACE_PHASE: 'signup' });
  const landing = await mf.dispatchFetch('https://streamyourfilm.com/', { redirect: 'manual' });
  assert.equal(landing.status, 200);
  const publicPage = await landing.text();
  assert.match(publicPage, /Rent your film/);
  assert.match(publicPage, /href="\/admin\/sign-up">Sign up for free/);
  assert.doesNotMatch(publicPage, /name="email"|data-sitekey=/);
  assert.match(landing.headers.get('content-security-policy'), /media-src 'self'/);
  // The mock asset binding, like production, ignores Range and returns the full file.
  const excerpt = 'https://streamyourfilm.com/market-street-excerpt.mp4';
  const probe = await mf.dispatchFetch(excerpt, {headers:{Range:'bytes=0-1'}});
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/5');
  assert.equal(await probe.text(), 'as');
  assert.equal((await mf.dispatchFetch(excerpt, {headers:{Range:'bytes=19-'}})).status, 416);
  const home = await mf.dispatchFetch('https://streamyourfilm.com/setup/home', {redirect:'manual'});
  assert.equal(home.headers.get('location'), '/');
  const res = await mf.dispatchFetch('https://streamyourfilm.com/admin/sign-up');
  const html = await res.text();
  if (res.status !== 200) throw Error(res.status + ' ' + html.slice(0, 400));
  assert.match(html, /Sign up for Stream/);
  console.log('Worker homepage and SQLite store opened.');
  for (const [name, test] of [
    ['faq', /How do I put a film/],
    ['privacy', /<h1>Privacy policy<\/h1>/],
    ['example/market-street', /data-payment-mode="example"/],
    ['setup/agreement/pilot-live-v1', /charged real money/],
    ['admin/sign-in', /Email me a sign-in link/]
  ]) {
    const r = await mf.dispatchFetch('https://streamyourfilm.com/' + name);
    assert.equal(r.status, 200);
    assert.match(await r.text(), test);
  }
  console.log('Verified FAQ, versioned agreement and admin sign-in.');
  const origin = 'https://streamyourfilm.com';
  const post = (path, fields, cookie, referer = origin) =>
    mf.dispatchFetch(origin + path, {
      method: 'POST',
      body: new URLSearchParams(fields).toString(),
      headers: { origin: referer, 'content-type': 'application/x-www-form-urlencoded', ...(cookie && { cookie }) },
      redirect: 'manual'
    });
  const get = (path, cookie) => mf.dispatchFetch(origin + path, { headers: { cookie }, redirect: 'manual' });
  const fields = { email: 'maker@example.test', agreement: 'pilot-live-v1', 'cf-turnstile-response': 'valid' };
  assert.equal((await post('/admin/sign-up/request', fields, undefined, 'https://other.example')).status, 403);
  assert.equal((await post('/admin/sign-up/request', { ...fields, 'cf-turnstile-response': 'bad' })).status, 400);
  assert.equal((await post('/admin/sign-up/request', { ...fields, agreement: 'pilot-v1' })).status, 400);
  const requested = await post('/admin/sign-up/request', fields);
  assert.equal(requested.status, 200, (await requested.text()).match(/feedback[^>]*>([^<]*)/)?.[1]);
  async function lastCode(number) {
    for (let i = 0; i < 40 && messages.length < number; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(messages.length, number);
    const message = messages.at(-1);
    const link = new URL(message.text.match(/https:\S+/)[0]);
    assert.deepEqual([...message.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [link.href]);
    assert.ok(message.html.includes('<title>' + message.subject + '</title>'));
    assert.equal(link.origin, origin);
    return new URLSearchParams(link.hash.slice(1)).get('magic-link');
  }
  const code = await lastCode(1);
  assert.equal((await post('/admin/sign-up', { agreement: 'pilot-v1', code })).status, 401);
  const confirmed = await post('/admin/sign-up', { agreement: fields.agreement, code });
  assert.equal(confirmed.status, 303);
  const cookie = confirmed.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /__Secure-stream_setup=/);
  assert.equal((await post('/admin/sign-up', { agreement: fields.agreement, code })).status, 401);
  const signupWorkspace = await (await get('/setup/settings', cookie)).text();
  assert.match(signupWorkspace, /maker@example.test/);
  assert.match(signupWorkspace, /when the media service is available/);
  assert.equal((await get('/setup/admin', cookie)).status, 303);
  assert.equal((await get('/setup/home', cookie)).headers.get('location'), '/setup/dashboard');
  assert.equal(
    (await post('/admin/sign-in/request', { ...fields, email: 'operator@example.test' })).status,
    200
  );
  const acode = await lastCode(2);
  assert.equal((await post('/setup/sign-in', { code: acode })).status, 401);
  const admin = await post('/admin/sign-in', { code: acode });
  assert.equal(admin.status, 303);
  const acookie = admin.headers.get('set-cookie').split(';')[0];
  async function checkHeader(cookie, action) {
    const res = await get('/setup/admin/header-session', cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const session = await res.json();
    if (action) {
      assert.equal(session.action, action);
      assert.ok(session.csrf);
    } else assert.equal(session, null);
  }
  await checkHeader('', null);
  await checkHeader(cookie, '/setup/sign-out');
  await checkHeader(acookie, '/setup/admin/sign-out');
  assert.match(await (await get('/setup/admin', acookie)).text(), /Platform analytics/);
  await mf.dispose();
  mf = await start('container', { STREAM_WORKSPACE_PHASE: 'full', STRIPE_CONNECT_SECRET_KEY: 'sk_live_fixture',
    STREAM_SALES_TERRITORIES: 'worldwide' });
  const ns = await mf.getDurableObjectNamespace('STREAM_STORE');
  const ledger = ns.get(ns.idFromName('pilot-live'));
  async function call(method, ...args) {
    const result = await ledger.call(method, args);
    assert.ifError(result.error);
    return unpack(result.value);
  }
  const maker = await call('session', cookie.split('=')[1], 'filmmaker');
  const bucket = { accountId: 'a'.repeat(32), bucket: 'test-bucket', jurisdiction: 'default', uploads: true };
  await call('saveBucket', maker.owner, { ...bucket, accessKeyId: 'fixture', secretAccessKey: 'test-secret' });
  const id = 'f-' + randomUUID();
  await call('saveFilm', maker.owner, bucket, { id, title: 'My first film', duration: 30 });
  await call('setFilmPublication', maker.owner, id, true);
  await call('createProgram', maker.owner);
  const settings = await get('/setup/settings?bucket=change', cookie);
  const settingsPage = await settings.text();
  assert.match(settingsPage, /maker@example.test/);
  assert.match(settingsPage, /Cancel bucket change/);
  assert.match(settingsPage, /test-bucket/);
  assert.match(settingsPage, /action="\/setup\/stripe\/start"/);
  assert.doesNotMatch(settingsPage, /test-secret/);
  const dashboard = await get('/setup/dashboard?film=' + id, cookie);
  assert.match(dashboard.headers.get('cache-control'), /private, no-store/);
  assert.match(dashboard.headers.get('content-security-policy'), /frame-src https:\/\/watch.streamyourfilm.com/);
  const markup = await dashboard.text();
  assert.ok(markup.includes('id="' + id + '" open'));
  assert.match(markup, /My first film/);
  assert.match(markup, /Untitled program/);
  assert.ok(markup.includes('src="https://watch.streamyourfilm.com/embed/' + id));
  assert.doesNotMatch(markup, /test-secret|test-bucket/);
  for (const path of ['/setup/dashboard.js', '/setup/film-embed.js', '/setup/thumbnail.js', '/setup/thumbnail-frame.js']) {
    assert.equal(await (await get(path, cookie)).text(), 'asset');
  }
  const refresh = token => mf.dispatchFetch(origin + '/setup/dashboard', { headers: { cookie, 'X-Stream-Analytics': token } });
  assert.equal((await refresh('old')).status, 401);
  const fragment = await refresh(maker.csrf);
  assert.equal(fragment.headers.get('x-stream-analytics'), '1');
  assert.doesNotMatch(await fragment.text(), /<form|<iframe/);
  assert.equal((await get('/setup/dashboard', acookie)).headers.get('location'), '/admin/sign-in');
  assert.equal((await get('/setup/admin', cookie)).headers.get('location'), '/admin/sign-in');
  // An action that really needs the absent container still takes the origin route.
  assert.equal((await post('/setup/next', { csrf: maker.csrf }, cookie)).status, 503);
  const adminPage = await (await get('/setup/admin', acookie)).text();
  assert.match(adminPage, /Platform analytics/);
  assert.match(adminPage, /new-mexico\.csv/);
  console.log('Full Worker served signed-in filmmaker pages, scripts and live reports without a media runtime.');
  const csrf = adminPage.match(/name="csrf" value="([^"]+)"/)[1];
  const signedOut = await post('/setup/admin/sign-out', {csrf}, acookie);
  assert.equal(signedOut.headers.get('location'), '/admin/sign-in');
  assert.equal((await get('/setup/admin', acookie)).headers.get('location'), '/admin/sign-in');
  await checkHeader(acookie, null);
  assert.equal((await post('/setup/sign-out', { csrf: maker.csrf }, cookie)).status, 303);
  for (const path of ['/setup/settings', '/setup/dashboard']) {
    assert.equal((await get(path, cookie)).headers.get('location'), '/admin/sign-in');
  }
  console.log('Verified one-time signup, role-based sign-in, sign-out and session separation through restart.');
} finally {
  try {
    await mf?.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
