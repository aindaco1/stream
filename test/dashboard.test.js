import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { revisionFor } from '../src/media.js';
import { createPublicFilms } from '../src/public-films.js';
import { createRentalAuthority } from '../src/rental.js';
import { makeServer } from '../src/server.js';
import { createSetup } from '../src/setup.js';

test('filmmaker dashboard publishes verified films, scopes analytics and honors earlier paid access on unpublish', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-dashboard-'));
  const head = { size: 8192, revision: '"original"' };
  let currentHead = head;
  const sourceFor = () => ({ head: async () => currentHead });
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture', STREAM_VIEWER_ORIGIN: 'https://viewer.example', STREAM_LOCAL_PREVIEW_PORT: '8795' };
  const withdrawals = [];
  let stripeStatus = 'ready';
  const setup = await createSetup({ directory, env, sourceFor, stripe:{
    async refresh() { return { status: stripeStatus }; }
  }, viewerCheckout:{
    async closeWithdrawnSessions(owner,id) { withdrawals.push([owner,id]); return 0; }
  }});
  const { store } = setup;
  const authority = createRentalAuthority(randomBytes(32));
  const catalog = createPublicFilms({ store, env, authority, sourceFor });
  const app = await makeServer(null, { setup, catalog });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); setup.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.address().port;
  const bucket = { accountId: 'c'.repeat(32), bucket: 'private-bucket', jurisdiction: 'default' };
  function owner(name, title) {
    const token = store.signIn(store.invite(name));
    const session = store.session(token);
    const account = 'acct_' + name;
    store.claimAccount(name, account, 'test');
    store.saveStripe(name, { byMode: { test: { accountId: account, creatorId: name, mode: 'test', channel: 'hosted',
      status: 'ready', chargesEnabled: true, payoutsEnabled: true } } });
    store.saveBucket(name, { ...bucket, accessKeyId: 'test', secretAccessKey: 'local-test' });
    const id = 'f-' + randomUUID();
    store.saveFilm(name, bucket, { id, title, objectKey: 'private.mp4', revision: revisionFor(head), duration: 12,
      rights: { acceptedAt: new Date().toISOString(), version: 'v1', statement: 'Confirmed' } });
    const cookie = 'stream_setup=' + token;
    return { id, account, cookie, csrf: session.csrf, get: () => fetch(origin + '/setup/dashboard', { headers: { Cookie: cookie } }).then(r => r.text()),
      post(route, data) { return fetch(origin + '/setup/dashboard/' + route, { redirect: 'manual', method: 'POST',
        headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ csrf: session.csrf, filmId: id, ...data }) }); } };
  }
  const ada = owner('Alice', 'My <film>'), ben = owner('Benny', 'Other private title');
  const thumb = origin + '/setup/thumbnail/' + ada.id;
  for (const resource of ['', '/source.jpg', '/poster.jpg']) {
    assert.equal((await fetch(thumb + resource)).status, 401);
    assert.equal((await fetch(thumb + resource, { headers: { Cookie: ben.cookie } })).status, 404);
  }
  const thumbPost = { Cookie: ada.cookie, Origin: origin, 'X-Stream-CSRF': ada.csrf,
    'Content-Type': 'application/octet-stream', 'X-Thumbnail-Action': 'save' };
  for (const headers of [{ ...thumbPost, Origin: 'https://unrelated.example' }, { ...thumbPost, 'X-Stream-CSRF': 'old' }]) {
    assert.equal((await fetch(thumb, { method: 'POST', headers })).status, 403);
  }
  assert.equal((await fetch(thumb, { method: 'POST', headers: { ...thumbPost, Cookie: ben.cookie, 'X-Stream-CSRF': ben.csrf } })).status, 404);
  const unsigned = await fetch(origin + '/setup/dashboard', { redirect: 'manual' });
  assert.equal(unsigned.status, 303);
  assert.equal(catalog.get(ada.id), undefined);
  let page = await ada.get();
  assert.match(page, /My &lt;film&gt;/);
  assert.doesNotMatch(page, /Other private title|Copy embed code/);
  assert.equal((await ben.post('publication', { filmId: ada.id, visibility: 'public' })).status, 404);
  assert.equal((await ada.post('publication', { csrf: 'wrong', visibility: 'public' })).status, 403);
  stripeStatus = 'restricted';
  assert.equal((await ada.post('publication', { visibility: 'public' })).status, 422);
  assert.deepEqual(catalog.list(), []);
  stripeStatus = 'ready';
  currentHead = { ...head, revision: '"replacement"' };
  assert.equal((await ada.post('publication', { visibility: 'public' })).status, 422);
  assert.deepEqual(catalog.list(), []);
  currentHead = head;
  const settings = { rentPrice: '2.00', buyPrice: '4.00', rentalHours: '24', previewSeconds: '5' };
  const invalidPreview = await ada.post('settings', { ...settings, previewSeconds: '12' });
  assert.equal(invalidPreview.status, 422);
  assert.ok((await invalidPreview.text()).includes('id="' + ada.id + '" open>'), 'Show the film whose settings need correction');
  assert.equal((await ada.post('settings', { ...settings, rentalHours: '721' })).status, 422);
  assert.equal((await ada.post('settings', settings)).status, 303);
  assert.equal((await ada.post('publication', { visibility: 'public' })).status, 303);
  const spec = catalog.get(ada.id);
  assert.equal(spec.previewSeconds, 5);
  assert.equal(spec.rentalHours, 24);
  page = await ada.get();
  assert.ok(page.includes(env.STREAM_VIEWER_ORIGIN + '/embed/' + ada.id));
  assert.doesNotMatch(page, /private\.mp4|private-bucket|acct_Alice|r2\.cloudflarestorage/);
  assert.match(page, /Copy embed code/);
  assert.ok(page.includes('<iframe src="http://127.0.0.1:8795/embed/' + ada.id));
  assert.ok(page.includes('&lt;iframe src=&quot;https://viewer.example/embed/' + ada.id));
  const policy = (await fetch(origin + '/setup/dashboard', { headers: { Cookie: ada.cookie } })).headers.get('content-security-policy');
  assert.match(policy, /frame-src http:\/\/127\.0\.0\.1:8795/);
  assert.deepEqual(catalog.list(), [{ id: ada.id, title: 'My <film>' }]);
  const eventId = randomUUID();
  assert.equal(catalog.recordView(ada.id, 'preview', eventId), true);
  assert.equal(catalog.recordView(ada.id, 'preview', eventId), false);
  assert.equal(catalog.recordView(ada.id, 'paid', eventId), true);
  assert.equal(catalog.recordView(ben.id, 'preview', randomUUID()), false);
  assert.equal(store.recordView('Benny', ada.id, 'paid', randomUUID()), false);
  assert.equal(catalog.recordView(ada.id, 'preview', ''), false);
  for (const [kind, paid, refund] of [['rent', true, 0], ['buy', true, 175], ['buy', false, 0]]) {
    const order = store.reserveViewerOrder({ ...spec, tokenHash: randomUUID(), platform: 'acct_Platform', origin, kind, amount: spec.prices[kind], tipPercent: kind === 'buy' ? 10 : 0 });
    const session = 'cs_' + randomUUID();
    store.bindViewerSession(order.orderId, session);
    if (paid) store.reconcileViewerPayment(store.viewerOrderById(order.orderId), { intentId: 'pi_' + randomUUID(), chargeId: 'ch_' + randomUUID(),
      paidAt: Math.floor(Date.now() / 1000), refundedAmount: refund, disputeStatus: null, revocationReason: null, stripeFeeCents: kind === 'buy' ? 60 : null });
  }
  assert.deepEqual(store.dashboardFilms('Alice')[0].stats, { previews: 1, plays: 1, rentals: 1, purchases: 1, revenue: 600,
    filmTaxFees: 0, tipTaxFees: 0, pendingTaxFees: 0, estimatedFees: 79, reportedFees: 60, netRevenue: 329, estimatedOrders: 1, platformTips: 40, taxCollected: 0, transfersToReview: 0 });
  assert.deepEqual(store.dashboardFilms('Benny')[0].stats, { previews: 0, plays: 0, rentals: 0, purchases: 0, revenue: 0,
    filmTaxFees: 0, tipTaxFees: 0, pendingTaxFees: 0, estimatedFees: 0, reportedFees: 0, netRevenue: 0, estimatedOrders: 0, platformTips: 0, taxCollected: 0, transfersToReview: 0 });
  const platform = store.platformReport(null);
  assert.equal(platform.total.films, 2);
  assert.equal(platform.total.platformTips, 40);
  assert.equal(platform.total.netRevenue, 329);
  assert.equal(platform.total.revenue, 600);
  assert.equal(platform.total.estimatedFees, 79);
  assert.deepEqual(platform.rows.map(row => [row.name, row.revenue]), [['Alice', 600], ['Benny', 0]]);
  assert.deepEqual(store.platformReport('Benny').rows.map(row => row.title), ['Other private title']);
  assert.match(await ada.get(), /\$6\.00/);
  assert.equal((await ada.post('settings', { ...settings, previewSeconds: '0' })).status, 303);
  assert.equal(catalog.recordView(ada.id, 'preview', randomUUID()), false);
  env.STREAM_PUBLIC_FILMS = JSON.stringify([{ owner: 'Alice', id: ada.id }]);
  assert.equal((await ada.post('publication', { visibility: 'private' })).status, 303);
  assert.deepEqual(withdrawals,[['Alice',ada.id]]);
  assert.deepEqual(catalog.list(), []);
  assert.equal(catalog.get(ada.id), undefined);
  await assert.rejects(catalog.verify(ada.id));
  assert.equal((await catalog.verify(ada.id, { entitled: true })).scope, spec.scope);
  assert.equal(catalog.recordView(ada.id, 'paid', randomUUID()), true);
  assert.doesNotMatch(await ada.get(), /Copy embed code/);
  const info = { synopsis: 'A desert film.', credits: 'Camera <A> & B', message: 'For our crew.' };
  const player = show => fetch(origin + '/embed/' + ada.id + '?show=' + show).then(r => r.text());
  assert.equal((await ben.post('info', { ...info, filmId: ada.id })).status, 404);
  assert.equal((await ada.post('info', { ...info, csrf: 'old' })).status, 403);
  assert.equal((await ada.post('info', { ...info, message: 'a'.repeat(281) })).status, 422);
  assert.equal((await ada.post('info', info)).status, 303);
  assert.doesNotMatch(await player('synopsis,credits,message'), /A desert film|For our crew/);
  assert.equal((await ada.post('publication', { visibility: 'public' })).status, 303);
  assert.match(await player('credits,message'), /Camera &lt;A&gt; &amp; B/);
  assert.match(await player('credits,message'), /For our crew/);
  assert.doesNotMatch(await player('credits,message'), /A desert film/);
  const details = (await player('synopsis,credits,message')).match(/<section class="film-info"[\s\S]*?<\/section>/)[0];
  assert.match(details, /<p class="film-synopsis">A desert film\.<\/p><p class="film-message">For our crew\.<\/p><p class="film-credits">Camera &lt;A&gt; &amp; B<\/p>/);
  assert.doesNotMatch(details, />Synopsis<|>Credits<|>Filmmaker message</);
  assert.doesNotMatch(await player('unknown'), /A desert film|For our crew|class="film-info"/);
  assert.doesNotMatch(await player(''), /class="film-info"/);
  assert.equal((await ada.post('info', { ...info, message: 'Updated message.' })).status, 303);
  assert.match(await player('message'), /Updated message/);
  assert.equal((await ada.post('info', { ...info, message: '' })).status, 303);
  assert.doesNotMatch(await player('message'), /class="film-info"/);
});

