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

test('a purchased original streams on demand from one signed conditional R2 range GET', async () => {
  const size = BLOCK_SIZE * 16;
  const start = 12, end = size - 5;
  let request, pulls = 0, offset = start;
  const source = createR2Source(config, async input => {
    assert.equal(request, undefined);
    request = input;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (offset === end) return controller.close();
        const length = Math.min(BLOCK_SIZE, end - offset);
        controller.enqueue(new Uint8Array(length).fill(pulls));
        offset += length;
      }
    }, { highWaterMark: 0 });
    return new Response(body, { status: 206, headers: {
      etag: head.revision, 'content-length': String(end - start), 'content-range': `bytes ${start}-${end - 1}/${size}`
    } });
  });
  const stream = source.stream({ size, revision: head.revision }, start, end);
  assert.equal(request, undefined);
  let count = 0;
  for await (const chunk of stream) {
    assert.equal(chunk[0], Math.floor(count / BLOCK_SIZE) + 1);
    assert.equal(pulls, chunk[0]);
    count += chunk.length;
  }
  assert.equal(count, end - start);
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('if-match'), head.revision);
  assert.equal(request.headers.get('range'), `bytes=${start}-${end - 1}`);
  assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
});

test('a cancelled original download stops R2 and invalid response metadata or byte counts fail closed', async () => {
  let request, cancelled = false;
  const signal = new AbortController();
  const source = createR2Source(config, async input => {
    request = input;
    const body = new ReadableStream({ pull(target) { target.enqueue(Uint8Array.of(1)); }, cancel() { cancelled = true; } });
    return new Response(body, { status: 206, headers });
  });
  const it = source.stream(head, 2, 5, signal.signal);
  await it.next();
  signal.abort();
  assert.equal(request.signal.aborted, true);
  await assert.rejects(it.next());
  assert.equal(cancelled, true);

  for (const [status, changes, data] of [[206, {}, '12'], [206, {}, '1234'], [200, {}, '123'],
    [206, { etag: '"replacement"' }, '123'], [206, { 'content-range': 'bytes 0-2/15' }, '123'],
    [206, { 'content-length': '4' }, '123']]) {
    const source = createR2Source(config, async () => new Response(data, { status, headers: { ...headers, ...changes } }));
    await assert.rejects(Array.fromAsync(source.stream(head, 2, 5)));
  }
});
