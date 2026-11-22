import assert from 'node:assert/strict';
import test from 'node:test';
import { listBucketVideos } from '../src/bucket-videos.js';

const settings = {accountId:'a'.repeat(32), bucket:'sample-bucket', jurisdiction:'eu', accessKeyId:'example', secretAccessKey:'example'};
const xml = (contents, truncated, cursor = '') => '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><EncodingType>url</EncodingType><IsTruncated>' + truncated + '</IsTruncated>' +
  contents.map(([key, bytes]) => '<Contents><Key>' + encodeURIComponent(key) + '</Key><Size>' + bytes + '</Size></Contents>').join('') +
  (cursor ? '<NextContinuationToken>' + cursor + '</NextContinuationToken>' : '') + '</ListBucketResult>';

test('R2 lists ordered pages using the current bucket and preserves special characters in film names', async () => {
  const keys = ['Intro & credits.mov','cuts/Niña 100% + <final>.MKV','upload.MP4'];
  const fetcher = async req => {
    const u = new URL(req.url);
    assert.equal(req.method,'GET');
    assert.equal(u.hostname,settings.accountId + '.eu.r2.cloudflarestorage.com');
    assert.equal(u.pathname,'/' + settings.bucket);
    assert.equal(u.searchParams.get('encoding-type'),'url');
    assert.equal(u.searchParams.get('list-type'),'2');
    assert.ok(req.headers.get('authorization'));
    if (u.searchParams.get('continuation-token') === 'p+/=&') return new Response(xml([[keys[2],50]],false));
    assert.equal(u.searchParams.has('continuation-token'),false);
    return new Response(xml([[keys[0],10_000_000_000],[keys[1],200],['too-long.mp4',10_000_000_001],['thumbnail.jpg',30],['masters/cut',4],['master.final-v2',5],['empty.mp4',0],['../invalid.mp4',2]],true,'p+/=&amp;'));
  };
  const a = await listBucketVideos(settings,{},fetcher);
  assert.deepEqual(a.files.map(f => f.key),keys.slice(0,2));
  assert.equal(a.next,'p+/=&');
  const all = await listBucketVideos(settings,{allFiles:true},fetcher);
  assert.deepEqual(all.files.map(f => f.key), [...keys.slice(0,2),'thumbnail.jpg','masters/cut','master.final-v2']);
  assert.ok(all.files.slice(2).every(file => file.other));
  assert.deepEqual(await listBucketVideos(settings,{cursor:a.next},fetcher),{files:[{key:keys[2],bytes:50}],next:null});
});

test('provider failures and incomplete or repeated continuation return a retryable error', async () => {
  for (const result of [new Response('no',{status:403}), new Response('<Error/>'),new Response(xml([],true)),new Response(xml([],true,'again'))]) {
    await assert.rejects(listBucketVideos(settings,{cursor:'again'},async () => result));
  }
});
