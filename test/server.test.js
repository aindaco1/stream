import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { filmSpec } from '../src/config.js';
import { makeServer } from '../src/server.js';

test('HTTP media boundaries on a multi-film page', async t => {
  const media = Buffer.from('public opening');
  const full = Buffer.from('private segment');
  const key = Buffer.alloc(16, 17);
  let rendered = 0;
  const film = { revision: 'cut1', segments: [{ duration: 4 }, { duration: 4 }],
    preview: async () => media, segment: async () => { rendered++; return full; }, close() {} };
  function check(grant, scope) {
    if (grant !== 'allow-clock' || scope.film !== 'clock' || scope.revision !== 'cut1') throw new Error();
  }
  const authority = {
    verifyGrant: check,
    keyForGrant(grant, scope) { check(grant, scope); return key; },
    exchange(receipt, scope) { check(receipt, scope); return { grant: 'allow-clock' }; }
  };
  const server = await makeServer(async maker => {
    assert.equal(maker, 'maker-a');
    return { film, authority };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, options) => fetch(base + path, options);
  const auth = { headers: { Authorization: 'Bearer allow-clock' } };
  const path = '/film/clock/';
  for (const asset of ['index.m3u8', 'key', '0.ts']) {
    assert.equal((await get(path + 'play/' + asset)).status, 403);
    assert.equal((await get('/film/second/play/' + asset, auth)).status, 403);
  }
  assert.equal(rendered, 0);
  const denied = await get(path + 'session', { method: 'POST', headers: { Origin: 'https://example.org', 'Content-Type': 'text/plain' }, body: 'allow-clock' });
  assert.equal(denied.status, 403);
  const session = await get(path + 'session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: 'allow-clock' });
  assert.deepEqual(await session.json(), { grant: 'allow-clock' });
  const list = await get(path + 'play/index.m3u8', auth);
  assert.match(await list.text(), /METHOD=AES-128,URI="key"/);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(list.url, /allow-clock/);
  assert.deepEqual(Buffer.from(await (await get(path + 'play/key', auth)).arrayBuffer()), key);
  const encrypted = Buffer.from(await (await get(path + 'play/1.ts', auth)).arrayBuffer());
  assert.ok(!encrypted.includes(full));
  const iv = Buffer.alloc(16);
  iv[15] = 1;
  const decrypt = createDecipheriv('aes-128-cbc', key, iv);
  assert.deepEqual(Buffer.concat([decrypt.update(encrypted), decrypt.final()]), full);
  assert.equal((await get(path + 'play/2.ts', auth)).status, 404);
  assert.equal((await get('/clock.mp4')).status, 404);
  const preview = await get(path + 'preview.mp4', { headers: { Range: 'bytes=0-5' } });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('content-range'), 'bytes 0-5/14');
  assert.equal(await preview.text(), 'public');
  assert.equal((await get(path + 'preview.mp4', { headers: { Range: 'bytes=14-' } })).status, 416);
  assert.equal(rendered, 1);
});

test('two makers can rent independently and cannot exchange each other’s receipts or grants', async t => {
  const opened = [];
  const titles = ['clock', 'feature'];
  const makers = new Map();
  const receipts = new Map();
  for (const title of titles) {
    const { maker, scope } = filmSpec(title);
    // Identical version markers exercise seller binding separately from the object ETag.
    const revision = 'shared-revision';
    const authority = createRentalAuthority(randomBytes(32));
    makers.set(maker, {
      authority, film: { revision, segments: [{ duration: 4 }],
        preview: async () => Buffer.from('preview-' + title),
        segment: async () => Buffer.from('rental-' + title), close() {} }
    });
    const entitlement = { film: scope, revision };
    const intent = {
      object: 'payment_intent', id: 'pi_' + title, status: 'succeeded', livemode: false,
      amount: 99, amount_received: 99, currency: 'usd',
      metadata: { product: 'stream-rental-prototype', scope: rentalScope(entitlement) },
      latest_charge: {
        object: 'charge', status: 'succeeded', payment_intent: 'pi_' + title, livemode: false,
        captured: true, paid: true, refunded: false, amount_refunded: 0, disputed: false,
        created: Math.floor(Date.now() / 1000)
      }
    };
    receipts.set(title, await authority.issueReceipt(intent, entitlement));
  }
  const server = await makeServer(async maker => { opened.push(maker); return makers.get(maker); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const session = (title, receipt) => fetch(base + '/film/' + title + '/session', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: receipt
  });
  const media = (title, asset, grant) => fetch(base + '/film/' + title + '/play/' + asset,
    { headers: { Authorization: 'Bearer ' + grant } });
  const buyers = await Promise.all(titles.map(async title => {
    const embed = await fetch(base + '/embed/' + title);
    assert.ok((await embed.text()).includes(filmSpec(title).title));
    const preview = await fetch(base + '/film/' + title + '/preview.mp4');
    assert.equal(await preview.text(), 'preview-' + title);
    const res = await session(title, receipts.get(title));
    assert.equal(res.status, 200);
    const { grant } = await res.json();
    const key = Buffer.from(await (await media(title, 'key', grant)).arrayBuffer());
    const segment = Buffer.from(await (await media(title, '0.ts', grant)).arrayBuffer());
    const cipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
    assert.equal(Buffer.concat([cipher.update(segment), cipher.final()]).toString(), 'rental-' + title);
    return grant;
  }));
  assert.deepEqual(opened.sort(), ['maker-a', 'maker-b']);
  for (let i = 0; i < titles.length; i++) {
    const other = titles[1 - i];
    assert.equal((await session(other, receipts.get(titles[i]))).status, 403);
    for (const asset of ['index.m3u8', 'key', '0.ts']) {
      assert.equal((await media(other, asset, buyers[i])).status, 403);
    }
  }
});

test('one unavailable maker cannot block or substitute content for another', async t => {
  const available = new Set(['maker-b']);
  const server = await makeServer(async maker => {
    if (!available.has(maker)) throw new Error('local test provider is unavailable');
    return { film: { preview: async () => Buffer.from(maker), close() {} }, authority: {} };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const preview = title => fetch(base + '/film/' + title + '/preview.mp4');
  const [down, up] = await Promise.all([preview('clock'), preview('feature')]);
  assert.equal(down.status, 503);
  assert.equal(await up.text(), 'maker-b');
  available.add('maker-a');
  assert.equal(await (await preview('clock')).text(), 'maker-a');
  assert.equal((await preview('unknown')).status, 404);
});
