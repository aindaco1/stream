import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { staticAsset } from '../src/static-asset.js';

test('shared static files negotiate gzip and revalidate safely when a browser revisits', () => {
  const payload = Buffer.from('body { background: white; }\n'.repeat(80));
  const get = staticAsset('text/css', payload);
  const fetch = headers => get({headers}, (status,type,body,headers) => ({status,type,body,headers}));
  const identity = fetch({'accept-encoding':'gzip;q=0, *;q=1'});
  assert.deepEqual(identity.body,payload);
  const zipped = fetch({'accept-encoding':'br, gzip'});
  assert.deepEqual(gunzipSync(zipped.body),payload);
  assert.equal(zipped.headers['Cache-Control'],'public, no-cache');
  assert.equal(zipped.headers.Vary,'Accept-Encoding');
  const fresh = fetch({'if-none-match':'"unrelated", '+identity.headers.ETag});
  assert.equal(fresh.status,304);
  assert.equal(fresh.body,'');
  const changed = staticAsset('text/css',Buffer.from('changed'));
  assert.equal(changed({headers:{'if-none-match':zipped.headers.ETag}},status=>status),200);
});
