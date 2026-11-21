import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { revisionFor } from '../src/media.js';
import { createPublicFilms } from '../src/public-films.js';
import { createR2Source } from '../src/source.js';
import { renderDashboard } from '../src/setup-view.js';
import { openSetupStore } from '../src/setup-store.js';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stream-programs-'));
  const store = openSetupStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const rights = {
    version: 'v1',
    statement: 'I have permission to distribute this screening.',
    acceptedAt: new Date().toISOString()
  };
  const owner = 'First maker',
    account = 'acct_first';
  const originals = new Map();
  function film(owner, title, programId) {
    const id = 'f-' + randomUUID(),
      objectKey = id + '.mov',
      bytes = Buffer.from('original ' + id);
    const head = { size: bytes.length, revision: '"' + id + '"' };
    originals.set(objectKey, { head, bytes });
    const bucket = { bucket: 'private', accountId: 'a'.repeat(32), jurisdiction: 'default' };
    store.saveBucket(owner, { ...bucket, accessKeyId: 'test', secretAccessKey: 'test', uploads: true });
    store.saveFilm(owner, bucket, {
      id,
      title,
      objectKey,
      revision: revisionFor(head),
      duration: 45,
      extension: 'mov',
      rights
    }, programId);
    return id;
  }
  store.invite(owner);
  store.invite('Other');
  const first = film(owner, 'First'),
    second = film(owner, 'Second'),
    opening = film(owner, 'Introduction');
  const foreign = film('Other', 'Someone else');
  store.claimAccount(owner, account, 'test');
  const enablePayments = () =>
    store.saveStripe(owner, {
      byMode: {
        test: {
          channel: 'hosted',
          creatorId: owner,
          accountId: account,
          mode: 'test',
          status: 'ready',
          chargesEnabled: true,
          payoutsEnabled: true
        }
      }
    });
  const sourceFor = settings => {
    const { objectKey } = settings;
    const original = originals.get(objectKey);
    if (!original || original.status) return createR2Source(settings, async () => new Response(null, {status: original?.status || 404}));
    return { head: async () => original.head, read: async (_, start, end) => original.bytes.subarray(start, end) };
  };
  const catalog = createPublicFilms({
    store,
    authority: {},
    env: { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture' },
    sourceFor,
    thumbnails: { poster: async (_, film) => Buffer.from(film.id + '/' + film.thumbnail) },
    async openMedia(source) {
      const head = await source.head();
      return {
        revision: revisionFor(head),
        close() {},
        preview(seconds, rendition) {
          return { seconds, rendition, which: head.revision };
        }
      };
    }
  });
  const created = store.createProgram(owner);
  const data = {
    title: 'Night screening',
    rights,
    members: [
      { filmId: opening, role: 'opening' },
      { filmId: first, role: 'film' },
      { filmId: second, role: 'film' }
    ],
    prices: { rent: 400, buy: 800 },
    rentalHours: 24,
    previewSeconds: 7,
    previewFilmId: opening
  };
  const save = (values = {}) =>
    store.saveProgram(owner, created.id, { ...data, ...values }, store.program(owner, created.id).version);
  return {
    store,
    first,
    second,
    opening,
    foreign,
    owner,
    account,
    save,
    catalog,
    originals,
    directory,
    film,
    id: created.id,
    data,
    enablePayments
  };
}

