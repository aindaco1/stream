import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { revisionFor } from '../src/media.js';
import { createPublicFilms } from '../src/public-films.js';
import { openSetupStore } from '../src/setup-store.js';
import { makeServer } from '../src/server.js';

test('the public server exposes published embeds and selects checkout from the verified film record', async t => {
  const films = [
    { id: 'film-a', owner: 'Private owner A', account: 'acct_sellerA', title: 'Film <A>' },
    { id: 'film-b', owner: 'Private owner B', account: 'acct_sellerB', title: 'Film B' }
  ];
  const get = id => films.find(f => f.id === id);
  const calls = [];
  const service = await makeServer(null, {
    catalog: {
      list: () => films.map(({ id, title }) => ({ id, title })), get,
      async verify(id) { calls.push(['verify', id]); return get(id); }
    },
    checkout: {
      async start({ offer }) { calls.push(['checkout', offer.account]); return { url: 'https://checkout.stripe.com/example' }; },
      async status({ offer }) { calls.push(['status', offer.account]); return { status: 'pending' }; },
      async webhook(raw, signature) { calls.push(['event', raw.toString(), signature]); return { received: true }; }
    }
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.close(resolve)));
  const origin = 'http://127.0.0.1:' + service.address().port;
  const request = (path, options) => fetch(origin + path, options);
  const token = randomBytes(32).toString('base64url');
  const post = (path, body, from = origin) => request(path, { method: 'POST', headers: { Origin: from, 'Content-Type': 'text/plain' }, body });

  const html = await (await request('/screening')).text();
  assert.match(html, /src="\/embed\/film-a" title="Film &lt;A&gt;"/);
  assert.equal(html.match(/loading="lazy"/g)?.length, 2);
  assert.match(html, /src="\/embed\/film-b"/);
  assert.doesNotMatch(html, /acct_|Private owner/);
  for (const path of ['/setup', '/setup/stripe', '/embed/clock', '/pay/unknown', '/embed/unlisted']) {
    assert.equal((await request(path)).status, 404);
  }
  assert.match((await request('/embed/film-a')).headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal((await request('/pay/film-a')).headers.get('x-frame-options'), 'DENY');
  assert.equal((await post('/film/film-a/checkout', token, 'https://publisher.example')).status, 403);
  assert.equal((await post('/film/film-a/checkout', JSON.stringify({ account: films[1].account }))).status, 400);
  assert.equal((await post('/film/film-a/checkout', 'a'.repeat(65))).status, 413);
  assert.deepEqual(calls, []);
  assert.equal((await post('/film/film-a/checkout', token)).status, 200);
  assert.deepEqual(await (await post('/film/film-b/order', token)).json(), { status: 'pending' });
  const event = await request('/checkout/webhook', { method: 'POST', headers: { 'Stripe-Signature': 'test-signature' }, body: '  {"event":true}\n' });
  assert.deepEqual(await event.json(), { received: true });
  assert.deepEqual(calls, [['verify', 'film-a'], ['checkout', 'acct_sellerA'], ['status', 'acct_sellerB'], ['event', '  {"event":true}\n', 'test-signature']]);
});

test('media indexes share concurrent opens, evict only idle renders, and reject excess capacity promptly', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => 'film-' + i);
  const films = new Map(ids.map(id => [id, { id, title: id, revision: 'v1', previewSeconds: 4 }]));
  const started = new Map(ids.map(id => [id, Promise.withResolvers()]));
  const gates = new Map(ids.slice(0, 8).map(id => [id, Promise.withResolvers()]));
  const opens = [], closes = [], premature = [];
  const server = await makeServer(null, { maxIndexes: 8, catalog: {
    get: id => films.get(id),
    async open(id) {
      opens.push(id);
      let rendering = 0;
      return { async preview() {
        rendering++;
        started.get(id).resolve();
        try { await gates.get(id)?.promise; return Buffer.from(id); } finally { rendering--; }
      }, close() { if (rendering) premature.push(id); closes.push(id); } };
    }
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = ids.slice(0, 8);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const preview = id => fetch(origin + '/film/' + id + '/preview.mp4', { signal: AbortSignal.timeout(5000) })
    .then(async response => [response.status, await response.text()]);
  const inflight = new Map(original.map(id => [id, preview(id)]));
  try {
    await Promise.all(original.map(id => started.get(id).promise));
    assert.deepEqual((await preview(ids[8]))[0], 503);
    assert.equal(opens.length, 8);
    const joined = preview(ids[0]);
    gates.get(ids[2]).resolve();
    assert.deepEqual(await inflight.get(ids[2]), [200, ids[2]]);
    assert.deepEqual(await preview(ids[8]), [200, ids[8]]);
    assert.deepEqual(closes, [ids[2]]);
    for (const id of [ids[3], ids[4]]) { gates.get(id).resolve(); await inflight.get(id); }
    assert.deepEqual(await preview(ids[3]), [200, ids[3]]);
    assert.deepEqual(await preview(ids[9]), [200, ids[9]]);
    assert.deepEqual(closes, [ids[2], ids[4]]);
    gates.get(ids[0]).resolve();
    assert.deepEqual(await joined, [200, ids[0]]);
    assert.equal(opens.filter(id => id === ids[0]).length, 1);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled(inflight.values());
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(premature, []);
  assert.deepEqual(closes.sort(), opens.sort());
});

test('only playback events count views, and disabled previews and rejected events perform no storage reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-view-events-'));
  const store = openSetupStore(directory);
  const id = 'f-' + randomUUID(), owner = 'Local filmmaker', account = 'acct_Fixture';
  const bucket = { accountId: 'a'.repeat(32), jurisdiction: 'default', bucket: 'private-fixture' };
  const source = { size: 4096, revision: '"original"' }, revision = revisionFor(source);
  const prices = { rent: 99, buy: null };
  store.invite(owner);
  store.claimAccount(owner, account, 'test');
  store.saveStripe(owner, { byMode: { test: { accountId: account, creatorId: owner, mode: 'test', channel: 'hosted',
    status: 'ready', chargesEnabled: true, payoutsEnabled: true } } });
  store.saveBucket(owner, { ...bucket, accessKeyId: 'fake', secretAccessKey: 'fake' });
  store.saveFilm(owner, bucket, { id, title: 'My <film>', objectKey: 'private-original.mp4', revision, duration: 90,
    previewSeconds: 0, rights: { version: 'v1', statement: 'Confirmed', acceptedAt: new Date().toISOString() } });
  store.setFilmPublication(owner, id, true);
  let reads = 0, allowed = false;
  const authority = { async verifyGrant(grant, binding) {
    if (grant !== 'paid-grant' || binding.film !== catalog.get(id, { entitled: true }).scope || binding.revision !== revision) throw Error();
    return { access: 'rent', orderId: 'paid-order' };
  } };
  const catalog = createPublicFilms({ store, authority, env: { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture' },
    sourceFor: () => ({ async head() { reads++; return source; } }),
    async openMedia(reader) { await reader.head(); return { revision, close() {}, async preview() { return Buffer.from('fixture'); } }; }
  });
  const server = await makeServer(null, { catalog, checkout: { accessAllowed: ({ orderId }) => allowed && orderId === 'paid-order' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/film/' + id;
  const event = randomUUID();
  const post = (body, headers) => fetch(base + '/view', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain', ...headers }, body });
  const counts = () => { const { previews, plays } = store.dashboardFilms(owner)[0].stats; return [previews, plays]; };
  for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-1' } }]) {
    assert.equal((await fetch(base + '/preview.mp4', options)).status, 403);
  }
  assert.equal((await post('preview ' + event)).status, 403);
  assert.equal((await fetch(base + '/view')).status, 405);
  assert.equal((await fetch(base + '/view', { method: 'HEAD' })).status, 405);
  assert.equal((await post('paid ' + event)).status, 403);
  assert.equal((await post('paid ' + event, { Authorization: 'Bearer wrong' })).status, 403);
  const auth = { Authorization: 'Bearer paid-grant' };
  assert.equal((await post('paid ' + event, auth)).status, 403);
  assert.deepEqual(counts(), [0, 0]);
  assert.equal(reads, 0);
  store.setFilmSettings(owner, id, { previewSeconds: 4, rentalHours: 48, prices });
  assert.equal((await post('preview ' + event, { Origin: 'https://publisher.example' })).status, 403);
  assert.equal((await post('preview ' + event, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('preview wrong')).status, 400);
  assert.equal((await post(' '.repeat(513))).status, 413);
  const published = await (await fetch(origin + '/embed/' + id)).text();
  assert.match(published, /My &lt;film&gt;/);
  assert.doesNotMatch(published, /private-original|private-fixture|Local filmmaker|acct_Fixture/);
  assert.equal(reads, 0);
  assert.equal((await fetch(base + '/preview.mp4', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base + '/preview.mp4', { headers: { Range: 'bytes=0-1' } })).status, 206);
  assert.deepEqual(counts(), [0, 0]);
  const mediaReads = reads;
  for (const status of await Promise.all([post('preview ' + event), post('preview ' + event)])) assert.equal(status.status, 200);
  allowed = true;
  assert.equal((await post('paid ' + event, auth)).status, 200);
  assert.equal((await post('paid ' + event, auth)).status, 200);
  assert.deepEqual(counts(), [1, 1]);
  assert.equal(reads, mediaReads);
  const order = store.reserveViewerOrder({ ...catalog.get(id), tokenHash: 'saved', platform: 'acct_Platform',
    origin, kind: 'rent', amount: 99 });
  store.bindViewerSession(order.orderId, 'cs_Fixture');
  store.setFilmPublication(owner, id, false);
  const closed = await (await fetch(origin + '/embed/' + id)).text();
  assert.match(closed, /Private screening/);
  assert.doesNotMatch(closed, /My &lt;film&gt;|private-original|Local filmmaker/);
  assert.equal((await post('preview ' + randomUUID())).status, 403);
  assert.equal((await post('paid ' + randomUUID(), auth)).status, 200);
  assert.deepEqual(counts(), [1, 2]);
  assert.equal(reads, mediaReads);
});

test('only a verified purchase can stream the saved original, including a byte range or a native download', async t => {
  const original = Buffer.from('original-film');
  let paid = true;
  const streamCalls = [];
  const offer = { id: 'test-film', scope: 'saved/test', revision: 'r1', prices: { rent: 99, buy: 299 }, title: 'My film', authority: {
    async exchange(receipt) {
      if (receipt !== 'purchase-receipt') throw Error();
      return { grant: 'purchase-grant' };
    },
    async verifyDownloadGrant(grant) {
      if (grant !== 'purchase-grant') throw Error();
      return { orderId: 'buy-1' };
    }
  } };
  const starts = [];
  const server = await makeServer(null, {
    catalog: {
      get: id => id === offer.id && offer, verify: async () => offer,
      async download(id, grant) {
        assert.equal(id, offer.id);
        assert.equal(grant, 'purchase-grant');
        return { size: original.length, title: 'Film\r\nÉ', async *stream(from, end) {
          streamCalls.push([from, end]);
          yield original.subarray(from, end);
        } };
      }
    },
    checkout: {
      async start({ kind }) { starts.push(kind); return { status: 'pending' }; },
      verifyPlayback: request => request.offer === offer && request.orderId === 'buy-1' && request.kind === 'buy' && paid,
      accessAllowed:({offer:film,orderId,kind})=>film===offer && orderId==='buy-1' && kind==='buy' && paid,
      async verifyPurchase(input) {
        assert.equal(input.offer, offer);
        assert.equal(input.orderId, 'buy-1');
        return paid;
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const prefix = origin + '/film/test-film/';
  const url = prefix + 'download';
  const auth = { Authorization: 'Bearer purchase-grant' };
  const token = randomBytes(32).toString('base64url');
  for (const action of ['checkout', 'buy']) {
    const response = await fetch(prefix + action, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: token });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(starts, ['rent', 'buy']);
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer rental-grant' } })).status, 403);
  paid = false;
  assert.equal((await fetch(url, { headers: auth })).status, 403);
  paid = true;
  const head = await fetch(url, { method: 'HEAD', headers: auth });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(original.length));
  assert.equal((await fetch(url, { headers: { ...auth, Range: 'bytes=15-21' } })).status, 416);
  assert.deepEqual(streamCalls, []);
  const range = await fetch(url, { headers: { ...auth, Range: 'bytes=1-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 1-3/' + original.length);
  assert.equal(await range.text(), 'rig');
  const body = new URLSearchParams({ receipt: 'purchase-receipt' });
  const crossSite = await fetch(url, { method: 'POST', headers: { Origin: 'https://publisher.example' }, body });
  assert.equal(crossSite.status, 403);
  const download = await fetch(url, { method: 'POST', headers: { Origin: origin }, body });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''Film%C3%89.mp4/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  assert.deepEqual(streamCalls, [[1, 4], [0, original.length]]);
});

test('a download already in progress closes before its next chunk after revocation',async t=>{
  let allowed=true;
  const resume=Promise.withResolvers();
  const offer={id:'film',scope:'saved/film',revision:'r1',title:'Film',
    authority:{async verifyDownloadGrant(){return {orderId:'paid'};}}};
  const server=await makeServer(null,{
    checkout:{verifyPurchase:async()=>allowed,accessAllowed:()=>allowed},
    catalog:{get:()=>offer,async download(){return {size:10,title:'Film',async *stream(){
      yield Buffer.from('first'); await resume.promise; yield Buffer.from('final');
    }};}}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/film/film/download';
  const response=await fetch(url,{headers:{Authorization:'Bearer grant'}});
  const reader=response.body.getReader();
  try {
    assert.equal(Buffer.from((await reader.read()).value).toString(),'first');
    allowed=false;
  } finally {resume.resolve();}
  await assert.rejects(reader.read());
});
