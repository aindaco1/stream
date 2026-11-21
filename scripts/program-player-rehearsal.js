import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFilm } from '../src/media.js';
import { createFileSource } from '../src/source.js';
import { createRentalAuthority } from '../src/rental.js';

export async function programFixture({ clock, path, directory, text, picture, duration }) {
  const alternate = join(directory, 'alternate.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-i', clock, '-i', text, '-f', 'sup', '-i', picture,
    '-map','0:v:0','-map','0:a:0','-map','1:s','-map','2:s','-c','copy',
    '-metadata:s:s:0','language=fra','-metadata:s:s:1','language=eng',alternate]);
  const titles = [
    ['Opening remarks','opening',path], ['First short','film',alternate],
    ['Second short','film',clock], ['Closing credits','closing',path]
  ];
  const sources = new Map();
  const lineup = [];
  for (const [title, role, filename] of titles) {
    const id = 'f-' + randomUUID(), source = createFileSource(filename);
    const size = (await source.head()).size;
    sources.set(id, { source, filename });
    lineup.push({ id, role, title, duration, size, extension:filename.endsWith('mkv') ? 'mkv' : 'mp4',
      info:{synopsis: title + ' synopsis', credits: 'Directed by Ada'} });
  }
  const id = 'p-' + randomUUID();
  const offer = {id, type:'program', revision:randomBytes(32).toString('base64url'), title:'Double feature',
    scope:'test/' + id, authority:createRentalAuthority(randomBytes(32)), prices:{rent:400,buy:800},
    previewId:lineup[1].id, previewSeconds:10, rentalHours:48, duration:4*duration, lineup};
  return {offer,
    open: member => openFilm(sources.get(member || offer.previewId).source),
    async file(member) {
      const item = lineup.find(item => item.id === member);
      return { ...item, contentType:'application/octet-stream', stream(start,end,signal) {
        return createReadStream(sources.get(member).filename, {start,end:end-1,signal});
      } };
    },
    bytes: member => readFile(sources.get(member).filename)
  };
}

