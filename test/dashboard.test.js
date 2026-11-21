import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSetupStore } from '../src/setup-store.js';
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
    store.saveFilm(name, bucket, { id, title, objectKey: 'private.mp4', revision: revisionFor(head), duration: 12.6,
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
  assert.equal((await ada.post('settings', { ...settings, previewSeconds:'11' })).status, 303);
  assert.equal((await ada.post('settings', settings)).status, 303);
  assert.equal((await ada.post('publication', { visibility: 'public' })).status, 303);
  const spec = catalog.get(ada.id);
  assert.equal(spec.screenerWatermark, false);
  assert.equal((await ada.post('settings', { ...settings, screenerWatermark: 'invalid' })).status, 422);
  assert.equal((await ben.post('settings', { ...settings, filmId: ada.id, screenerWatermark: 'on' })).status, 404);
  assert.equal((await ada.post('settings', { ...settings, screenerWatermark: 'on' })).status, 303);
  assert.equal(catalog.get(ada.id).screenerWatermark, true);
  assert.match(await ada.get(), /name="screenerWatermark"[\s\S]*?<option value="on" selected>/);
  assert.equal((await ada.post('settings', settings)).status, 303);
  assert.equal(catalog.get(ada.id, { entitled: true }).screenerWatermark, true, 'older open forms preserve the setting');
  assert.equal((await ada.post('settings', { ...settings, screenerWatermark: 'off' })).status, 303);
  assert.equal(catalog.get(ada.id).screenerWatermark, false);
  assert.equal(spec.previewSeconds, 5);
  // A previously valid 12-second offer on a 12.6-second film remains sellable.
  store.setFilmSettings(spec.owner, ada.id, {prices:spec.prices, rentalHours:24, previewSeconds:12});
  assert.equal(catalog.get(ada.id).previewSeconds, 11);
  assert.match(await ada.get(), /name="previewSeconds" min="0" max="11" step="1" required value="11"/);
  assert.equal((await ada.post('settings', settings)).status, 303);
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
  assert.deepEqual(store.dashboardFilms('Alice')[0].stats, { previews: 1, plays: 1, timedPlays: 0, watchSeconds: 0, rentals: 1, purchases: 1, revenue: 600,
    filmTaxFees: 0, tipTaxFees: 0, pendingTaxFees: 0, processingFees: 96, reportedFees: 60, paymentAdjustments: 175, netRevenue: 329, estimatedOrders: 1, platformTips: 40, taxCollected: 0, transfersToReview: 0 });
  assert.deepEqual(store.dashboardFilms('Benny')[0].stats, { previews: 0, plays: 0, timedPlays: 0, watchSeconds: 0, rentals: 0, purchases: 0, revenue: 0,
    filmTaxFees: 0, tipTaxFees: 0, pendingTaxFees: 0, processingFees: 0, reportedFees: 0, paymentAdjustments: 0, netRevenue: 0, estimatedOrders: 0, platformTips: 0, taxCollected: 0, transfersToReview: 0 });
  const platform = store.platformReport(null);
  assert.equal(platform.total.films, 2);
  assert.equal(platform.total.platformTips, 40);
  assert.equal(platform.total.netRevenue, 329);
  assert.equal(platform.total.revenue, 600);
  assert.equal(platform.total.processingFees, 96);
  assert.equal(platform.total.netRevenue, platform.total.revenue - platform.total.processingFees - platform.total.paymentAdjustments - platform.total.filmTaxFees);
  assert.deepEqual(platform.rows.map(row => [row.name, row.revenue]), [['Alice', 600], ['Benny', 0]]);
  assert.deepEqual(store.platformReport('Benny').rows.map(row => row.title), ['Other private title']);
  const overview = (await ada.get()).split('id="overview"')[1].split('</section>')[0];
  assert.match(overview, /\$6\.00/);
  assert.match(overview, /data-field-help="[^"]*estimated for 1 payment\."[^>]*>Net Revenue</);
  assert.match(overview, /data-field-help="[^"]*confirmed \$0\.60 on 1 payment\. The remaining \$0\.36 is estimated for 1 payment\."[^>]*>Stripe fees<\/dt><dd>\$0\.96</);
  assert.match(overview, /\$6\.00 revenue − \$0\.96 Stripe fees − \$1\.75 Stripe adjustment = <strong>\$3\.29 net revenue/);
  assert.match(overview, />Avg\. watch time<\/dt><dd>—<\/dd>/);
  const refresh = headers => fetch(origin + '/setup/dashboard', {headers});
  assert.equal((await refresh({Cookie:ben.cookie, 'X-Stream-Analytics':ada.csrf})).status,401);
  const fragments = await refresh({Cookie:ada.cookie, 'X-Stream-Analytics':ada.csrf});
  assert.equal(fragments.headers.get('x-stream-analytics'),'1');
  const markup = await fragments.text();
  assert.ok(markup.includes('data-report="overview" data-pending-fees'));
  assert.ok(markup.includes('data-report="' + ada.id + '"'));
  assert.doesNotMatch(markup, /<form|<iframe|refund/i);
  assert.ok(!markup.includes(ben.id));
  const headline = overview.split('<details')[0];
  assert.match(headline, />Rentals<\/dt><dd>1<\/dd>/);
  assert.match(headline, />Purchases<\/dt><dd>1<\/dd>/);
  assert.doesNotMatch(overview, />Sales<\/dt>/);
  assert.doesNotMatch(await ben.get(), /class="hint net-calculation"/);
  for (const seconds of [0, 10, 20]) catalog.recordView(ada.id, 'paid', randomUUID(), {seconds});
  const timed = (await ada.get()).split('id="overview"')[1].split('</section>')[0];
  assert.match(timed, />Avg\. watch time<\/dt><dd>10 sec<\/dd>/, 'legacy plays stay out of the average');
  assert.match(overview, /href="\/faq#dashboard-analytics"/);
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
  const button = /<button[^>]*class="primary"[^>]*>Create program<\/button>/;
  const dashboard = async () => (await maker.get('/setup/dashboard')).text();
  assert.doesNotMatch(await dashboard(),/action="\/setup\/program\/create"/);
  assert.equal((await maker.post('/setup/program/create')).status,422);
  const bucket = { accountId:'b'.repeat(32), bucket:'library', jurisdiction:'default' };
  for (const owner of ['Programs owner','Another owner']) {
    setup.store.saveBucket(owner,{...bucket,accessKeyId:'test',secretAccessKey:'test'});
    setup.store.saveFilm(owner,bucket,{id:'f-'+randomUUID(),title:'First film',objectKey:'first.mp4',revision:'1',duration:12});
  }
  assert.doesNotMatch(await dashboard(),/action="\/setup\/program\/create"/);
  assert.equal((await maker.post('/setup/program/create')).status,422);
  setup.store.saveFilm('Programs owner',bucket,{id:'f-'+randomUUID(),title:'Second film',objectKey:'second.mp4',revision:'1',duration:12});
  const [beforePrograms, programs] = (await dashboard()).split('id="programs"');
  assert.doesNotMatch(beforePrograms,button);
  assert.match(programs,button);
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
  assert.equal((await maker.post(path,{...fields,screenerWatermark:'invalid'})).status,422);
  assert.equal((await maker.post(path,{...fields,screenerWatermark:'on'})).status,303);
  assert.equal((await maker.post(path,{...fields,title:'Old edit'})).status,409);
  assert.equal((await maker.post(path,{...fields,version:'2',opening:'f-'+randomUUID()})).status,422);
  const saved = setup.store.program('Programs owner',id);
  assert.equal(saved.title,'Screening A');
  assert.equal(saved.screenerWatermark,true);
  assert.match(await (await maker.get(path)).text(), /name="screenerWatermark"[^>]*>\s*<option value="off">Off<\/option>\s*<option value="on" selected>/);
  assert.equal(saved.published,false);
  assert.equal((await maker.get('/setup/preview/'+id)).status,422);
  assert.equal((await maker.get('/embed/'+id)).status,404);
});


