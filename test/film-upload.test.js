import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFilmUploads, FilmUploadError, UPLOAD_PART_BYTES } from '../src/film-upload.js';
import { openSetupStore } from '../src/setup-store.js';
import { filmUploadBucket } from './fixtures/film-upload-r2.js';

const owner = 'director';
const draftId = 'f-' + randomUUID();
const bucket = { accountId: 'a'.repeat(32), bucket: 'films', jurisdiction: 'eu' };
const rights = { version: 'film-distribution-v1', statement: 'I hold the distribution rights.', acceptedAt: '2025-01-01T00:00:00Z' };
const credentials = { accessKeyId: 'b'.repeat(32), secretAccessKey: 'c'.repeat(64) };
const denied = code => error => error instanceof FilmUploadError && error.statusCode === code;

function fixture() {
  const r2 = filmUploadBucket();
  const states = new Map();
  const key = (who, id) => who + '/' + id;
  const maker = { draft: { id: draftId, rights }, r2: { ...bucket } };
  const options = { savedFilm: false, writer: true };
  const store = {
    maker: who => who === owner ? structuredClone(maker) : undefined,
    film: () => options.savedFilm,
    upload: (who, id) => structuredClone(states.get(key(who, id))),
    saveUpload: (who, id, value) => states.set(key(who, id), structuredClone(value)),
    clearUpload: (who, id) => states.delete(key(who, id)),
    finishUpload(who, id, objectKey) {
      states.get(key(who, id)).complete = true;
      maker.draft.objectKey = objectKey;
    },
    credentials: (_, location) => ({ ...location, ...credentials, accessKeyId: 'd'.repeat(32) }),
    uploadCredentials: (_, location) => options.writer ? { ...location, ...credentials } : undefined
  };
  const fetchImpl = async req => options.handle ? options.handle(req, r2.fetcher) : r2.fetcher(req);
  const service = () => createFilmUploads(store, { fetchImpl });
  return { service, r2, options, maker, store, api: service() };
}

test('rights, current unsaved draft, authenticated owner, writer, size and file identity gate all R2 traffic', async () => {
  const { api, r2, maker, options } = fixture();
  const file = { fileId: randomUUID(), size: 10 };
  for (const size of [0, 1.5, -1, NaN, '10', 1024 ** 3 + 1]) {
    await assert.rejects(api.start(owner, draftId, { ...file, size }), denied(413));
  }
  await assert.rejects(api.start(owner, draftId, { ...file, fileId: '../other.mov' }), denied(400));
  await assert.rejects(api.start('other', draftId, file), denied(409));
  await assert.rejects(api.start(owner, 'stale-draft', file), denied(409));
  options.savedFilm = true;
  await assert.rejects(api.start(owner, draftId, file), denied(409));
  options.savedFilm = false;
  options.writer = false;
  await assert.rejects(api.start(owner, draftId, file), denied(403));
  options.writer = true;
  for (const invalid of [null, {}, { ...rights, acceptedAt: 'invalid' }, { ...rights, statement: '' }]) {
    maker.draft.rights = invalid;
    await assert.rejects(api.start(owner, draftId, file), denied(403));
  }
  assert.equal(r2.calls.length, 0);
  maker.draft.rights = rights;
  assert.equal((await api.start(owner, draftId, { ...file, size: 1024 ** 3 })).nextPart, 1);
});

