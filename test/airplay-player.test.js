import assert from 'node:assert/strict';
import test from 'node:test';
import { attachAirPlay, requestAirPlayLease } from '../public/airplay.js';

const prefix = '/film/test-film';
const path = prefix + '/airplay/' + 'a'.repeat(43) + '/index.m3u8';
const rentalEnd = () => Math.floor(Date.now() / 1000) + 3600;

test('a receiver URL stays within the rented film and cannot outlive the rental', async t => {
  const end = rentalEnd();
  const reply = t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, prefix + '/airplay');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, 'private-receipt');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    return Response.json({path, expiresAt:end});
  });
  const issue = () => requestAirPlayLease(prefix, 'private-receipt', end);
  assert.deepEqual(await issue(), {path, expiresAt:end});
  for (const value of [
    {path:path.replace('test-film','other-film'), expiresAt:end},
    {path:'https://other.invalid'+path, expiresAt:end}, {path:path+'?receipt=private', expiresAt:end},
    {path, expiresAt:end + 1}, {path, expiresAt:1}
  ]) {
    reply.mock.mockImplementation(async () => Response.json(value));
    assert.equal(await issue(), undefined);
  }
  reply.mock.mockImplementation(async () => new Response(null, {status:403}));
  assert.equal(await issue(), undefined);
});

function viewer() {
  const button = Object.assign(new EventTarget(), {hidden:true, attributes:new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); }});
  const video = Object.assign(new EventTarget(), {currentTime:0, duration:60, readyState:2, preload:'none',
    opens:0, loads:0, muted:true, closest:() => ({querySelector:() => button}), canPlayType:() => 'maybe',
    webkitShowPlaybackTargetPicker() { this.opens++; }, load() { this.loads++; }});
  return {video, button};
}

test('only an active rental can open its own picker, and changing captions retains its lease and position', () => {
  const {video, button} = viewer(), other = viewer();
  const native = attachAirPlay(video, {});
  attachAirPlay(other.video, {});
  assert.equal(native.supported, true);
  button.dispatchEvent(new Event('click'));
  assert.equal(video.opens, 0);
  const playback = [], retry = [];
  const player = native.open({path, expiresAt:rentalEnd()}, {caption:'s1', position:12, autoplay:true,
    ready: play => playback.push(play), retry:(position,play) => retry.push([position,play]),
    expire:() => assert.fail('unexpired rental')});
  try {
    assert.equal(button.hidden, false);
    assert.equal(other.button.hidden, true);
    assert.equal(video.src, path+'?subtitle=s1');
    video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.currentTime, 12);
    assert.equal(video.muted, true);
    assert.deepEqual(playback, [true]);
    button.dispatchEvent(new Event('click'));
    assert.equal(video.opens, 1);
    video.webkitCurrentPlaybackTargetIsWireless = true;
    video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    assert.equal(button.attributes.get('aria-pressed'), 'true');
    player.selectAirPlaySubtitle('s2', 14, true);
    player.selectAirPlaySubtitle('', 16, false);
    video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.src, path);
    assert.equal(video.currentTime, 16);
    assert.deepEqual(playback, [true, false]);
    video.dispatchEvent(new Event('play'));
    video.currentTime = 20;
    video.dispatchEvent(new Event('timeupdate'));
    video.error = {code:2};
    video.dispatchEvent(new Event('error'));
    assert.deepEqual(retry, [[20, true]]);
  } finally { player.destroy(); }
  assert.equal(button.hidden, true);
  assert.equal(video.preload, 'none');
  button.dispatchEvent(new Event('click'));
  assert.equal(video.opens, 1);
});

test('a paid player uses the standard TV picker on a user click and tracks its connection', async () => {
  const {video, button} = viewer();
  delete video.webkitShowPlaybackTargetPicker;
  let prompts = 0;
  const remote = video.remote = Object.assign(new EventTarget(), {
    state:'disconnected', async prompt() { prompts++; }
  });
  const tv = attachAirPlay(video, {});
  const player = tv.open({path, expiresAt:rentalEnd()}, {caption:'',position:0,autoplay:true,ready() {},retry() {},expire() {}});
  try {
    assert.equal(button.attributes.get('aria-label'),'Play on TV');
    button.dispatchEvent(new Event('click'));
    assert.equal(prompts,1);
    remote.state = 'connected';
    remote.dispatchEvent(new Event('connect'));
    assert.equal(button.attributes.get('aria-pressed'),'true');
    remote.state = 'disconnected';
    remote.dispatchEvent(new Event('disconnect'));
    assert.equal(button.attributes.get('aria-pressed'),'false');
  } finally { player.destroy(); }
  assert.equal(button.hidden,true);
});

test('browsers without a compatible receiver reuse the private rental link', async () => {
  const {video,button} = viewer();
  delete video.webkitShowPlaybackTargetPicker;
  const panel = {open:false}, hint = {hidden:true};
  let focused = 0;
  const access = {hidden:false,querySelector:() => panel};
  const elements = {'access-tools':access,'tv-help':hint,'access-link':{value:'private-viewer-link'},
    'copy-link':{focus() { focused++; }}};
  video.ownerDocument = {getElementById:id => elements[id]};
  const tv = attachAirPlay(video, {});
  assert.equal(tv.supported,false);
  tv.setRentalActive(true);
  assert.equal(button.hidden,false);
  button.dispatchEvent(new Event('click'));
  assert.deepEqual([panel.open,hint.hidden,focused],[true,false,1]);
  tv.setRentalActive(false);
  assert.equal(button.hidden,true);
  button.dispatchEvent(new Event('click'));
  assert.equal(focused,1);

  // A supported browser can also report a disabled picker or no devices.
  video.remote = Object.assign(new EventTarget(),{prompt:async () => {throw new DOMException('No device','NotFoundError');}});
  const next = attachAirPlay(video,{});
  const player = next.open({path,expiresAt:rentalEnd()},{caption:'',position:0,ready(){},retry(){},expire(){}});
  try {
    panel.open = false;
    button.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual([panel.open,focused],[true,2]);
  } finally { player.destroy(); }
});