test('existing view counts survive migration, retry cleanup and reopening the store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-watch-migration-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const path = join(directory, 'setup.sqlite');
  const id = 'f-' + randomUUID(), eventId = randomUUID();
  const digest = createHash('sha256').update(JSON.stringify([id,'paid',eventId])).digest('hex');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE film_counts(filmId TEXT PRIMARY KEY, previews INTEGER NOT NULL, plays INTEGER NOT NULL);
    CREATE TABLE film_view_receipts(filmId TEXT, kind TEXT, digest TEXT, createdAt INTEGER, PRIMARY KEY(filmId,kind,digest));`);
  old.prepare('INSERT INTO film_counts VALUES(?,3,5)').run(id);
  old.prepare("INSERT INTO film_view_receipts VALUES(?,'paid',?,?)").run(id, digest, Date.now());
  old.close();
  const store = openSetupStore(directory);
  const bucket = {accountId:'a'.repeat(32), bucket:'test', jurisdiction:'default'};
  try {
    store.invite('Test');
    store.saveBucket('Test', {...bucket, accessKeyId:'demo', secretAccessKey:'demo'});
    store.saveFilm('Test', bucket, {id, title:'Existing film', objectKey:'clip.mp4'});
    const counts = () => store.dashboardFilms('Test')[0].stats;
    assert.deepEqual([counts().previews,counts().plays,counts().timedPlays,counts().watchSeconds],[3,5,0,0]);
    assert.equal(store.recordView('Test',id,'paid',eventId),false);
    assert.equal(store.recordView('Test',id,'paid',eventId,7),true);
    assert.equal(store.recordView('Test',id,'paid',eventId,7),false);
  } finally { store.close(); }
  const oldWriter = new DatabaseSync(path);
  // Older binaries use this exact INSERT shape during a rolling restart.
  oldWriter.prepare("INSERT INTO film_view_receipts SELECT id,'preview','legacy-other',0 FROM films WHERE id=?").run(id);
  oldWriter.prepare('UPDATE film_view_receipts SET createdAt=0 WHERE digest=?').run(digest);
  oldWriter.close();
  const restored = openSetupStore(directory);
  try {
    restored.recordView('Test', id, 'paid', randomUUID(), 3);
    const {plays,timedPlays,watchSeconds} = restored.dashboardFilms('Test')[0].stats;
    assert.deepEqual([plays,timedPlays,watchSeconds],[6,2,10]);
  } finally { restored.close(); }
  const check = new DatabaseSync(path, {readOnly:true});
  try {
    assert.equal(check.prepare('SELECT 1 FROM film_watch_progress WHERE digest=?').get(digest),undefined);
  } finally { check.close(); }
});