test('replays bounded sequential parts across restart, creates a new object only, and finishes the draft once', async () => {
  const { api, r2, store, service, maker } = fixture();
  const data = Buffer.alloc(UPLOAD_PART_BYTES + 3, 23);
  const file = { fileId: randomUUID(), size: data.length, objectKey: 'existing.mp4', bucket: 'other' };
  maker.draft.objectKey = 'existing.mp4';
  const prior = { data: Buffer.from('original'), headers: new Headers() };
  r2.objects.set('existing.mp4', prior);
  const start = await api.start(owner, draftId, file);
  const { uploadId } = start;
  assert.deepEqual(start, { uploadId, partSize: UPLOAD_PART_BYTES, nextPart: 1, complete: false });
  assert.match(uploadId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await service().start(owner, draftId, file), start);
  await assert.rejects(api.start(owner, draftId, { ...file, fileId: randomUUID() }), denied(409));
  await assert.rejects(api.start(owner, draftId, { ...file, size: 17 }), denied(409));
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(409));
  await assert.rejects(api.part(owner, draftId, uploadId, 2, data.subarray(-3)), denied(409));
  await assert.rejects(api.part(owner, draftId, randomUUID(), 1, data), denied(409));
  await assert.rejects(api.part('other', draftId, uploadId, 1, data), denied(409));
  await assert.rejects(api.part(owner, draftId, uploadId, 1, data), denied(400));
  assert.equal(r2.calls.length, 1);
  const first = data.subarray(0, UPLOAD_PART_BYTES);
  assert.equal((await api.part(owner, draftId, uploadId, 1, first)).nextPart, 2);
  assert.equal((await service().part(owner, draftId, uploadId, 1, first)).nextPart, 2);
  await assert.rejects(api.part(owner, draftId, uploadId, 1, Buffer.alloc(first.length)), denied(409));
  assert.equal(r2.calls.length, 2);
  await api.part(owner, draftId, uploadId, 2, data.subarray(UPLOAD_PART_BYTES));
  const result = await service().complete(owner, draftId, uploadId);
  assert.equal(result.complete, true);
  assert.match(result.objectKey, /^stream-films\/[a-f0-9-]{36}\.mp4$/);
  assert.deepEqual(r2.objects.get(result.objectKey).data, data);
  assert.equal(r2.objects.get('existing.mp4'), prior);
  assert.equal(maker.draft.objectKey, result.objectKey);
  assert.deepEqual(await api.complete(owner, draftId, uploadId), result);
  assert.deepEqual(api.status(owner, draftId), result);
  assert.equal(r2.calls.length, 4);
  assert.equal(r2.calls[0].headers.get('if-none-match'), '*');
  assert.equal(r2.calls[3].headers.get('if-none-match'), '*');
  assert.ok(r2.calls.every(call => call.key === result.objectKey && call.headers.has('x-amz-security-token')));
  const actions = ['CreateMultipartUpload', 'UploadPart', 'UploadPart', 'CompleteMultipartUpload'];
  for (const [i, call] of r2.calls.entries()) {
    const session = Buffer.from(call.headers.get('x-amz-security-token'), 'base64').toString();
    const claims = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString());
    assert.equal(claims.bucket, bucket.bucket);
    assert.deepEqual(claims.paths, { objectPaths: [result.objectKey] });
    assert.deepEqual(claims.actions, [actions[i]]);
    assert.equal(claims.scope, undefined);
  }
  const raw = JSON.stringify(result) + JSON.stringify(store.upload(owner, draftId));
  assert.ok(!raw.includes(credentials.secretAccessKey));
  const remoteId = r2.calls[1].query.get('uploadId');
  assert.ok(remoteId && !JSON.stringify(result).includes(remoteId));
});

test('lost initiation and part replies cannot mix files or change bytes under a pending part', async () => {
  const { api, options, r2, service } = fixture();
  const file = { fileId: randomUUID(), size: 5 };
  const data = Buffer.from('abcde');
  const loseReply = async (req, send) => { await send(req); throw Error(credentials.secretAccessKey); };
  options.handle = loseReply;
  await assert.rejects(api.start(owner, draftId, file), err => denied(503)(err) && !String(err).includes(credentials.secretAccessKey));
  assert.equal(r2.objects.size, 0);
  assert.equal([...r2.uploads.values()][0].parts.size, 0);
  const localId = api.status(owner, draftId).uploadId;
  delete options.handle;
  assert.equal((await service().start(owner, draftId, file)).uploadId, localId);
  options.handle = loseReply;
  await assert.rejects(api.part(owner, draftId, localId, 1, data), denied(503));
  delete options.handle;
  await assert.rejects(service().part(owner, draftId, localId, 1, Buffer.from('12345')), denied(409));
  assert.equal((await api.part(owner, draftId, localId, 1, data)).nextPart, 2);
  assert.equal((await api.complete(owner, draftId, localId)).complete, true);
});

test('lost completion reconciles R2 metadata and size before attaching the finished object', async () => {
  const { api, r2, options, maker, service } = fixture();
  const { uploadId } = await api.start(owner, draftId, { fileId: randomUUID(), size: 4 });
  await api.part(owner, draftId, uploadId, 1, Buffer.from('film'));
  options.handle = async (req, send) => { await send(req); throw Error('lost completion'); };
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(503));
  const key = r2.calls[0].key;
  assert.equal(maker.draft.objectKey, undefined);
  delete options.handle;
  const headers = r2.objects.get(key).headers;
  headers.set('content-length', '99');
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(409));
  headers.set('content-length', '4');
  const marker = headers.get('x-amz-meta-write-id');
  headers.set('x-amz-meta-write-id', randomUUID());
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(409));
  assert.equal(maker.draft.objectKey, undefined);
  headers.set('x-amz-meta-write-id', marker);
  assert.equal((await service().complete(owner, draftId, uploadId)).objectKey, key);
  assert.equal(r2.calls.at(-1).method, 'HEAD');
  assert.match(r2.calls.at(-1).headers.get('authorization'), new RegExp('Credential=' + 'd'.repeat(32)));
});

