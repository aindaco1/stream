import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSetupStore } from '../src/setup-store.js';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { createFileSource } from '../src/source.js';
import { revisionFor } from '../src/media.js';
import { createPublicFilms } from '../src/public-films.js';

const newId = () => 'f-' + randomUUID();
const head = { revision: '"original-revision"', size: 1000 };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stream-public-films-'));
  const store = openSetupStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const authority = createRentalAuthority(randomBytes(32));
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_localfixture' };
  const sourceCalls = [];
  const sourceFor = settings => {
    sourceCalls.push(settings);
    return { head: async () => head };
  };
  function seller(owner, account, settings = {}) {
    store.invite(owner);
    store.claimAccount(owner, account, 'test');
    const state = { mode: 'test', creatorId: owner, accountId: account, channel: 'hosted',
      status: 'ready', chargesEnabled: true, payoutsEnabled: true, ...settings };
    store.saveStripe(owner, { byMode: { test: state } });
    const bucket = { accountId: 'a'.repeat(32), jurisdiction: 'default', bucket: 'private-' + account.toLowerCase().slice(5) };
    const keys = { accessKeyId: 'test-' + owner, secretAccessKey: 'secret-' + owner };
    store.saveBucket(owner, { ...bucket, ...keys });
    return { owner, account, state, bucket, keys };
  }
  function film(seller, title, extra = {}) {
    const id = newId();
    const record = { title, revision: revisionFor(head), objectKey: 'originals/private.mp4', duration: 136,
      rights: { version: 'film-distribution-v1', statement: 'Rights accepted', acceptedAt: new Date().toISOString() }, ...extra, id };
    store.saveFilm(seller.owner, seller.bucket, record);
    return { owner: seller.owner, id };
  }
  return { root, store, env, authority, sourceFor, sourceCalls, seller, film };
}

test('only opted-in IDs publish, with a public projection and distinct receipt scopes per filmmaker', async t => {
  const f = await fixture(t);
  const a = f.seller('Private owner A', 'acct_SellerA');
  const b = f.seller('Private owner B', 'acct_SellerB');
  const first = f.film(a, 'First film');
  const second = f.film(b, 'Second film');
  const draft = f.film(a, 'Unlisted title');
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([first, second]);
  const catalog = createPublicFilms(f);
  assert.deepEqual(catalog.list(), [{ id: first.id, title: 'First film' }, { id: second.id, title: 'Second film' }]);
  const spec = catalog.get(first.id);
  const historicalFilm = 'saved/' + createHash('sha256').update(JSON.stringify([first.owner, first.id])).digest('hex');
  assert.equal(spec.scope, historicalFilm);
  assert.equal(spec.owner, first.owner);
  assert.equal(spec.account, a.account);
  assert.equal(spec.authority, f.authority);
  assert.equal(rentalScope({ film: spec.scope, revision: spec.revision }),
    rentalScope({ film: historicalFilm, revision: revisionFor(head) }));
  assert.notEqual(spec.scope, catalog.get(second.id).scope);
  assert.equal(catalog.get(draft.id), undefined);
  await assert.rejects(catalog.open(draft.id), /^Error: Film unavailable\.$/);
  await assert.rejects(catalog.verify(draft.id), /^Error: Film unavailable\.$/);
  assert.equal(f.sourceCalls.length, 0);
  assert.deepEqual(await catalog.verify(second.id), catalog.get(second.id));
  assert.deepEqual(f.sourceCalls, [{ ...b.bucket, ...b.keys, objectKey: 'originals/private.mp4' }]);
});