export async function checkProgramPlayer({ frame, neighbor, app, fixture, preview, complete, context, requests }) {
  const {offer} = fixture;
  const [opening, first, second, closing] = offer.lineup;
  const next = frame.getByRole('button',{name:'Next title',exact:true});
  const previous = frame.getByRole('button',{name:'Previous title',exact:true});
  const sub = frame.getByRole('combobox',{name:'Subtitles'});
  async function displayed(member) {
    await frame.locator('#program-now').filter({hasText:member.title}).waitFor();
    await frame.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.readyState >= 2 && v.duration > 100;
    });
  }
  const selection = value => frame.waitForFunction(val => document.querySelector('#subtitles').value === val, value);
  const rows = frame.locator('#program-lineup li');
  await rows.first().waitFor();
  assert.deepEqual(await rows.locator('.program-row-title').allTextContents(), offer.lineup.map(item=>item.title));
  assert.equal(await next.count(),0);
  assert.equal(await rows.getByRole('button').count(),0);
  const size = async width => (await frame.frameElement()).evaluate((element,w)=>{element.width=w;}, width);
  const layout = () => frame.evaluate(() => ({
    video:document.querySelector('video').getBoundingClientRect().toJSON(),
    list:document.querySelector('#program-lineup').getBoundingClientRect().toJSON(),
    play:document.querySelector('#play').getBoundingClientRect().top,
    overflow:document.documentElement.scrollWidth - innerWidth
  }));
  for (const width of [320, 900]) {
    await size(width);
    await frame.waitForFunction(w=>innerWidth===w,width);
    const {video,list,overflow} = await layout();
    assert.equal(overflow,0);
    assert.ok(width === 320 ? list.top >= video.bottom : list.left >= video.right);
  }
  const before = await layout();
  await rows.first().locator('summary').click();
  assert.equal((await layout()).play,before.play);
  await size(480);
  assert.equal(await rows.first().locator('.film-synopsis').textContent(),'Opening remarks synopsis');
  assert.equal(await rows.locator('.film-credits').count(),0);
  await preview(frame);
  // A filmmaker republishes while the viewer is still looking at the earlier lineup.
  const previousEdition = offer.revision;
  offer.revision = randomBytes(32).toString('base64url');
  const rejection = frame.page().waitForResponse(response =>
    response.url().endsWith('/' + offer.id + '/checkout') && response.status() === 409);
  await frame.locator('#rent').click();
  const staleRequest = (await rejection).request().postDataJSON();
  assert.equal(staleRequest.programRevision, previousEdition);
  await frame.getByRole('button', {name:'Refresh program'}).click();
  await frame.waitForFunction(revision => JSON.parse(document.body.dataset.program || '{}').revision === revision, offer.revision);
  await preview(frame);
  await complete(frame,'buy');
  await displayed(opening);
  assert.equal(await rows.locator('.film-credits').count(),0);
  assert.ok(await previous.isDisabled());
  assert.equal(await frame.locator('video').count(),1);
  assert.ok(await neighbor.locator('#access-tools').isHidden());
  assert.equal(await neighbor.locator('body').getAttribute('data-access'),null);
  const pip = frame.getByRole('button',{name:'Picture-in-picture'});
  if (await pip.isVisible() && await frame.evaluate(() => document.pictureInPictureEnabled)) {
    await pip.click();
    await frame.waitForFunction(() => document.pictureInPictureElement === document.querySelector('video'));
    await pip.click();
    await frame.waitForFunction(() => document.pictureInPictureElement === null);
  }
  await sub.selectOption('s2');
  await frame.waitForFunction(() => [...document.querySelector('video').textTracks].some(t=>t.mode==='showing' && t.activeCues?.length));
  await next.click();
  await displayed(first);
  await selection('s3');
  await frame.waitForFunction(() => document.querySelector('video').currentTime > .2);
  const expectedRoute = '/title/' + first.id + '/play/index.m3u8?subtitle=s3';
  assert.ok(requests.some(request => request.url.endsWith(expectedRoute)), 'English text switched to the matching English picture rendition.');
  // Finishing a title advances in the same video element without an extra charge.
  await frame.locator('video').evaluate(v=>{v.currentTime=v.duration-.3;});
  await displayed(second);
  assert.ok(await sub.count() === 0);
  await frame.locator('#subtitle-status').filter({hasText:'unavailable for this title'}).waitFor();
  await next.click();
  await displayed(closing);
  await selection('s2');
  assert.ok(await next.isDisabled());
  await previous.click();
  await displayed(second);
  await rows.first().getByRole('button',{name:'Play ' + opening.title,exact:true}).click();
  await displayed(opening);
  await selection('s2');
  await sub.selectOption('');
  await next.click();
  await displayed(first);
  await selection('');
  await frame.locator('video').evaluate(v => {v.currentTime=23;});
  const mark = '/title/' + first.id + '/position';
  await frame.page().waitForResponse(response=>response.url().endsWith(mark) && response.ok(), {timeout:5000}).catch(() => {
    assert.ok(requests.some(request=>request.url.endsWith(mark)), 'Program sent a title-scoped bookmark.');
  });
  const download = async button => {
    const result = frame.page().waitForEvent('download');
    await button.click();
    const file = await result;
    return { name:file.suggestedFilename(), bytes:await readFile(await file.path()) };
  };
  const single = await download(rows.nth(1).getByRole('button',{name:'Download ' + first.title}));
  assert.ok(single.bytes.equals(await fixture.bytes(first.id)));
  const archive = await download(frame.getByRole('button',{name:/^Download program \(\.zip\)/}));
  assert.match(archive.name,/\.zip$/);
  assert.ok(archive.bytes.includes(Buffer.from('01 - Opening remarks.mkv')));
  await frame.locator('#save-label').click();
  const replay = await frame.locator('#access-link').inputValue();
  fixture.withdrawn = true;
  const recovered = await context.newPage();
  await recovered.goto(replay);
  await recovered.locator('#program-now').filter({hasText:first.title}).waitFor();
  await recovered.getByRole('button', {name:'Continue watching'}).click();
  await recovered.waitForFunction(() => { const v=document.querySelector('video'); return v.readyState >= 2 && v.currentTime >= 22; });
  assert.equal(await recovered.title(), offer.title + ' · Stream');
  assert.equal(await recovered.locator('#film-title').textContent(),offer.title);
  await recovered.evaluate(() => document.dispatchEvent(new Event('stream-access-ended')));
  assert.equal(await recovered.title(), 'Private screening · Stream');
  assert.equal(await recovered.locator('#film-title').textContent(),'Private screening');
  assert.equal(await recovered.locator('video').getAttribute('aria-label'),'Private screening');
  assert.ok(await recovered.locator('#program-lineup').isHidden());
  await recovered.close();
  assert.equal(new URL(frame.url()).origin,app);
}
