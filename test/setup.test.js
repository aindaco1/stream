import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSetupStore } from '../src/setup-store.js';
import { createSetup } from '../src/setup.js';
import { makeServer } from '../src/server.js';
import { checkR2Bucket, createFileSource } from '../src/source.js';

const config = { accountId: 'c'.repeat(32), bucket: 'private-tests', jurisdiction: 'default',
  accessKeyId: 'example-id', secretAccessKey: 'example-secret-never-render', privateConfirmed: 'yes' };

test('a signed bucket HEAD uses the selected jurisdiction without enumerating films', async () => {
  for (const jurisdiction of ['eu', 'us', 'fedramp', 'default']) {
    await checkR2Bucket({ ...config, jurisdiction }, async req => {
      const suffix = jurisdiction === 'default' ? '' : '.' + jurisdiction;
      assert.equal(req.url, 'https://' + config.accountId + suffix + '.r2.cloudflarestorage.com/private-tests');
      assert.equal(req.method, 'HEAD');
      assert.equal(req.redirect, 'error');
      assert.ok(req.headers.has('authorization'));
      return new Response(null);
    });
  }
  await assert.rejects(checkR2Bucket(config, async () => new Response(null, { status: 403 })), /unavailable/);
});

test('filmmaker invitations, verified keys and account ownership survive reopening the store', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stream-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = openSetupStore(dir);
  t.after(() => store.close());
  const a = store.invite('Ada');
  const b = store.invite('Ben');
  const session = store.signIn(a);
  assert.equal(store.signIn(a), undefined);
  assert.equal(store.session(session).owner, 'Ada');
  store.saveBucket('Ada', config);
  assert.equal(store.claimAccount('Ada', 'account-test', 'test'), true);
  assert.equal(store.claimAccount('Ben', 'account-test', 'test'), false);
  assert.ok(store.signIn(b));
  store.close();
  store = openSetupStore(dir);
  assert.equal(store.session(session).owner, 'Ada');
  assert.equal(store.credentials('Ada', config).secretAccessKey, config.secretAccessKey);
  assert.throws(() => store.credentials('Ben', config));
  assert.equal((await stat(join(dir, 'credential.key'))).mode & 0o777, 0o600);
  for (const name of await readdir(dir)) {
    const bytes = await readFile(join(dir, name));
    assert.ok(!bytes.includes(config.secretAccessKey) && !bytes.includes(session) && !bytes.includes(a));
  }
  store.signOut(session);
  assert.ok(!store.session(session));
});

