import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { openFilm } from '../src/media.js';
import { createFileSource, MAX_FILE_BYTES } from '../src/source.js';
import { pictureSubtitles } from './fixtures/picture-subtitles.js';

let dir;
const ff = args => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 });
const probe = (file, entries) => JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries',entries,'-of','json',file]));
function pixel(file, time) {
  return ff(['-i',file,'-ss',String(time),'-vf','crop=8:8:25:45,scale=1:1,format=gray','-frames:v','1','-f','rawvideo','pipe:1'])[0];
}
const srt = '1\n00:00:02,000 --> 00:00:08,000\nA visible sentence\n\n2\n00:00:12,000 --> 00:00:16,000\nPaid dialogue\n';
before(async () => {
  dir = await mkdtemp(join(tmpdir(),'stream-formats-'));
  await writeFile(join(dir,'text.srt'),srt);
});
after(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

const codecs = [
  ['h264','mov',['-c:v','libx264','-profile:v','high','-bf','2','-x264-params','b-adapt=0'],'mov_text'],
  ['hevc','mp4',['-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error','-tag:v','hvc1'],'mov_text'],
  ['av1','mkv',['-c:v','libsvtav1','-preset','12','-svtav1-params','lp=2'],'webvtt'],
  ['vp9','mkv',['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8'],'ass']
];
for (const [codec,extension,encoder,subtitleCodec] of codecs) {
  test(codec + ' in ' + extension + ' decodes a bounded preview, seeks to its paid ending and extracts only eligible subtitle text', async () => {
    const original = join(dir,codec + '.' + extension);
    ff(['-f','lavfi','-i','color=c=black:s=160x90:r=12:d=20',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20','-i',join(dir,'text.srt'),
      '-vf',"drawbox=c=white:t=fill:enable='gte(t,12)'",'-map','0:v','-map','1:a','-map','2:s',
      ...encoder,'-threads','2','-g','24','-pix_fmt','yuv420p','-c:a',extension === 'mkv' ? 'libopus' : 'aac',
      '-c:s',subtitleCodec,'-metadata:s:s:0','language=spa','-disposition:s:0','hearing_impaired',original]);
    const film = await openFilm(createFileSource(original));
    try {
      assert.equal(film.extension,extension);
      assert.ok(Math.abs(20-film.duration) < .1);
      const [track] = film.subtitleTracks;
      assert.equal(track.language,'es');
      assert.equal(track.format,'text');
      if (extension === 'mkv') assert.equal(track.kind,'captions');
      const clipped = await film.subtitles(track.id,{end:5});
      assert.match(clipped,/00:00:0[12]\.\d{3} --> 00:00:05\.000\nA visible sentence/);
      assert.doesNotMatch(clipped,/Paid dialogue/);
      assert.match(await film.subtitles(track.id),/Paid dialogue/);
      await assert.rejects(film.subtitles(track.id,{end:0}));
      const preview = join(dir,codec+'-preview.mp4'), ending = join(dir,codec+'-ending.ts');
      await writeFile(preview,await film.preview(5));
      await writeFile(ending,await film.segment(film.segments.length-1));
      for (const stream of probe(preview,'stream=codec_name,duration').streams) {
        assert.ok(['h264','aac'].includes(stream.codec_name));
        assert.ok(Number(stream.duration) <= 5.00001, codec+' preview duration '+stream.duration);
      }
      const paidStreams = probe(ending,'stream=codec_type,codec_name,profile,pix_fmt,sample_rate,channels').streams;
      const video = paidStreams.find(stream => stream.codec_type === 'video');
      const audio = paidStreams.find(stream => stream.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.profile, 'LC');
      assert.equal(audio.channels, 2);
      assert.equal(audio.sample_rate, '48000');
      assert.ok(pixel(preview,4) < 16);
      assert.ok(pixel(ending,.5) > 230);
      ff(['-xerror','-i',ending,'-f','null','-']);
      assert.deepEqual(await film.preview(5),await film.preview(5));
    } finally { film.close(); }
  });
}

test('PGS, DVD and DVB pictures can be switched on/off and a sustained cue survives arbitrary late seeks', async () => {
  const sup = join(dir,'long.sup'), original = join(dir,'long.mkv');
  await writeFile(sup,pictureSubtitles([[0,false],[2,true],[4,false],[13,true],[78,false]]));
  ff(['-f','lavfi','-i','color=c=gray:s=160x90:r=12:d=84','-i',sup,'-map','0:v','-map','1:s',
    '-threads','1','-c:v','libx264','-g','24','-c:s','copy','-metadata:s:s:0','language=eng','-disposition:s:0','forced',original]);
  for (const codec of ['pgs','dvdsub','dvbsub']) {
    const file = codec === 'pgs' ? original : join(dir,codec+'.mkv');
    if (codec !== 'pgs') ff(['-fix_sub_duration','-i',original,'-map','0:v','-map','0:s','-c:v','copy','-c:s',codec,'-write_crc32','0',file]);
    if (codec === 'dvbsub') {
      // The DVB encoder emits a 30s page timeout. Author a 90s page lifetime so this fixture
      // really does display through 74s and relies on the explicit clear at 78s.
      const data = await readFile(file);
      const visiblePage = Buffer.from('0f10000100081e','hex');
      let count = 0;
      for (let at = data.indexOf(visiblePage); at !== -1; at = data.indexOf(visiblePage,at+7)) { data[at+6] = 90; count++; }
      assert.equal(count,2);
      await writeFile(file,data);
    }
    const film = await openFilm(createFileSource(file));
    try {
      const [track] = film.subtitleTracks;
      assert.equal(track.format,'bitmap');
      assert.equal(track.language,'en');
      assert.equal(track.forced,true);
      const selected = {subtitleId:track.id};
      await assert.rejects(film.subtitles(track.id));
      await assert.rejects(film.preview(5,{subtitleId:'s300'}));
      const sample = async (name, bytes) => {
        const out = join(dir,codec+'-'+name);
        await writeFile(out,await bytes);
        return out;
      };
      const off = await sample('off.mp4',film.preview(5));
      const on = await sample('on.mp4',film.preview(5,selected));
      assert.ok((await film.preview(1,selected)).length > 0);
      const background = pixel(off,3);
      // A DVD encoder can choose a different palette than the original Blu-ray.
      assert.ok(Math.abs(pixel(on,3)-background)>30,codec+' visible preview');
      assert.ok(Math.abs(pixel(on,4.5)-background)<5,codec+' cleared preview');
      assert.ok(Number(probe(on,'format=duration').format.duration) <= 5.00001);
      const late = await sample('late.ts',film.segment(12,selected));
      assert.ok(Math.abs(pixel(late,2)-background)>30,codec+' long active cue at 74s');
      const clear = await sample('clear.ts',film.segment(13,selected));
      assert.ok(Math.abs(pixel(clear,2)-background)<5,codec+' cleared cue at 80s');
    } finally { film.close(); }
  }
});

test('rental references survive seeking and picture captions, with isolated visible frames', async () => {
  const sup = join(dir,'mark.sup'), original = join(dir,'mark.mkv');
  await writeFile(sup,pictureSubtitles([[0,false],[2,true],[4,false]]));
  ff(['-f','lavfi','-i','color=c=gray:s=160x90:r=12:d=69','-i',sup,'-map','0:v','-map','1:s',
    '-threads','1','-c:v','libx264','-g','24','-c:s','copy',original]);
  const originalBytes = await readFile(original), film = await openFilm(createFileSource(original));
  const sample = async (name, content) => {
    const path = join(dir,name);
    await writeFile(path,await content);
    return path;
  };
  const band = (path,time,side) => ff(['-i',path,'-ss',String(time),'-vf',
    'crop=90:90:35:0,crop=90:32:0:'+(side === 'top' ? 10 : 49)+',format=gray','-frames:v','1','-f','rawvideo','pipe:1']);
  function changed(a,b) {
    assert.equal(a.length,90*32);
    assert.equal(b.length,a.length);
    return a.reduce((count,value,i)=>count+Number(Math.abs(value-b[i])>8),0);
  }
  try {
    const [track] = film.subtitleTracks;
    const first = 'AAAAAAAA', second = 'WWWWWWWW';
    const [plain,a,b,preview] = await Promise.all([
      sample('plain.ts',film.segment(0)),
      sample('a.ts',film.segment(0,{watermark:first})),
      sample('b.ts',film.segment(0,{watermark:second})),
      sample('unmarked.mp4',film.preview(5))
    ]);
    const clear = band(plain,1,'top');
    assert.ok(changed(band(a,1,'top'),clear)>50, 'first minute starts with a visible interior mark after a centered square crop');
    assert.ok(changed(band(a,1,'top'),band(b,1,'top'))>25, 'simultaneous viewers receive distinct references');
    assert.ok(changed(band(a,1,'bottom'),clear)<10);
    assert.ok(changed(band(a,5,'top'),clear)<10, 'the mark disappears after four seconds');
    assert.ok(changed(band(preview,1,'top'),clear)<10, 'the public preview stays clean');
    const captioned = await sample('captioned.ts',film.segment(0,{watermark:first,subtitleId:track.id}));
    assert.ok(changed(band(captioned,3,'top'),clear)>50);
    assert.ok(Math.abs(pixel(captioned,3)-pixel(a,3))>30,'selected picture subtitle is also visible');
    const index = film.segments.findIndex(s => s.start === 60);
    const late = await sample('late-mark.ts',film.segment(index,{watermark:first}));
    assert.ok(changed(band(late,1,'bottom'),clear)>50,'a seek to minute two switches to the lower band');
    assert.ok(changed(band(late,1,'top'),clear)<10);
    const quiet = await Promise.all([first,second].map(watermark => film.segment(1,{watermark})));
    assert.strictEqual(quiet[0],quiet[1], 'quiet intervals share a single in-flight encoding');
    assert.strictEqual(await film.segment(1,{watermark:second}), quiet[0], 'quiet screener intervals are reusable');
    assert.notStrictEqual(await film.segment(0,{watermark:first}), await film.segment(0,{watermark:first}),
      'completed viewer-specific marks are not retained');
    for (const watermark of ['toolong123','<markup>',null]) {
      await assert.rejects(film.segment(1,{watermark}),/reference/);
    }
    assert.deepEqual(await readFile(original),originalBytes);
  } finally { film.close(); }
});

test('the complete rental mark stays inside a centered widescreen crop of square and 4:3 films', async () => {
  for (const height of [320,240]) {
    const source = join(dir,'square-' + height + '.mp4');
    ff(['-f','lavfi','-i',`color=c=black:s=320x${height}:r=12:d=2`,'-c:v','libx264',source]);
    const film = await openFilm(createFileSource(source));
    try {
      const marked = join(dir,'crop-' + height + '.ts');
      await writeFile(marked,await film.segment(0,{watermark:'4AE79C32'}));
      const frame = filter => ff(['-i',marked,'-ss','1','-vf',filter,'-frames:v','1','-f','rawvideo','pipe:1']);
      const bright = bytes => bytes.reduce((n,pixel)=>n+Number(pixel>120),0);
      const original = bright(frame('format=gray'));
      assert.ok(original>80,'rental code is visible');
      assert.equal(bright(frame('crop=320:180,format=gray')),original,'all bright lettering survives the crop');
    } finally { film.close(); }
  }
});

test('source sizes accept decimal 10 GB and reject one byte over without loading a file', async () => {
  const file = join(dir,'boundary.bin'), handle = await open(file,'w');
  try {
    await handle.truncate(MAX_FILE_BYTES);
    assert.equal((await createFileSource(file).head()).size,10_000_000_000);
    await handle.truncate(MAX_FILE_BYTES+1);
    await assert.rejects(createFileSource(file).head(),/metadata|size/);
  } finally { await handle.close(); await rm(file); }
});
