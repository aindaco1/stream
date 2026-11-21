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
      thumbnail: role === 'opening', info:{synopsis: title + ' synopsis', credits: 'Directed by Ada', message:'A note from the director.'} });
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

export async function checkProgramLayout(frames) {
  for (const frame of frames) {
    await frame.locator('#program-lineup li').first().waitFor();
    const layout = await frame.evaluate(() => ({
      width: innerWidth,
      video: document.querySelector('video').getBoundingClientRect().toJSON(),
      list: document.querySelector('#program-lineup').getBoundingClientRect().toJSON(),
      title: document.querySelector('.program-row-title').getBoundingClientRect().toJSON(),
      still: document.querySelector('.program-still').getBoundingClientRect().toJSON(),
      overflow: document.documentElement.scrollWidth - innerWidth
    }));
    const {width, video, list, title, still, overflow} = layout;
    assert.ok(still.left >= title.right && still.width > 0);
    assert.equal(await frame.locator('#program-lineup details').count(), 0);
    assert.ok(await frame.locator('#program-lineup .film-synopsis').first().isVisible());
    assert.equal(overflow, 0);
    if (width === 320) {
      assert.ok(list.top >= video.bottom);
    } else {
      assert.equal(width, 900);
      assert.ok(list.left >= video.right);

    }
  }
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
  assert.ok(await rows.first().locator('.film-synopsis').isVisible());
  assert.equal(await rows.first().locator('.film-synopsis').textContent(),'Opening remarks synopsis');
  assert.equal(await rows.locator('.film-credits').count(),0);
  // Activity tracking must not block playback in an iframe with an HTTP ancestor.
  await frame.evaluate(() => Object.defineProperty(crypto, 'randomUUID', {value:undefined, configurable:true}));
  const subtitleList = '**/film/' + offer.id + '/preview/subtitles';
  let startedWithoutCaptions = false;
  const holdCaptions = async route => {
    // The native preview should start before a slow subtitle list returns.
    await frame.waitForFunction(() => document.querySelector('video').currentTime > .05, null, {timeout:8000});
    startedWithoutCaptions = true;
    await route.fulfill({json:[]});
  };
  await frame.page().route(subtitleList, holdCaptions);
  try {
    await preview(frame, false, true);
    assert.ok(startedWithoutCaptions);
  } finally {
    await frame.page().unroute(subtitleList, holdCaptions);
  }
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
  const clipPath = '**/film/' + offer.id + '/preview.mp4';
  const unavailable = route => route.fulfill({status:503});
  await frame.page().route(clipPath, unavailable);
  await frame.locator('#play').click();
  await frame.locator('#status').filter({hasText:/could not load/}).waitFor();
  await frame.page().unroute(clipPath, unavailable);
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
  // Delay a bookmark on the opening while the viewer moves to the next film and seeks.
  // Releasing it later must not overwrite the new title or position.
  const release = Promise.withResolvers();
  const positions = [];
  const record = async route => {
    const request = route.request();
    positions.push(request.url());
    if (positions.length === 1) await release.promise;
    await route.fallback();
  };
  const page = frame.page();
  const pattern = '**/title/*/position';
  await page.route(pattern, record);
  try {
    const pending = page.waitForRequest(request => request.url().endsWith('/title/' + opening.id + '/position'));
    await frame.locator('video').evaluate(v => {v.currentTime=9;});
    await pending;
    await next.click();
    await displayed(first);
    await selection('');
    const mark = '/title/' + first.id + '/position';
    const saved = page.waitForResponse(response=>response.url().endsWith(mark) &&
      response.request().postData()?.endsWith(' 23') && response.ok());
    await frame.locator('video').evaluate(v => {v.currentTime=23;});
    await frame.waitForFunction(() => {const v=document.querySelector('video'); return !v.seeking && v.currentTime>=23;});
    assert.equal(positions.length,1,'A pending bookmark must finish before writing the new title.');
    release.resolve();
    await saved;
  } finally {
    release.resolve();
    await page.unroute(pattern, record);
  }
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
  const sessions = () => requests.filter(r => r.url.endsWith('/' + offer.revision + '/session')).length;
  const initialSessions = sessions();
  await recovered.getByRole('button', {name:'Play in player'}).press('Enter');
  await recovered.locator('#play').evaluate(button => button.click());
  await recovered.waitForFunction(() => { const v=document.querySelector('video'); return v.readyState >= 2 && v.currentTime >= 22; });
  assert.equal(sessions(), initialSessions + 1, 'Pressing both Play actions starts one paid session.');
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
