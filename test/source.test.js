import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR2Source, BLOCK_SIZE } from '../src/source.js';

const config = {
  accountId: 'a'.repeat(32), bucket: 'synthetic-test', objectKey: 'synthetic/clock 1.mp4',
  accessKeyId: 'test-id', secretAccessKey: 'test-secret'
};
const head = { size: 15, revision: '"fixture-revision"' };
const headers = { 'content-length': '3', 'content-range': 'bytes 2-4/15', etag: head.revision };

test('R2 uses signed HEAD and conditional ranged GET for the configured object', async t => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 15000);
    return timeout.signal;
  });
  const calls = [];
  const source = createR2Source(config, async request => {
    calls.push(request);
    return request.method === 'HEAD' ?
      new Response(null, { headers: { etag: head.revision, 'content-length': '15' } }) :
      new Response(Uint8Array.of(2, 3, 4), { status: 206, headers });
  });
  const identity = await source.head();
  assert.deepEqual(identity, head);
  assert.deepEqual(await source.read(identity, 2, 5), Uint8Array.of(2, 3, 4));
  assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET']);
  for (const call of calls) {
    assert.equal(call.url, 'https://' + config.accountId + '.r2.cloudflarestorage.com/synthetic-test/synthetic/clock%201.mp4');
    assert.equal(call.redirect, 'error');
    assert.equal(call.signal.aborted, false);
    assert.match(call.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
  }
  assert.equal(calls[1].headers.get('if-match'), head.revision);
  assert.equal(calls[1].headers.get('range'), 'bytes=2-4');
  timeout.abort();
  assert.ok(calls.every(call => call.signal.aborted));
});

test('R2 rejects an unavailable revision, unexpected ranges and incomplete reads', async () => {
  for (const [status, overrides, data] of [
    [200, {}, '123'], [412, {}, ''], [206, { etag: '"changed"' }, '123'],
    [206, { 'content-range': 'bytes 1-3/15' }, '123'], [206, {}, '1'], [206, {}, '1234']
  ]) {
    const source = createR2Source(config, async () => new Response(data, { status, headers: { ...headers, ...overrides } }));
    await assert.rejects(source.read(head, 2, 5));
  }
  const source = createR2Source(config, () => assert.fail('Invalid ranges must be rejected locally.'));
  await assert.rejects(source.read({ ...head, size: BLOCK_SIZE * 2 }, 0, BLOCK_SIZE + 1));
  await assert.rejects(source.read(head, -1, 1));
  await assert.rejects(source.read(head, 12, 16));
  assert.throws(() => createR2Source({ ...config, objectKey: '../another-bucket/key' }));
});