test('cancels unfinished work only, supports a lost abort reply, and protects a concurrent unrelated object', async () => {
  const { api, r2, options, maker } = fixture();
  const { uploadId } = await api.start(owner, draftId, { fileId: randomUUID(), size: 4 });
  await api.part(owner, draftId, uploadId, 1, Buffer.from('film'));
  const key = r2.calls[0].key;
  const foreign = { data: Buffer.from('keep'), headers: new Headers({ 'content-length': '4', 'x-amz-meta-write-id': randomUUID() }) };
  r2.objects.set(key, foreign);
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(409));
  assert.equal(r2.objects.get(key), foreign);
  maker.r2 = { ...bucket, bucket: 'another-bucket' };
  await assert.rejects(api.part(owner, draftId, uploadId, 1, Buffer.from('film')), denied(409));
  await assert.rejects(api.cancel(owner, draftId, randomUUID()), denied(409));
  options.handle = async (req, send) => { await send(req); throw Error('lost abort'); };
  await assert.rejects(api.cancel(owner, draftId, uploadId), denied(503));
  delete options.handle;
  assert.deepEqual(await api.cancel(owner, draftId, uploadId), { cancelled: true });
  assert.deepEqual(await api.cancel(owner, draftId, uploadId), { cancelled: true });
  assert.equal(r2.objects.get(key), foreign);
  assert.equal(api.status(owner, draftId), null);
  assert.ok(r2.calls.filter(call => call.method === 'DELETE').every(call => call.query.get('uploadId')));
});

test('a 200 error document is retriable, and late cancellation preserves an upload completed by R2', async () => {
  const { api, options, r2, maker } = fixture();
  const { uploadId } = await api.start(owner, draftId, { fileId: randomUUID(), size: 5 });
  await api.part(owner, draftId, uploadId, 1, Buffer.from('hello'));
  options.handle = async () => new Response('<Error><Message>' + credentials.secretAccessKey + '</Message></Error>');
  await assert.rejects(api.complete(owner, draftId, uploadId), err => denied(503)(err) && !String(err).includes(credentials.secretAccessKey));
  assert.equal(maker.draft.objectKey, undefined);
  options.handle = async (req, send) => { await send(req); throw Error('lost completion'); };
  await assert.rejects(api.complete(owner, draftId, uploadId), denied(503));
  delete options.handle;
  await assert.rejects(api.cancel(owner, draftId, uploadId), denied(409));
  assert.ok(api.status(owner, draftId).complete);
  assert.equal(r2.objects.get(maker.draft.objectKey).data.toString(), 'hello');
  await assert.rejects(api.cancel(owner, draftId, uploadId), denied(409));
});

test('SQLite preserves the selected file, confirmed parts and completed object after process restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-film-upload-'));
  let store = openSetupStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const r2 = filmUploadBucket();
  const uploads = () => createFilmUploads(store, { fetchImpl: r2.fetcher });
  store.invite(owner);
  store.invite('another-director');
  const id = store.maker(owner).draft.id;
  store.saveBucket(owner, { ...bucket, ...credentials, uploads: true });
  store.saveDraft(owner, { id, rights });
  const file = { fileId: randomUUID(), size: 4 };
  const { uploadId } = await uploads().start(owner, id, file);
  await uploads().part(owner, id, uploadId, 1, Buffer.from('film'));
  store.close();
  store = openSetupStore(directory);
  await assert.rejects(uploads().complete('another-director', id, uploadId), denied(409));
  assert.equal((await uploads().start(owner, id, file)).nextPart, 2);
  const finished = await uploads().complete(owner, id, uploadId);
  store.close();
  store = openSetupStore(directory);
  assert.equal(store.maker(owner).draft.objectKey, finished.objectKey);
  assert.deepEqual(await uploads().complete(owner, id, uploadId), finished);
  assert.equal(r2.calls.length, 3);
});