test('publication configuration is explicit, bounded, and fails closed on removal or malformed edits', async t => {
  const f = await fixture(t), a = f.seller('A', 'acct_123'), film = f.film(a, 'A film');
  const catalog = createPublicFilms(f);
  assert.deepEqual(catalog.list(), []);
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  assert.equal(catalog.get(film.id).id, film.id);
  for (const invalid of ['bad json', '{}', '[null]', JSON.stringify([{ ...film, leak: 'value' }]),
    JSON.stringify([{ owner: 'A', id: 'clock' }]), JSON.stringify([film, film]),
    JSON.stringify(Array.from({ length: 33 }, () => ({ owner: 'A', id: newId() })))]) {
    f.env.STREAM_PUBLIC_FILMS = invalid;
    assert.throws(() => catalog.list(), /Invalid STREAM_PUBLIC_FILMS/);
    await assert.rejects(catalog.verify(film.id), /Film unavailable/);
  }
  f.env.STREAM_PUBLIC_FILMS = '[]';
  assert.equal(catalog.get(film.id), undefined);
  assert.deepEqual(catalog.list(), []);
});

test('buyer lookups and bookmarked embeds survive a seller reset while new sales require the ready replacement',async t=>{
  const f = await fixture(t), a = f.seller('Filmmaker', 'acct_original');
  const film = f.film(a, 'The film');
  const unsold = f.film(a, 'No orders');
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film,unsold]);
  const catalog = createPublicFilms(f);
  const original = catalog.get(film.id);
  const order = f.store.reserveViewerOrder({...original, tokenHash:'abc', kind:'rent', amount:99,
    platform:'acct_platform',origin:'http://127.0.0.1:8787'});
  f.store.bindViewerSession(order.orderId,'cs_test_original');
  assert.equal(f.store.resetStripe(a.owner,'test',f.store.stripeContext(a.owner,'test').confirmation),true);
  assert.deepEqual(catalog.list(),[]);
  assert.equal(catalog.get(film.id),undefined);
  assert.equal(catalog.get(unsold.id,{entitled:true}),undefined);
  const entitled = await catalog.verify(film.id,{entitled:true});
  assert.equal(entitled.scope,original.scope);
  assert.equal(entitled.revision,original.revision);
  assert.equal(entitled.account,null);
  assert.equal(f.store.dashboardFilms(a.owner).length,2);
  const next = f.store.stripeContext(a.owner,'test');
  next.claimAccount('acct_replacement','test');
  Object.assign(next.state,a.state,{accountId:'acct_replacement'});
  next.save();
  assert.equal(catalog.get(film.id).account,'acct_replacement');
  assert.deepEqual(catalog.get(film.id,{entitled:true}),entitled);
  assert.ok(f.store.setFilmPublication(a.owner,film.id,false));
  assert.equal(catalog.get(film.id),undefined);
  assert.deepEqual(catalog.get(film.id,{entitled:true}),entitled);
});

test('rights, owner, sandbox mode, stored readiness and unique connected-account claim are all required', async t => {
  const f = await fixture(t), a = f.seller('A', 'acct_123'), film = f.film(a, 'Private');
  const wrongOwner = { owner: 'Another owner', id: film.id };
  const unsigned = f.film(a, 'Without consent', { rights: { acceptedAt: new Date().toISOString() } });
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([wrongOwner, unsigned]);
  const catalog = createPublicFilms(f);
  assert.deepEqual(catalog.list(), []);
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  for (const patch of [{ status: 'pending' }, { chargesEnabled: false }, { payoutsEnabled: false },
    { mode: 'live' }, { accountId: 'acct_unclaimed' }, { creatorId: 'Someone else' }, { channel: 'invalid' }]) {
    f.store.saveStripe(a.owner, { byMode: { test: { ...a.state, ...patch }, live: { ...a.state, mode: 'live' } } });
    assert.equal(catalog.get(film.id), undefined);
  }
  f.store.saveStripe(a.owner, { byMode: { test: a.state } });
  assert.equal(createPublicFilms({ ...f, platformAccount: a.account }).get(film.id), undefined);
  f.env.STRIPE_CONNECT_LIVE = '1';
  assert.equal(catalog.get(film.id), undefined);
  delete f.env.STRIPE_CONNECT_LIVE;
  delete f.env.STRIPE_CONNECT_SECRET_KEY;
  assert.equal(catalog.get(film.id), undefined);
  assert.equal(f.sourceCalls.length, 0);
});

