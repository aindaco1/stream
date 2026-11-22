import { setTimeout as delay } from 'node:timers/promises';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, copyFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFilm } from '../src/media.js';
import { BLOCK_SIZE, createFileSource } from '../src/source.js';

let directory, film, original;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stream-media-'));
  original = join(directory, 'original.mp4');
  execFileSync(process.execPath, ['scripts/fixture.js', original], { stdio: 'pipe' });
  film = await openFilm(createFileSource(original));
});
after(async () => {
  film?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function packets(path, interval) {
  const args = ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=stream_index,pts_time,duration_time,data_hash', '-of', 'json'];
  if (interval) args.push('-read_intervals', interval);
  return JSON.parse(execFileSync('ffprobe', [...args, path], { maxBuffer: 5 * 1024 * 1024 })).packets;
}
function decode(path) {
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { stdio: 'pipe' });
}

test('preview contains exactly the original complete packets that fit before the cutoff', async () => {
  const preview = join(directory, 'preview.mp4');
  await writeFile(preview, await film.preview());
  const allowed = packets(original, '%+11').filter(packet => {
    const start = Number(packet.pts_time);
    return start >= 0 && start + Number(packet.duration_time) <= 10.000001;
  });
  const actual = packets(preview);
  for (const [index, count] of [[0, 240], [1, 468]]) {
    const stream = actual.filter(p => p.stream_index === index);
    assert.equal(stream.length, count);
    assert.deepEqual(stream.map(p => [p.pts_time, p.data_hash]),
      allowed.filter(p => p.stream_index === index).map(p => [p.pts_time, p.data_hash]));
    for (const packet of stream) assert.ok(Number(packet.pts_time) + Number(packet.duration_time) <= 10.000001);
  }
  decode(preview);
});

test('rental streams the full timeline with decodable late segments', async () => {
  assert.equal(film.duration, 136);
  assert.equal(film.segments.length, 34);
  for (const index of [0, 1, 30, 33]) {
    assert.deepEqual(film.segments[index], { start: index * 4, end: (index + 1) * 4, duration: 4 });
    const path = join(directory, 'segment-' + index + '.ts');
    await writeFile(path, await film.segment(index));
    decode(path);
    const streams = packets(path);
    assert.equal(streams.filter(p => p.stream_index === 0).length, 96);
    assert.ok(streams.some(p => p.stream_index === 1));
  }
  await assert.rejects(film.segment(-1));
  await assert.rejects(film.segment(34));
});

test('a fresh inspection and the first preview share the private source prefix', async t => {
  const file = createFileSource(original), starts = [];
  const source = { ...file, read(head, start, end) {
    starts.push(start);
    return file.read(head, start, end);
  } };
  const film = await openFilm(source);
  t.after(() => film.close());
  await film.preview();
  assert.deepEqual(starts.filter(start => start < BLOCK_SIZE), [0]);
});

test('source replacement invalidates subsequent renders including cached input blocks', async () => {
  const path = join(directory, 'replace.mp4');
  await copyFile(original, path);
  const temporaryFilm = await openFilm(createFileSource(path));
  try {
    await temporaryFilm.preview();
    await temporaryFilm.segment(0);
    await truncate(path, 96);
    await assert.rejects(temporaryFilm.preview(), /replaced/);
    await assert.rejects(temporaryFilm.segment(0), /replaced/);
  } finally {
    temporaryFilm.close();
  }
});

test('concurrent viewers share identical remuxes and distinct intervals queue without cross-talk', async () => {
  const file = createFileSource(original);
  let heads = 0;
  const film = await openFilm({
    read: file.read,
    async head() { heads++; return file.head(); }
  });
  try {
    const first = await Promise.all(Array.from({ length: 12 }, () => film.preview()));
    assert.equal(heads, 2);
    assert.ok(first.every(bytes => bytes === first[0]));
    const unique = await Promise.all(Array.from({ length: 8 }, (_, i) => film.segment(i)));
    assert.equal(heads, 10);
    for (const [i, bytes] of unique.entries()) assert.strictEqual(bytes, await film.segment(i));
    assert.equal(heads, 18, 'completed segments are reused only after rechecking the private source');
  } finally {
    film.close();
  }
});

test('a preview covering the whole film is unavailable and its rental remains playable', async () => {
  const path = join(directory, 'short.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-i', original, '-t', '5', '-c', 'copy', '-movflags', '+faststart', path]);
  const short = await openFilm(createFileSource(path));
  try {
    await assert.rejects(short.preview(), /before the film ends/);
    assert.ok((await short.segment(0)).length > 0);
  } finally {
    short.close();
  }
});