test('drafts are private, author-owned and support a selected preview before Stripe verification', async t => {
  const { store, id, owner, first, second, opening, foreign, save, data, catalog, enablePayments } =
    await workspace(t);
  assert.equal(store.program('Other', id), undefined);
  assert.throws(() => save({ screenerWatermark: 'yes' }), /watermark/i);
  assert.throws(() => save({ members: [{ filmId: foreign, role: 'film' }] }), /own library/);
  assert.throws(
    () =>
      save({
        members: [
          { filmId: first, role: 'film' },
          { filmId: first, role: 'film' }
        ]
      }),
    /once/
  );
  save();
  assert.throws(() => store.saveProgram(owner, id, data, 1), /changed/);
  assert.equal(catalog.get(id), undefined);
  const media = await catalog.openProgramPreview(owner, id);
  assert.deepEqual(await media.preview(7, { subtitleId: 's2' }), {
    seconds: 7,
    rendition: { subtitleId: 's2' },
    which: '"' + opening + '"'
  });
  await assert.rejects(catalog.publish(owner, id));
  enablePayments();
  await catalog.publish(owner, id);
  const spec = catalog.get(id);
  assert.deepEqual(
    spec.lineup.map(m => m.id),
    [opening, first, second]
  );
  assert.equal(spec.duration, 135);
  assert.equal(spec.lineup[2].size, ('original ' + second).length);
  assert.doesNotMatch(JSON.stringify(spec), /objectKey|accountId|\.mov"|secretAccessKey|bucket/);
  assert.equal(catalog.get(first), undefined, 'standalone private films stay private');
  assert.deepEqual(catalog.list(), [{ id, title: 'Night screening' }]);
  await assert.rejects(catalog.open(id, { memberId: second }));
  const preview = await catalog.open(id);
  assert.equal((await preview.preview()).seconds, 7);
  await assert.rejects(preview.preview(8));
  await assert.rejects(media.preview(7), 'previous draft no longer valid');
  await catalog.verify(id);
});

test('orders pin the lineup, terms, originals and member play counts across edits and withdrawal', async t => {
  const w = await workspace(t);
  const { catalog, id, store, owner, account, first, second, opening, data, save, originals } = w;
  w.enablePayments();
  save();
  await catalog.publish(owner, id);
  const initial = catalog.get(id),
    order = store.reserveViewerOrder({
      ...initial,
      tokenHash: 'token1',
      platform: 'acct_platform',
      origin: 'http://localhost',
      kind: 'buy',
      amount: 800
    });
  store.bindViewerSession(order.orderId, 'cs_test_program');
  save({
    title: 'New double bill',
    screenerWatermark: true,
    members: data.members.slice(1).reverse(),
    previewFilmId: second,
    previewSeconds: 5,
    prices: { rent: 250, buy: 500 }
  });
  assert.equal(catalog.get(id).title, initial.title, 'draft edits do not silently change published offers');
  await catalog.publish(owner, id);
  assert.notEqual(catalog.get(id).revision, initial.revision);
  assert.equal(catalog.get(id).screenerWatermark, true);
  assert.equal(catalog.get(id, { revision: initial.revision }), undefined);
  const historical = catalog.get(id, { entitled: true, revision: initial.revision });
  assert.equal(historical.title, initial.title);
  assert.equal(historical.screenerWatermark, false);
  assert.equal(historical.account, null);
  assert.equal(historical.lineup[0].id, opening);
  assert.equal(historical.prices.buy, 800);
  assert.throws(
    () =>
      store.reserveViewerOrder({
        ...initial,
        tokenHash: 'token2',
        platform: 'acct_platform',
        origin: 'http://localhost',
        kind: 'buy',
        amount: 800
      }),
    /changed/
  );
  const file = await catalog.programFile(id, initial.revision, opening);
  assert.equal(file.extension, 'mov');
  assert.equal(Buffer.concat(await Array.fromAsync(file.stream())).toString(), 'original ' + opening);
  await assert.rejects(catalog.programFile(id, catalog.get(id).revision, opening));
  await assert.rejects(catalog.programFile(id, initial.revision, w.foreign));
  assert.ok(catalog.recordView(id, 'paid', randomUUID(), { revision: initial.revision, memberId: second }));
  assert.equal(store.dashboardFilms(owner).find(f => f.id === second).stats.plays, 1);
  assert.equal(store.platformReport(null).total.plays, 1);
  assert.equal(store.programs(owner)[0].stats.plays, 0);
  store.setFilmPublication(owner, first, false);
  assert.equal(catalog.get(id), undefined);
  assert.equal(store.program(owner, id).published, false);
  assert.ok(catalog.get(id, { entitled: true, revision: initial.revision }));
  assert.equal(
    catalog.get(id, { entitled: true }).revision,
    initial.revision,
    'bare recovery URL resolves the purchased edition after withdrawal'
  );
  assert.equal(store.viewerOrderById(order.orderId).withdrawalState, 'requested');
  originals.get(opening + '.mov').head.revision = '"replacement"';
  await assert.rejects(catalog.programFile(id, initial.revision, opening), /unavailable/i);
  assert.equal(store.ownsTestAccount(owner, account), true);
});

test('a paid program counts one sale, saves the purchased title position and supports a program poster', async t => {
  const { catalog, id, store, owner, first, second, foreign, save, enablePayments } = await workspace(t);
  enablePayments();
  save();
  await catalog.publish(owner, id);
  assert.equal(catalog.isPublished(owner, id), true);
  const spec = catalog.get(id);
  const order = store.reserveViewerOrder({
    ...spec, tokenHash: 'paid', platform: 'acct_platform', origin: 'http://localhost', kind: 'rent', amount: 400
  });
  assert.equal(store.setProgramPosition(order.orderId, second, 10), false);
  store.bindViewerSession(order.orderId, 'cs_test_paid');
  store.reconcileViewerPayment(store.viewerOrderById(order.orderId), {
    intentId: 'pi_test', chargeId: 'ch_test', paidAt: Math.floor(Date.now() / 1000), refundedAmount: 0,
    disputeStatus: null, revocationReason: null, stripeFeeCents: 42
  });
  assert.equal(store.setProgramPosition(order.orderId, second, 10), true);
  assert.equal(store.setProgramPosition(order.orderId, foreign, 0), false);
  assert.equal(store.setProgramPosition(order.orderId, first, 99), false);
  assert.equal(store.viewerOrderById(order.orderId).positionMember, second);
  assert.equal(store.viewerOrderById(order.orderId).position, 10);
  const stats = store.platformReport(null).total;
  assert.deepEqual([stats.rentals, stats.revenue, stats.netRevenue], [1, 400, 358]);
  assert.equal(store.programs(owner)[0].stats.rentals, 1);
  assert.ok(store.dashboardFilms(owner).every(f => f.stats.rentals === 0));

  function setPoster(itemId, version) {
    const lock = store.beginThumbnailEdit(owner, itemId);
    assert.ok(lock);
    store.markThumbnailPending(owner, itemId);
    store.finishThumbnailEdit(owner, itemId, lock, version);
  }
  assert.equal(store.beginThumbnailEdit('Other', id), null);
  setPoster(first, 'film-art');
  assert.equal((await catalog.poster(id)).toString(), first + '/film-art');
  setPoster(id, 'program-art');
  assert.equal((await catalog.poster(id)).toString(), id + '/program-art');
  assert.equal((await catalog.poster(id, {memberId: first})).toString(), first + '/film-art');
  assert.equal(await catalog.poster(id, {memberId: foreign}), undefined);
  setPoster(id, null);
  assert.equal((await catalog.poster(id)).toString(), first + '/film-art');
  store.unpublishProgram(owner, id);
  assert.equal(catalog.isPublished(owner, id), false);
  assert.equal(await catalog.poster(id), undefined);
  assert.equal(store.viewerOrderById(order.orderId).status, 'paid');
});

for (const failure of ['missing','replaced']) {
  test(`a ${failure} program original pauses new sales with its title, while working purchased titles stay available`, async t => {
    const {store,catalog,id,owner,first,second,opening,originals,save,enablePayments} = await workspace(t);
    enablePayments();
    save();
    const revision = await catalog.publish(owner, id);
    const order = store.reserveViewerOrder({...catalog.get(id), tokenHash:'purchased', platform:'acct_platform',
      origin:'http://localhost', kind:'buy', amount:800});
    store.bindViewerSession(order.orderId, 'cs_test_paid');
    store.reconcileViewerPayment(store.viewerOrderById(order.orderId), {
      intentId:'pi_test', chargeId:'ch_test', paidAt:Math.floor(Date.now()/1000), refundedAmount:0,
      disputeStatus:null, revocationReason:null
    });
    const original = originals.get(second + '.mov');
    for (const status of [403, 503]) {
      original.status = status;
      await assert.rejects(catalog.verify(id));
      assert.equal(catalog.isPublished(owner,id), true);
      assert.equal(store.program(owner,id).unavailableTitle, undefined);
    }
    delete original.status;
    if (failure === 'missing') originals.delete(second + '.mov');
    else original.head.revision = '"replaced"';
    await assert.rejects(catalog.verify(id));
    assert.equal(catalog.get(id), undefined);
    const programs = store.programs(owner);
    assert.equal(programs[0].unavailableTitle, 'Second');
    const html = renderDashboard({csrf:'test', owner, origin:'http://localhost', films:[], programs, draft:{}});
    assert.match(html, /Sales paused/);
    assert.match(html, /original file for <strong>Second<\/strong>/);
    assert.match(html, /Publish the program again/);
    const historical = {entitled:true,revision};
    await assert.rejects(catalog.open(id, {...historical, memberId:second}));
    const media = await catalog.open(id, {...historical, memberId:first});
    assert.equal(media.revision, store.film(owner,first).revision);
    media.close();
    assert.equal(store.viewerOrderById(order.orderId).status, 'paid');

    // A saved repair stays private until the filmmaker republishes.
    save({members:[first,opening].map(filmId => ({filmId,role:'film'})), previewFilmId:first});
    assert.equal(store.program(owner,id).unavailableTitle, 'Second');
    const repaired = await catalog.publish(owner,id);
    assert.equal(store.program(owner,id).unavailableTitle, undefined);
    await assert.rejects(catalog.programFile(id,revision,second));
    assert.equal(catalog.get(id).revision, repaired, 'reading a retired broken title cannot pause the repaired lineup');
  });
}

test('program uploads have one editor, keep their original edition, and count toward the program', async t => {
  const {store,owner,film,catalog,id,data,save,enablePayments} = await workspace(t);
  const clip = film(owner, 'Director introduction', id);
  const other = store.createProgram(owner);
  const intro = {filmId:clip, role:'opening', title:'A few words before the screening'};
  const members = [intro,...data.members.slice(1)];
  save({members, previewFilmId:clip});
  assert.ok(store.programLibrary(owner,id).some(f => f.id === clip));
  assert.ok(!store.programLibrary(owner,other.id).some(f => f.id === clip));
  assert.ok(!store.programLibrary(owner,null).some(f => f.id === clip), 'an opening video cannot qualify its owner to create another program');
  assert.ok(!store.dashboardFilms(owner).some(f => f.id === clip));
  assert.throws(() => store.saveProgram(owner,other.id,{...data,members},other.version),/own library/);
  assert.throws(() => save({members:[{filmId:clip,role:'film'}],previewFilmId:clip}), /own library/);
  assert.throws(() => save({members:[{...intro,title:'x'.repeat(161)}]}), /160 characters/);
  enablePayments();
  await assert.rejects(catalog.publish(owner,clip));
  await catalog.publish(owner,id);
  const original = catalog.get(id);
  assert.equal(original.lineup[0].title,intro.title);
  assert.ok(catalog.recordView(id,'preview',randomUUID()));
  const order = store.reserveViewerOrder({...original,tokenHash:'original-cut',kind:'buy',amount:800,
    platform:'acct_platform',origin:'http://localhost'});
  store.bindViewerSession(order.orderId,'cs_test_originalcut');
  save({members:data.members.slice(1),previewFilmId:null});
  assert.ok(!store.programLibrary(owner,id).some(f => f.id === clip));
  assert.throws(() => save({members,previewFilmId:clip}),/own library/);
  assert.equal(catalog.get(id).revision,original.revision);
  await catalog.publish(owner,id);
  assert.ok(catalog.get(id).lineup.every(m => m.id !== clip));
  const historical = catalog.get(id,{revision:original.revision,entitled:true});
  assert.deepEqual(historical.lineup[0],original.lineup[0]);
  const source = await catalog.programFile(id,original.revision,clip);
  assert.equal(Buffer.concat(await Array.fromAsync(source.stream())).toString(),'original '+clip);
  assert.equal(store.programs(owner).find(p=>p.id===id).stats.previews,1);
  const report = store.platformReport(owner);
  assert.equal(report.total.previews,1);
  assert.equal(report.total.films,3);
  assert.ok(report.rows.every(r => r.id !== clip));
});

test('legacy program uploads are classified once without reclassifying a standalone film used as an extra', async t => {
  const {store,owner,id,data,opening,film,directory,save} = await workspace(t);
  const standalone = film(owner, 'Another closing');
  const asExtra = (filmId,role) => ({filmId,role});
  const noOffer = {prices:{rent:null,buy:null},rentalHours:48,previewSeconds:0};
  for (const f of [opening,standalone]) store.setFilmSettings(owner,f,noOffer);
  store.setFilmPublication(owner,standalone,false); // An existing standalone listing, currently private.
  const lineup = [...data.members,asExtra(standalone,'closing')];
  save({members:lineup});
  const db = new DatabaseSync(join(directory,'setup.sqlite'));
  db.exec('DROP TABLE program_videos'); // Reopen the exact pre-feature schema.
  db.close();
  const upgraded = openSetupStore(directory);
  t.after(()=>upgraded.close());
  assert.deepEqual(upgraded.program(owner,id).members,lineup);
  assert.equal(upgraded.film(owner,opening).programId,id);
  assert.equal(upgraded.film(owner,standalone).programId,undefined);
  assert.ok(upgraded.dashboardFilms(owner).some(f=>f.id===standalone));
  assert.ok(!upgraded.dashboardFilms(owner).some(f=>f.id===opening));
  const later = film(owner,'New private standalone');
  store.setFilmSettings(owner,later,noOffer);
  save({members:[asExtra(later,'opening'),...data.members.slice(1)],previewFilmId:later});
  const reopened = openSetupStore(directory);
  try {
    assert.ok(reopened.dashboardFilms(owner).some(f=>f.id===later));
    assert.ok(!reopened.programLibrary(owner,id).some(f=>f.id===opening));
  } finally { reopened.close(); }
});