test('saved technical inspection survives reopening the store and belongs to one film revision', async t => {
  const f = await fixture(t), seller = f.seller('Owner', 'acct_Owner');
  const revision = revisionFor(head), film = f.film(seller, 'With inspection');
  const other = f.film(seller, 'Other film');
  const media = { format: 'mov', duration: 136, subtitleTracks: [] };
  f.store.filmProbeCache(film.owner, film.id).set(revision, head.size, media);
  const reopened = openSetupStore(f.root);
  try {
    const saved = reopened.filmProbeCache(film.owner, film.id);
    assert.deepEqual(saved.get(revision, head.size), media);
    assert.equal(saved.get(revision, head.size + 1), undefined);
    saved.set('different', head.size, media);
    assert.equal(saved.get('different', head.size), undefined);
    assert.equal(reopened.filmProbeCache('Other owner', film.id).get(revision, head.size), undefined);
    assert.equal(reopened.filmProbeCache(film.owner, other.id).get(revision, head.size), undefined);
  } finally { reopened.close(); }
});

test('the indexed private film honors key rotation, replacement and unpublication on a cached renderer', async t => {
  const f = await fixture(t), seller = f.seller('Original owner', 'acct_Source');
  const path = join(f.root, 'fixture.mp4');
  execFileSync(process.execPath, ['scripts/fixture.js', path]);
  const original = createFileSource(path);
  const film = f.film(seller, 'Projection', { revision: revisionFor(await original.head()) });
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  let replaced = false;
  const observedKeys = [];
  const catalog = createPublicFilms({ ...f, sourceFor(settings) {
    assert.deepEqual([settings.accountId, settings.bucket, settings.objectKey],
      [seller.bucket.accountId, seller.bucket.bucket, 'originals/private.mp4']);
    observedKeys.push(settings.accessKeyId);
    return { read: original.read, head: () => replaced ? head : original.head() };
  } });
  const media = await catalog.open(film.id);
  t.after(() => media.close());
  assert.equal(media.duration, 136);
  assert.ok((await media.preview()).length > 0);
  f.store.saveBucket(seller.owner, { ...seller.bucket, accessKeyId: 'rotated', secretAccessKey: 'replacement' });
  await media.segment(1);
  assert.equal(observedKeys.at(-1), 'rotated');
  replaced = true;
  await assert.rejects(catalog.verify(film.id), /Film unavailable/);
  await assert.rejects(catalog.open(film.id), /Film unavailable/);
  await assert.rejects(media.preview(), /Film unavailable/);
  replaced = false;
  f.env.STREAM_PUBLIC_FILMS = '[]';
  await assert.rejects(media.segment(0), /Film unavailable/);
});

test('unpublication during remote validation prevents checkout and playback', async t => {
  const f = await fixture(t), film = f.film(f.seller('Seller', 'acct_Seller'), 'A film');
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  const catalog = createPublicFilms({ ...f, sourceFor() {
    return { async head() { f.env.STREAM_PUBLIC_FILMS = '[]'; return head; } };
  } });
  await assert.rejects(catalog.verify(film.id), /Film unavailable/);
  assert.equal(catalog.get(film.id), undefined);
});

test('a cached renderer cannot return a former preview after the filmmaker changes the paywall', async t => {
  const f = await fixture(t), film = f.film(f.seller('Seller', 'acct_Seller'), 'A film');
  let duringRender;
  const catalog = createPublicFilms({ ...f, async openMedia(source) {
    const info = await source.head();
    return { revision: revisionFor(info), async preview(seconds) { duringRender?.(); return seconds; } };
  } });
  await catalog.publish(film.owner, film.id);
  const media = await catalog.open(film.id);
  assert.equal(await media.preview(), 10);
  const set = previewSeconds => f.store.setFilmSettings(film.owner, film.id, { prices: { rent: 99, buy: null }, rentalHours: 24, previewSeconds });
  set(4);
  await assert.rejects(media.preview(10));
  assert.equal(await media.preview(), 4);
  duringRender = () => set(0);
  await assert.rejects(media.preview(4));
  await assert.rejects(media.preview());
});

