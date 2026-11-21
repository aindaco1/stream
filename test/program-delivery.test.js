import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { streamProgramArchive, programPresentation } from '../src/program-delivery.js';
import { buffer } from 'node:stream/consumers';
import { renderProgramEntry, selectedFields } from '../src/film-embed.js';

function original(title, data) {
  return { title, extension:'mkv', size:data.length, async *stream() { yield Buffer.from(data); } };
}

test('a purchased ZIP extracts as numbered, uncompressed originals with unique safe names', async () => {
  const files = [original('../Test','first'), original('../Test','second')];
  const archive = await buffer(streamProgramArchive(files,new AbortController().signal,()=>true));
  // Small programs should open in macOS extractors that expect classic ZIP descriptors.
  assert.equal(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), false);
  const entries = JSON.parse(execFileSync('python3',['-c',[
    'import io, sys, json, zipfile',
    'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'print(json.dumps([[i.filename,i.compress_type,z.read(i).decode()] for i in z.infolist()]))'
  ].join('\n')],{input:archive}));
  assert.deepEqual(entries.map(item=>item.slice(1)),[[0,'first'],[0,'second']]);
  assert.ok(entries[0][0].startsWith('01 - ') && entries[1][0].startsWith('02 - '));
  assert.ok(entries.every(([name])=>!name.includes('/') && name.endsWith('.mkv')));
});

test('cancelled or revoked archives stop reading and fail closed', async () => {
  let reads=0;
  const file={title:'One',extension:'mp4',size:16,async *stream(){for(let i=0;i<16;i++){reads++;yield Buffer.from('a');}}};
  await assert.rejects(buffer(streamProgramArchive([file],new AbortController().signal,()=>reads<3)),/unavailable/);
  assert.ok(reads<=3);
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(buffer(streamProgramArchive([file],controller.signal,()=>true)),{name:'AbortError'});
});

test('the lineup exposes only display data and selected filmmaker details', () => {
  const result=programPresentation({title:'Screening',revision:'cut',previewId:'a',lineup:[
    {id:'a',role:'film',title:'Film',duration:15,size:100,extension:'mp4',thumbnail:'secret-art-key',
      bucket:'secret-bucket',info:{synopsis:'a synopsis',credits:'hidden credits'}}
  ]},[{name:'synopsis'}]);
  assert.deepEqual(result.lineup[0].info,{synopsis:'a synopsis'});
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('program entries display selected filmmaker text as escaped text and round partial seconds', () => {
  const film = {title:'<Cut & print>', duration:17.9, role:'opening',
    info:{synopsis:'<img onerror="bad">', message:'skip this field'}};
  const html = renderProgramEntry(film, selectedFields('synopsis'), '/film/screening/poster.jpg');
  assert.match(html, /&lt;Cut &amp; print&gt;/);
  assert.match(html, /Opening · 0:18/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<details|<img onerror|skip this field/);
});
