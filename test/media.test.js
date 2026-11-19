import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, copyFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFilm } from '../src/media.js';
import { createFileSource } from '../src/source.js';

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

test('source replacement invalidates subsequent renders including cached input blocks', async () => {
  const path = join(directory, 'replace.mp4');
  await copyFile(original, path);
  const temporaryFilm = await openFilm(createFileSource(path));
  try {
    await temporaryFilm.preview();
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
    for (const [i, bytes] of unique.entries()) assert.deepEqual(bytes, await film.segment(i));
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