test('only a buyer grant can stream an original range, including after new purchases are turned off', async t => {
  const f = await fixture(t), seller = f.seller('Maker', 'acct_ABC');
  const film = f.film(seller, 'My film');
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  let heads = 0, replaced = false;
  const calls = [];
  const catalog = createPublicFilms({ ...f, authority: {
    async verifyDownloadGrant(grant, binding) {
      assert.deepEqual(binding, { film: catalog.get(film.id).scope, revision: revisionFor(head) });
      if (grant !== 'buyer') throw new Error('Access unavailable.');
      return { orderId: 'order_1' };
    }
  }, sourceFor() {
    return {
      async head() { heads++; return replaced ? { ...head, revision: '"new"' } : head; },
      async *stream(identity, start, end) {
        calls.push([identity, start, end]);
        yield Uint8Array.from({ length: end - start }, (_, i) => (i + start) % 256);
      }
    };
  } });
  assert.deepEqual(catalog.get(film.id).prices, { rent: 99, buy: null });
  assert.ok(f.store.setFilmPrices(film.owner, film.id, { rent: 129, buy: 299 }));
  assert.deepEqual((await catalog.verify(film.id)).prices, { rent: 129, buy: 299 });
  assert.deepEqual(catalog.list(), [{ id: film.id, title: 'My film' }]);
  await assert.rejects(catalog.download(film.id, 'renter'), /Access unavailable/);
  assert.equal(heads, 1);
  assert.ok(f.store.setFilmPrices(film.owner, film.id, { rent: null, buy: null }));
  const file = await catalog.download(film.id, 'buyer');
  assert.deepEqual(Object.keys(file).sort(), ['contentType', 'extension', 'orderId', 'revision', 'size', 'stream', 'title']);
  assert.equal(file.orderId, 'order_1');
  assert.equal(file.extension, 'mp4');
  assert.equal(file.contentType, 'video/mp4');
  assert.equal(file.size, head.size);
  assert.deepEqual(await Array.fromAsync(file.stream(6, 10)), [Uint8Array.of(6, 7, 8, 9)]);
  assert.deepEqual(calls, [[head, 6, 10]]);
  await assert.rejects(Array.fromAsync(file.stream(0, head.size + 1)), /Invalid download range/);
  replaced = true;
  await assert.rejects(catalog.download(film.id, 'buyer'), /Film unavailable/);
  f.env.STREAM_PUBLIC_FILMS = '[]';
  await assert.rejects(Array.fromAsync(file.stream()), /Film unavailable/);
  assert.equal(calls.length, 1);
});

test('a long original download rechecks publication before delivering its next four-megabyte window', async t => {
  const f = await fixture(t), seller = f.seller('Maker', 'acct_ABC');
  const block = new Uint8Array(4 * 1024 * 1024);
  const large = { ...head, size: block.length * 2 };
  const film = f.film(seller, 'Feature', { revision: revisionFor(large) });
  f.env.STREAM_PUBLIC_FILMS = JSON.stringify([film]);
  let closed = false;
  const catalog = createPublicFilms({ ...f, authority: { async verifyDownloadGrant() { return { orderId: 'order_1' }; } },
    sourceFor: () => ({ head: async () => large, async *stream() {
      try { yield block; yield block; } finally { closed = true; }
    } }) });
  const file = await catalog.download(film.id, 'buyer');
  const iterator = file.stream();
  assert.equal((await iterator.next()).value.length, block.length);
  f.env.STREAM_PUBLIC_FILMS = '[]';
  await assert.rejects(iterator.next(), /Film unavailable/);
  assert.equal(closed, true);
});
