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
