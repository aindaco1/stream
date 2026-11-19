import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { makeServer } from '../src/server.js';

test('HTTP media boundaries on a multi-film page', async t => {
  const media = Buffer.from('public opening');
  const full = Buffer.from('private segment');
  const key = Buffer.alloc(16, 17);
  let rendered = 0;
  const film = { revision: 'cut1', segments: [{ duration: 4 }, { duration: 4 }],
    preview: async () => media, segment: async () => { rendered++; return full; } };
  function check(grant, scope) {
    if (grant !== 'allow-clock' || scope.film !== 'clock' || scope.revision !== 'cut1') throw new Error();
  }
  const authority = {
    verifyGrant: check,
    keyForGrant(grant, scope) { check(grant, scope); return key; },
    exchange(receipt, scope) { check(receipt, scope); return { grant: 'allow-clock' }; }
  };
  const server = await makeServer(film, authority);
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
