import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { guidedBucketForm, parseR2BucketUrl, R2SetupError } from '../src/setup-r2.js';

const accountId = 'a'.repeat(32);
const accessKeyId = 'b'.repeat(32);
const secretAccessKey = 'c'.repeat(64);
const bucket = 'private-films';
const bucketUrl = `https://dash.cloudflare.com/${accountId}/r2/eu/buckets/${bucket}`;
const form = { bucketUrl, privateConfirmed: 'yes' };
const legacy = 'MockToken'.repeat(4) + '1234';
const accountToken = 'cfat_' + legacy + 'ABC123';
const userToken = 'cfut_' + legacy + 'ABC123';
const verifyAccount = `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`;
const verifyUser = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
const activeToken = { id: accessKeyId, status: 'active' };
const verified = () => Response.json({ success: true, result: activeToken });

test('dashboard URL yields only the canonical private bucket coordinates', () => {
  for (const jurisdiction of ['default', 'eu', 'us', 'fedramp']) {
    for (const suffix of ['', '/', '/objects', '/settings/', '/metrics?view=usage#storage']) {
      assert.deepEqual(parseR2BucketUrl(`https://dash.cloudflare.com/${accountId.toUpperCase()}/r2/${jurisdiction}/buckets/${bucket}${suffix}`),
        { accountId, jurisdiction, bucket });
    }
  }
  assert.equal(parseR2BucketUrl(`https://dash.cloudflare.com/${accountId}/r2/buckets/${bucket}`).jurisdiction, 'default');
});

test('refuses unrelated hosts, credentials, public links, unrecognized routes and invalid coordinates', () => {
  for (const invalid of [null, {}, '/r2/overview', bucketUrl.replace('https:', 'http:'),
    bucketUrl.replace('dash.cloudflare.com', 'dash.cloudflare.com.other.test'),
    bucketUrl.replace('dash.', 'film@dash.'), bucketUrl.replace('.com', '.com:1234'),
    bucketUrl.replace('.com', '.com\\@attacker.test'), bucketUrl.replace('dash.cloudflare.com', 'public.r2.dev'),
    bucketUrl.replace('dash.cloudflare.com', `${accountId}.r2.cloudflarestorage.com`),
    bucketUrl.replace(accountId, 'short'), bucketUrl.replace('/eu/', '/weur/'), bucketUrl.replace(bucket, 'BAD'),
    bucketUrl.replace(bucket, '-bad'), bucketUrl.replace(bucket, 'a'.repeat(64)), bucketUrl + '/objects/film.mp4',
    bucketUrl.replace('/r2/', '/unrelated/../r2/'), bucketUrl.replace('/r2/', '/a/%2e%2e/r2/'),
    'https://dash.cloudflare.com/?to=/:account/r2/overview']) {
    assert.throws(() => parseR2BucketUrl(invalid), R2SetupError);
  }
});

test('verifies modern account and user tokens only against their own fixed endpoint and drops the bearer', async () => {
  for (const [tokenValue, endpoint] of [[accountToken, verifyAccount], [userToken, verifyUser],
    ['cfat_' + 'Z'.repeat(246) + '/.~+=', verifyAccount], ['cfut_Q.8~35', verifyUser]]) {
    const calls = [];
    const config = await guidedBucketForm({ ...form, tokenValue }, { fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${tokenValue}`);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
      return verified();
    } });
    assert.deepEqual(calls, [endpoint]);
    assert.deepEqual(config, { accountId, bucket, jurisdiction: 'eu', accessKeyId,
      secretAccessKey: createHash('sha256').update(tokenValue).digest('hex') });
    assert.equal(JSON.stringify(config).includes(tokenValue), false);
  }
});

test('legacy token tries the alternate ownership endpoint only after an authentication refusal', async () => {
  const calls = [];
  const config = await guidedBucketForm({ ...form, tokenValue: legacy }, { fetchImpl: async url => {
    calls.push(url);
    return url === verifyAccount ? new Response(null, { status: 403 }) : verified();
  } });
  assert.deepEqual(calls, [verifyAccount, verifyUser]);
  assert.equal(config.accessKeyId, accessKeyId);

  for (const [tokenValue, status, statusCode] of [[accountToken, 403, 400], [legacy, 429, 503], [legacy, 503, 503], [legacy, 302, 503]]) {
    let count = 0;
    await assert.rejects(guidedBucketForm({ ...form, tokenValue }, { fetchImpl: async () => {
      count++;
      return new Response(tokenValue, { status });
    } }), error => error instanceof R2SetupError && error.statusCode === statusCode && !error.message.includes(tokenValue));
    assert.equal(count, 1);
  }
});

test('rejects failed, inactive, malformed, out-of-window, and oversized verification responses', async () => {
  const invalid = [{ success: false, result: activeToken },
    ...[{ status: 'expired' }, { status: 'disabled' }, { id: 'not-a-token-id' }, { expires_on: '2000-01-01T00:00:00Z' },
      { not_before: '2099-01-01T00:00:00Z' }, { expires_on: 'invalid' }, { not_before: true }]
      .map(fields => ({ success: true, result: { ...activeToken, ...fields } })),
    { success: true, result: activeToken, extra: accountToken.repeat(500) }];
  for (const body of invalid) {
    await assert.rejects(guidedBucketForm({ ...form, tokenValue: accountToken }, {
      fetchImpl: async () => Response.json(body)
    }), error => error instanceof R2SetupError && !String(error).includes(accountToken));
  }
  await assert.rejects(guidedBucketForm({ ...form, tokenValue: accountToken }, {
    fetchImpl: async () => { throw new Error(accountToken); }
  }), error => error instanceof R2SetupError && error.statusCode === 503 && !String(error).includes(accountToken) && !error.cause);
});

test('requires attestation and one credential method before any contact, with a local S3 pair fallback', async () => {
  let calls = 0;
  const opts = { fetchImpl: async () => { calls++; return verified(); } };
  for (const bad of [{ ...form, tokenValue: accountToken, privateConfirmed: '' },
    { ...form, accessKeyId, secretAccessKey, privateConfirmed: '' }, { ...form, tokenValue: userToken, bucketUrl: 'https://example.com' },
    { ...form, tokenValue: accountToken, accessKeyId }, { ...form, accessKeyId },
    { ...form, accessKeyId: 'short', secretAccessKey }, { ...form, accessKeyId, secretAccessKey: userToken }, form,
    ...[secretAccessKey, accessKeyId, 'a'.repeat(40), 'cfk_' + legacy + 'ABC123', 'cfoat_' + legacy + 'ABC123',
      'cfat_' + 'a'.repeat(252), 'cfut_', 'cfut_a\tbad', 'cfat_header\r\ninjection',
      legacy + '\nInjected', 'https://anything.test/'].map(tokenValue => ({ ...form, tokenValue }))]) {
    await assert.rejects(guidedBucketForm(bad, opts), R2SetupError);
  }
  assert.deepEqual(await guidedBucketForm({ ...form, accessKeyId, secretAccessKey }, opts),
    { accountId, bucket, jurisdiction: 'eu', accessKeyId, secretAccessKey });
  assert.equal(calls, 0);
});