test('program editor protects private drafts, enforces ownership and rejects stale saves', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-program-editor-'));
  const setup = await createSetup({ directory, env:{}, stripe:{configured:false} });
  const app = await makeServer(null,{setup});
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); setup.close(); await rm(directory,{recursive:true,force:true}); });
  const origin = 'http://127.0.0.1:' + app.address().port;
  function actor(owner) {
    const token = setup.store.signIn(setup.store.invite(owner));
    const cookie = 'stream_setup=' + token;
    const csrf = setup.store.session(token).csrf;
    return {
      get: path => fetch(origin + path,{headers:{Cookie:cookie},redirect:'manual'}),
      post: (path, fields={}, requestOrigin=origin) => fetch(origin+path,{method:'POST',headers:{Origin:requestOrigin,Cookie:cookie},
        body:new URLSearchParams({csrf,...fields}),redirect:'manual'})
    };
  }
  const maker = actor('Programs owner'), other = actor('Another owner');
  const created = await maker.post('/setup/program/create');
  assert.equal(created.status,303);
  const path = created.headers.get('Location');
  const id = path.split('/').pop();
  assert.match(path,/^\/setup\/program\/p-/);
  assert.equal((await fetch(origin+path)).status,401);
  for (const privatePath of [path, '/setup/preview/'+id, '/setup/thumbnail/'+id+'/settings']) {
    assert.equal((await other.get(privatePath)).status,404);
  }
  const fields = {title:'Screening A',version:'1',action:'save',rentPrice:'4',buyPrice:'',previewSeconds:'0',rentalHours:'24'};
  assert.equal((await maker.post(path,fields,'https://publisher.example')).status,403);
  assert.equal((await maker.post(path,{...fields,csrf:'stale'})).status,403);
  assert.equal((await other.post(path,fields)).status,404);
  assert.equal((await maker.post(path,fields)).status,303);
  assert.equal((await maker.post(path,{...fields,title:'Old edit'})).status,409);
  assert.equal((await maker.post(path,{...fields,version:'2',opening:'f-'+randomUUID()})).status,422);
  const saved = setup.store.program('Programs owner',id);
  assert.equal(saved.title,'Screening A');
  assert.equal(saved.published,false);
  assert.equal((await maker.get('/setup/preview/'+id)).status,422);
  assert.equal((await maker.get('/embed/'+id)).status,404);
});
