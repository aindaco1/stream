import test from 'node:test';
import assert from 'node:assert/strict';
import { trackWatchTime } from '../public/watch-time.js';

function player() {
  const video = Object.assign(new EventTarget(), { currentTime:0, playbackRate:1, seeking:false, paused:false });
  let wall = 0;
  const timer = trackWatchTime(video, () => wall * 1000);
  const send = name => video.dispatchEvent(new Event(name));
  function advance(seconds, footage) {
    wall += seconds;
    video.currentTime += footage;
    send('timeupdate');
  }
  return { video, timer, send, advance };
}

test('watch time counts real playback across pauses, stalls, seeks, replays and rate changes', () => {
  const { video, timer, send, advance } = player();
  const updates = [];
  timer.start(seconds => updates.push(seconds));
  advance(4,4);
  video.paused = true;
  send('pause');
  advance(90,0);
  video.paused = false;
  send('playing');
  advance(3,3);
  send('waiting');
  advance(15,0);
  send('playing');
  video.currentTime = 1200;
  video.seeking = true;
  send('seeking');
  advance(2,0);
  video.seeking = false;
  send('playing');
  advance(2,2);
  video.seeking = true;
  video.currentTime = 0;
  send('seeking');
  video.seeking = false;
  send('playing');
  video.playbackRate = 2;
  send('ratechange');
  advance(2,4);
  send('ended');
  timer.stop();
  assert.deepEqual(updates, [0,4,7,9,11]);
});

test('long sessions checkpoint and a new title starts with its own clock', () => {
  const { timer, advance } = player();
  const first = [], second = [];
  timer.start(n => first.push(n));
  advance(29,29);
  advance(2,2);
  advance(60,2); // Sparse browser events with just two seconds of media progression.
  timer.flush();
  timer.stop();
  timer.start(n => second.push(n));
  advance(3,3);
  timer.stop();
  assert.deepEqual(first, [0,31,33]);
  assert.deepEqual(second, [0,3]);
});
