import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
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
