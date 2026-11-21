import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { airplayLeases, screenerReference } from '../src/airplay.js';
import { makeServer } from '../src/server.js';

test('receiver sessions stay bound to the rental and stop at idle timeout or the original expiry', () => {
  let time = 100_000;
  const leases = airplayLeases({ now: () => time, capacity: 1 });
  const offer = { id: 'a', scope: 'first/a', revision: 'v1' };
  const rental = { access: 'rent', orderId: 'one', rentalExpiresAt: 1300 };
  const session = leases.issue(offer, rental);
  assert.equal(leases.issue(offer, rental), session);
  assert.equal(leases.read(session.token, { ...offer, scope: 'other' }), undefined);
  assert.equal(leases.read(session.token, { ...offer, revision: 'v2' }), undefined);
  assert.throws(() => leases.issue(offer, { ...rental, orderId: 'two' }), { statusCode: 429 });
  time += 600_000;
  assert.equal(leases.read(session.token, offer), undefined);
  const replacement = leases.issue(offer, rental);
  assert.notEqual(replacement.token, session.token);
  time += 590_000;
  leases.touch(replacement);
  time = rental.rentalExpiresAt * 1000;
  assert.equal(leases.read(replacement.token, offer), undefined);
  assert.equal(leases.issue(offer, rental), undefined);
});

test('a paid receiver can read encrypted HLS and captions until access is withdrawn', async t => {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const rental = {access:'rent', orderId:'settled', rentalExpiresAt:expiry};
  let paid = true, opens = 0;
  const renders = [];
  const authority = { exchange(receipt, {film}) {
    if (film !== 'maker/film-a') throw Error();
    switch (receipt) {
      case 'rental': return rental;
      case 'purchase': return {...rental,access:'buy'};
      case 'expired': return {...rental,rentalExpiresAt:1};
      case 'legacy': return {...rental,orderId:undefined};
      default: throw Error();
    }
  }};
  const get = id => ({id, type:id === 'program' ? 'program' : 'film', revision:'one', scope:'maker/' + id,
    authority, screenerWatermark:true});
  const media = {segments:[{start:0,end:4,duration:4},{start:4,end:8,duration:4}],
    subtitleTracks:[{id:'s1',format:'text'},{id:'s2',format:'bitmap'}],
    subtitles:() => 'WEBVTT\n\n00:00:03.000 --> 00:00:06.000\nAcross a cut\n',
    segment(i, options) { renders.push(options); return Buffer.from('title segment ' + i); }, close() {}};
  const server = await makeServer(null, {catalog:{get, open:() => { opens++; return media; }},
    checkout:{ verifyPlayback:() => paid, accessAllowed:() => paid }});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (body, id = 'film-a', from = origin) => fetch(origin + '/film/' + id + '/airplay',
    {method:'POST', headers:{Origin:from,'Content-Type':'text/plain'}, body});
  for (const receipt of ['preview','purchase','expired','legacy']) assert.equal((await post(receipt)).status,403);
  assert.equal((await post('rental','film-a','https://publisher.example')).status,403);
  assert.equal((await post('rental','film-b')).status,403);
  assert.equal((await post('rental','program')).status,404);
  paid = false;
  assert.equal((await post('rental')).status,403);
  paid = true;
  const issued = await (await post('rental')).json();
  assert.equal(issued.expiresAt, expiry);
  assert.match(issued.path,/^\/film\/film-a\/airplay\/[A-Za-z0-9_-]{43}\/index\.m3u8$/);
  assert.equal(opens,0);
  const base = new URL(issued.path, origin);
  const read = suffix => fetch(new URL(suffix,base));
  assert.equal((await fetch(new URL(issued.path.replace('film-a','film-b'),origin))).status,403);
  assert.equal((await read('download')).status,404);
  assert.equal((await fetch(origin + '/film/film-a/download')).status,403);
  const playlist = await read('index.m3u8');
  assert.match(playlist.headers.get('cache-control'),/no-store/);
  assert.match(await playlist.text(),/#EXT-X-KEY:METHOD=AES-128,URI="key"/);
  const key = Buffer.from(await (await read('key')).arrayBuffer());
  const bytes = Buffer.from(await (await read('1.ts?subtitle=s2')).arrayBuffer());
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(1,12);
  const cipher = createDecipheriv('aes-128-cbc',key,iv);
  assert.equal(Buffer.concat([cipher.update(bytes),cipher.final()]).toString(),'title segment 1');
  assert.deepEqual(renders,[{subtitleId:'s2',watermark:screenerReference(get('film-a'),rental)}]);
  assert.match(await (await read('index.m3u8?subtitle=s1')).text(),/SUBTITLES.*captions\.m3u8\?subtitle=s1/);
  assert.match(await (await read('captions.m3u8?subtitle=s1')).text(),/1\.vtt\?subtitle=s1/);
  assert.match(await (await read('1.vtt?subtitle=s1')).text(),/LOCAL:00:00:04.000,MPEGTS:0[\s\S]*Across a cut/);
  assert.equal((await read('1.vtt?subtitle=s3')).status,404);
  paid = false;
  for (const path of ['index.m3u8','key','0.ts','1.vtt?subtitle=s1']) assert.equal((await read(path)).status,403);
  assert.equal(renders.length,1);
});

test('anonymous screener references distinguish rentals and are off for other access', () => {
  const spec = {scope:'publisher/title',screenerWatermark:true};
  const rent = {access:'rent',orderId:'first'};
  const mark = screenerReference(spec,rent);
  assert.match(mark,/^[0-9A-F]{8}$/);
  assert.notEqual(mark,screenerReference(spec,{...rent,orderId:'second'}));
  assert.equal(screenerReference({...spec,screenerWatermark:false},rent),undefined);
  assert.equal(screenerReference(spec,{access:'buy',orderId:'first'}),undefined);
});