test('preview bytes remain stable across separate HTTP range requests', async () => {
  const first = await film.preview();
  await delay(1050); // MP4 creation time has one-second precision.
  assert.deepEqual(await film.preview(), first);
});

test('overlapping requests for different preview lengths each enforce their own packet cutoff', async () => {
  const intervals = [3, 8, 3];
  const outputs = await Promise.all(intervals.map(seconds => film.preview(seconds)));
  assert.equal(outputs[0], outputs[2]);
  for (const index of [0, 1]) {
    const path = join(directory, 'preview-' + index + '.mp4');
    await writeFile(path, outputs[index]);
    const ends = packets(path).map(p => Number(p.pts_time) + Number(p.duration_time));
    assert.ok(Math.abs(Math.max(...ends) - intervals[index]) < .001);
  }
  for (const invalid of [0, -1, 181, Infinity]) await assert.rejects(film.preview(invalid));
});

test('separate renders of a rate-limited transcoded preview serve identical bytes for video range requests', async t => {
  const path = join(directory, 'busy-intro.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=960x540:rate=24,noise=alls=48:allf=t+u:all_seed=42', '-t', '7',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-profile:v', 'main', '-bf', '2', path]);
  const source = createFileSource(path);
  const first = await openFilm(source);
  t.after(() => first.close());
  let reads = 0, checks = 0;
  const second = await openFilm({
    head: async () => { checks++; return source.head(); },
    read: (...range) => { reads++; return source.read(...range); },
    probeCache: { get(revision, size) {
      assert.equal(revision, first.revision);
      assert.equal(size, first.probe.size);
      return first.probe.media;
    } }
  });
  t.after(() => second.close());
  assert.equal(checks, 1, 'a reopened index still validates the original');
  assert.equal(reads, 0, 'the saved inspection skips a byte probe before encoding');
  const [a,b] = await Promise.all([first.preview(6), second.preview(6)]);
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
  const bytes = Buffer.from(a);
  const boxes = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    assert.ok(size >= 8 && at + size <= bytes.length);
    boxes.push(bytes.toString('ascii', at + 4, at + 8));
    at += size;
  }
  assert.ok(boxes.includes('moov') && boxes.indexOf('moov') < boxes.indexOf('mdat'));
  assert.ok(!boxes.includes('moof'), 'the browser can find every sample in the front index');
  assert.ok((await first.preview(6)) === a, 'Range requests share the ready preview while the source is current.');
});

test('180-second previews preserve the cutoff for video, audio and timed text', async () => {
  const file = join(directory, 'long.mkv'), text = join(directory, 'long.srt');
  await writeFile(text, '1\n00:02:59,000 --> 00:03:01,000\nVisible at cutoff\n\n2\n00:03:01,000 --> 00:03:02,000\nPaid only\n');
  execFileSync('ffmpeg', ['-v', 'error', '-stream_loop', '1', '-i', original, '-i', text,
    '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c', 'copy', '-t', '183', file]);
  const long = await openFilm(createFileSource(file), {previewSeconds:180});
  try {
    const path = join(directory, 'three-minutes.mp4');
    const bytes = await long.preview();
    await writeFile(path, bytes);
    const info = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,duration','-of','json',path]));
    assert.equal(info.streams.length, 2);
    for (const stream of info.streams) {
      assert.ok(Number(stream.duration) > 179.95 && Number(stream.duration) <= 180, JSON.stringify(stream));
    }
    const sub = long.subtitleTracks[0].id;
    const captions = await long.subtitles(sub, {end:180});
    assert.match(captions, /00:03:00\.000\nVisible at cutoff/);
    assert.doesNotMatch(captions, /Paid only/);
    await assert.rejects(long.preview(181));
    await assert.rejects(long.subtitles(sub, {end:181}));
  } finally { long.close(); }
});