test('guided setup carries an authenticated filmmaker from empty storage to private preview and a fresh rights gate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stream-wizard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'film.mp4');
  execFileSync(process.execPath, ['scripts/fixture.js', file], { stdio: 'pipe' });
  const reads = [];
  const setup = await createSetup({
    directory: join(dir, 'state'), env: {},
    checkBucket: async settings => { if (settings.secretAccessKey !== config.secretAccessKey) throw Error(); },
    sourceFor: settings => {
      reads.push([settings.bucket, settings.objectKey]);
      if (settings.objectKey !== 'Projects/My Film.mp4') throw Error();
      return createFileSource(file);
    }
  });
  const server = await makeServer(() => { throw Error('unexpected public film access'); }, { setup });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const form = (path, fields, cookie = '') => fetch(origin + path, { redirect: 'manual', method: 'POST',
    headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams(fields) });
  async function login(owner) {
    const code = setup.store.invite(owner);
    const resp = await form('/setup/sign-in', { code });
    assert.equal(resp.status, 303);
    const cookie = resp.headers.get('set-cookie').split(';')[0];
    const page = await fetch(origin + '/setup', { headers: { Cookie: cookie } });
    const markup = await page.text();
    const csrf = markup.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    return { cookie, csrf };
  }
  const { cookie, csrf } = await login('Ada');
  const submit = (route, body) => form('/setup/' + route, { csrf, ...body }, cookie);
  const get = (path, extra = {}) => fetch(origin + path, { headers: { Cookie: cookie, ...extra } });
  let id = setup.store.maker('Ada').draft.id;
  const film = { draftId: id, title: 'The Screening', objectKey: 'Projects/My Film.mp4' };
  assert.equal((await form('/setup/r2', config, cookie)).status, 403);
  assert.equal((await submit('r2', { ...config, privateConfirmed: '' })).status, 400);
  const failed = await submit('r2', { ...config, secretAccessKey: 'incorrect-test-key' });
  assert.equal(failed.status, 422);
  assert.doesNotMatch(await failed.text(), /incorrect-test-key/);
  assert.equal((await submit('r2', config)).status, 303);
  assert.equal((await submit('film', film)).status, 403);
  assert.equal(reads.length, 0);
  assert.doesNotMatch(await (await get('/setup/dashboard/new')).text(), /Use an existing file/);
  assert.equal((await submit('rights', { draftId: id, rightsAccepted: 'yes' })).status, 303);
  assert.match(await (await get('/setup/dashboard/new')).text(), /Use an existing file/);
  assert.equal((await submit('film', { draftId: id, title: 'Working title', intent: 'save' })).status, 200);
  assert.equal(setup.store.maker('Ada').draft.title, 'Working title');
  assert.equal(reads.length, 0);
  assert.equal((await submit('film', { ...film, objectKey: 'Missing.mp4' })).status, 422);
  assert.equal((await submit('film', film)).status, 303);
  assert.equal((await submit('film', film)).status, 303);
  assert.equal(setup.store.films('Ada').length, 1);
  const original = setup.store.film('Ada', id);
  assert.ok(original.rights.acceptedAt);
  assert.deepEqual(original.prices, { rent: 99, buy: null });
  assert.match(await (await get('/setup/dashboard')).text(), /Edit prices and playback for The Screening/);
  const pricing = { filmId: id, rentPrice: '', buyPrice: '2.99' };
  assert.equal((await submit('film/prices', { ...pricing, buyPrice: '0.49' })).status, 422);
  assert.equal((await submit('film/prices', { ...pricing, buyPrice: '2.999' })).status, 422);
  assert.equal((await form('/setup/film/prices', pricing, cookie)).status, 403);
  const originalReads = reads.length;
  assert.equal((await submit('film/prices', pricing)).status, 303);
  assert.equal(reads.length, originalReads);
  assert.deepEqual(setup.store.film('Ada', id), { ...original, prices: { rent: null, buy: 299 } });
  const preview = '/setup/preview/' + id;
  const clip = await get(preview + '/clip.mp4', { Range: 'bytes=0-31' });
  assert.equal(clip.status, 206);
  assert.equal((await clip.arrayBuffer()).byteLength, 32);
  const other = await login('Ben');
  assert.equal((await form('/setup/film/prices', { ...pricing, csrf: other.csrf }, other.cookie)).status, 404);
  assert.equal((await fetch(origin + preview, { headers: { Cookie: other.cookie } })).status, 404);
  assert.equal((await fetch(origin + preview + '/clip.mp4')).status, 401);
  const replace = await submit('r2', { ...config, bucket: 'future-films' });
  assert.equal(replace.status, 303);
  assert.equal((await get(preview + '/clip.mp4')).status, 200);
  assert.deepEqual(reads.at(-1), [config.bucket, film.objectKey]);
  assert.equal((await submit('next', { draftId: id })).status, 303);
  assert.equal((await submit('rights', { draftId: id, rightsAccepted: 'yes' })).status, 409);
  id = setup.store.maker('Ada').draft.id;
  assert.equal((await submit('film', { ...film, draftId: id })).status, 403);
  assert.equal((await submit('film/prices', { ...pricing, rentPrice: '1.25', buyPrice: '' })).status, 303);
  assert.deepEqual(setup.store.film('Ada', pricing.filmId).prices, { rent: 125, buy: null });
  assert.equal((await submit('rights', { draftId: id, rightsAccepted: 'yes' })).status, 303);
  const updated = { ...film, draftId: id, title: 'Another film', rentPrice: '1.49', buyPrice: '4.99' };
  assert.equal((await submit('film', { ...updated, intent: 'save' })).status, 200);
  assert.match(await (await get('/setup/dashboard/new')).text(), /name="buyPrice"[^>]*value="4\.99"/);
  assert.equal((await submit('film', updated)).status, 303);
  assert.deepEqual(setup.store.film('Ada', id).prices, { rent: 149, buy: 499 });
  assert.match(await (await get('/setup/dashboard')).text(), /Edit prices and playback for The Screening/);
  assert.equal((await submit('sign-out', {})).status, 303);
  assert.equal((await get(preview)).status, 401);
});
