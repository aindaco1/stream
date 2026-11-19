import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.STREAM_BASE_URL || 'http://127.0.0.1:8787');
assert.equal(base.hostname, '127.0.0.1', 'Run the prototype acceptance test on loopback');
const extension = path.resolve(process.env.STREAM_DOWNLOADER_PATH || '../downloader/extension');
const evidence = path.resolve(process.env.EVIDENCE_DIR || 'test-results');
const previewOnly = process.argv.includes('--preview-only');
assert.ok(previewOnly || process.env.STREAM_RECEIPT_FILE, 'Set STREAM_RECEIPT_FILE, or use --preview-only');
const receipt = previewOnly ? '' : (await readFile(process.env.STREAM_RECEIPT_FILE, 'utf8')).trim();
assert.ok(previewOnly || receipt, 'Signed rental receipt file is empty');
const manifest = await readFile(path.join(extension, 'manifest.json'));
const tests = {};
const report = { startedAt: new Date().toISOString(), downloader: JSON.parse(manifest).version,
  manifestSha256: createHash('sha256').update(manifest).digest('hex'), tests };
// Identify the bytes under test even on an uncommitted checkout.
const build = createHash('sha256');
for (const directory of ['public', 'src']) {
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    build.update(file).update('\0').update(await readFile(file)).update('\0');
  }
}
build.update(await readFile('package-lock.json'));
report.appSourceSha256 = build.digest('hex');
try {
  report.downloaderCommit = execFileSync('git', ['-C', extension, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* Packaged extensions may be installed outside a Git checkout. */ }
await mkdir(evidence, { recursive: true, mode: 0o700 });
const run = await mkdtemp(path.join(evidence, 'browser-'));
const downloads = path.join(run, 'downloads');
await mkdir(downloads, { mode: 0o700 });
const profile = await mkdtemp(path.join(tmpdir(), 'stream-browser-'));
const embed = (film = 'clock', rental = false) => {
  const url = new URL('/embed/' + film, base);
  if (rental) url.hash = new URLSearchParams({ receipt }).toString();
  return url.href;
};
const previewName = 'Play 10-second preview';
const paidName = 'Play rental';

// Only owned local fixture URLs enter this harness. Exceptions from browser tools
// can include a complete private URL; save operation names and sanitized errors.
function clean(text) {
  return String(text).replace(/(?:https?|blob|file|chrome-extension):[^\s)]+/gi, '[URL]')
    .replace(/[a-z\d_.=-]{24,}/gi, '[redacted]').slice(0, 450);
}
async function until(action, label, timeout = 30_000) {
  const start = Date.now();
  do {
    const value = await action();
    if (value) return value;
    await delay(200);
  } while (Date.now() - start < timeout);
  throw new Error('Timed out waiting for ' + label);
}
function probe(file) {
  const json = flags => JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...flags, '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const { streams, format } = json(['-show_entries', 'stream=index,codec_name,codec_type:format=duration']);
  const { packets } = json(['-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time']);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
  return { duration: Number(format.duration), streams: streams.map(stream => {
    const samples = packets.filter(packet => packet.stream_index === stream.index);
    return { type: stream.codec_type, codec: stream.codec_name, packets: samples.length,
      end: Math.max(...samples.map(packet => Number(packet.pts_time) + Number(packet.duration_time || 0))) };
  }), fullyDecoded: true };
}
async function startPlayer(frame, label) {
  await frame.locator('video').evaluate(v => { v.muted = true; });
  await frame.getByRole('button', { name: label, exact: true }).click({ timeout: 15_000 });
  try {
    await until(() => frame.locator('video').evaluate(v => v.currentTime > 0.3 && !v.paused), label);
  } catch (error) {
    const state = await frame.locator('video').evaluate(v => ({
      time: v.currentTime, ready: v.readyState, paused: v.paused, mediaError: v.error?.code,
      message: document.querySelector('#status')?.textContent
    }));
    throw new Error(error.message + ' ' + JSON.stringify(state));
  }
  return frame.locator('video');
}
async function seek(video, seconds) {
  await video.evaluate((v, t) => { v.currentTime = t; }, seconds);
  await until(() => video.evaluate((v, t) => !v.seeking && v.currentTime > t + 0.3, seconds), 'playback after seek');
  return Number((await video.evaluate(v => v.currentTime)).toFixed(2));
}
// The synthetic clock has a 440 Hz tone during the preview and 880 Hz after
// the paywall. Measuring actual decoded audio distinguishes a successful seek
// into the film from a player that merely advanced its displayed timeline.
async function fixtureTone(video) {
  return video.evaluate(async element => {
    const context = new AudioContext();
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      context.createMediaElementSource(element).connect(analyser);
      const silent = context.createGain();
      silent.gain.value = 0;
      analyser.connect(silent).connect(context.destination);
      element.muted = false;
      await context.resume();
      const bins = new Float32Array(analyser.frequencyBinCount);
      for (let pass = 0; pass < 20; pass++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        analyser.getFloatFrequencyData(bins);
        const peak = Math.max(...bins);
        if (peak > -65) return Math.round(bins.indexOf(peak) * context.sampleRate / analyser.fftSize);
      }
      throw new Error('No decoded fixture audio');
    } finally {
      element.muted = true;
      await context.close();
    }
  });
}
const observedHosts = new Set();
const sourceMarkers = Object.entries({
  r2Hostname: 'r2.cloudflarestorage.com', r2PublicHostname: '.r2.dev',
  providerAccount: process.env.R2_ACCOUNT_ID, privateBucket: process.env.R2_BUCKET,
  privateObject: process.env.R2_OBJECT_KEY
}).filter(([, marker]) => marker);
const markerHits = new Set();
const bodyChecks = [];
const counts = { urls: 0, responseHeaders: 0, responseBodies: 0, interruptedBodies: 0 };
function checkMarkers(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (const [label, marker] of sourceMarkers) {
    if (bytes.includes(marker) || bytes.includes(encodeURIComponent(marker))) markerHits.add(label);
  }
}

let context, hostServer;
async function attempt(name, test) {
  try {
    const result = await test();
    tests[name] = { passed: result.downloaderContained !== false, ...result };
    if (!tests[name].passed) process.exitCode = 1;
  }
  catch (error) {
    tests[name] = { passed: false, error: clean(error.message) };
    process.exitCode = 1;
  }
  console.log(name, tests[name].passed ? 'passed' : (tests[name].error || 'downloader saved rental data'));
}
try {
  await mkdir(path.join(profile, 'Default'));
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    profile: { cookie_controls_mode: 1, block_third_party_cookies: true },
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }
  }));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ['--disable-extensions'], args: [
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required', '--disable-extensions-except=' + extension, '--load-extension=' + extension
    ], acceptDownloads: true
  });
  report.browser = context.browser().version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionOrigin = new URL(worker.url()).host;
  const browserCDP = await context.browser().newBrowserCDPSession();
  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  context.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol)) {
      observedHosts.add(url.hostname.toLowerCase());
      counts.urls++;
      checkMarkers(request.url());
    }
  });

  context.on('response', response => {
    if (new URL(response.url()).origin !== base.origin) return;
    counts.responseHeaders++;
    checkMarkers(JSON.stringify(response.headers()));
    bodyChecks.push(response.body().then(body => {
      counts.responseBodies++;
      checkMarkers(body);
    }, () => { counts.interruptedBodies++; }));
  });

  async function testDownloader(kind, embedded = false, compact = false) {
    const paid = kind === 'rental';
    const page = await context.newPage();
    let popup;
    try {
      let player = page;
      if (embedded) {
        await page.goto('http://localhost:' + hostServer.address().port + (compact ? '/compact' : '/single'));
        player = page.frame({ name: 'film0' });
        assert.ok(player, 'Off-site embed loaded');
        if (paid) {
          await player.goto('about:blank'); // A checkout return loads a new document.
          await player.goto(embed('clock', true));
        }
      } else await page.goto(embed('clock', paid), { waitUntil: 'domcontentloaded' });
      const video = await startPlayer(player, paid ? paidName : previewName);
      const duration = await video.evaluate(v => v.duration);
      assert.ok(paid ? duration >= 130 : duration > 9.9 && duration <= 10.001, 'Player duration is in the expected range');
      const playback = { duration };
      if (paid) playback.playedAfterSeek = await seek(video, 120);
      playback.decodedToneHz = await fixtureTone(video);
      assert.ok(Math.abs(playback.decodedToneHz - (paid ? 880 : 440)) < 20, 'Decoded fixture matches its playback position');
      if (!paid) {
        await until(() => video.evaluate(v => v.ended), 'preview to finish', 20_000);
        playback.endedAt = await video.evaluate(v => v.currentTime);
      }
      const id = await worker.evaluate(url => chrome.tabs.query({}).then(tabs =>
        tabs.find(tab => tab.url === url)?.id), page.url());
      assert.ok(id, 'Browser tab has an extension-visible ID');
      popup = await context.newPage();
      await popup.goto('chrome-extension://' + extensionOrigin + '/popup.html?tab=' + id);
      await popup.getByRole('button', { name: /Rescan/ }).click();
      await popup.locator('#status').filter({ hasText: 'Rescanned.' }).waitFor({ timeout: 10_000 });
      // Rescan performs a delayed refresh. Wait for the ordinary detection window.
      await delay(2400);
      const cards = popup.locator('.media-card');
      const ids = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.item));
      const outcomes = [];
      // Inspect each candidate that the popup presents on our fixture page. Only
      // the default video quality is chosen, using the same buttons a viewer uses.
      for (const item of ids) {
        const card = popup.locator('.media-card[data-item="' + item + '"]');
        const tag = (await card.locator('.tag').innerText()).slice(0, 30);
        const inspect = card.getByRole('button', { name: 'Choose quality' });
        if (await inspect.count()) await inspect.click();
        const save = card.getByRole('button', { name: '↓ Download', exact: true });
        await until(async () => await save.count() || await card.locator('.card-status.error').count(), 'quality inspection');
        if (!await save.count()) {
          outcomes.push({ tag, result: 'unavailable', message: clean(await card.locator('.card-status.error').first().innerText()) });
          continue;
        }
        const previousJobs = Number(await popup.locator('#jobCount').innerText());
        await save.click();
        await until(async () => Number(await popup.locator('#jobCount').innerText()) > previousJobs ||
          (await popup.locator('#status').textContent())?.trim(), 'download to start');
        if (Number(await popup.locator('#jobCount').innerText()) === previousJobs) {
          outcomes.push({ tag, result: 'rejected', message: clean(await popup.locator('#status').innerText()) });
          continue;
        }
        const job = popup.locator('.job-card').first();
        await until(async () => /Complete|Could not save|Cancelled/.test(await job.locator('.job-state').innerText()), 'download to finish', 90_000);
        if ((await job.locator('.job-state').innerText()) === 'Complete') {
          const name = await job.locator('.job-title').innerText();
          const filename = await worker.evaluate(name => chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'] })
            .then(rows => rows.find(r => r.filename.split(/[\\/]/).pop().startsWith(name.replace(/\.[^.]+$/, '')))?.filename), name);
          assert.ok(filename && path.dirname(filename) === downloads && existsSync(filename), 'New download exists in isolated directory');
          let result;
          try { result = probe(filename); } catch { result = { fullyDecoded: false }; }
          const sha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
          outcomes.push({ tag, result: 'saved', sha256, ...result });
        } else {
          outcomes.push({ tag, result: 'could not save', message: clean(await job.locator('.job-info').innerText()) });
        }
        await popup.locator('#mediaTab').click();
      }
      if (!paid) {
        assert.ok(outcomes.every(o => o.result !== 'saved' || (o.fullyDecoded && o.duration <= 10.001 &&
          o.streams.every(stream => stream.end <= 10.001))), 'Unauthenticated download exceeded the preview or failed validation');
      }
      return { playback, detectedItems: ids.length, outcomes,
        downloaderContained: paid ? outcomes.every(outcome => outcome.result !== 'saved') : true };
    } finally { await popup?.close(); await page.close(); }
  }

  // The embedding site publishes public iframe URLs. The test simulates the
  // receipt return only inside the selected frame, outside the host document.
  hostServer = createServer((req, res) => {
    const films = ['/compact', '/single'].includes(req.url) ? ['clock'] : ['clock', 'second', 'clock'];
    const size = req.url === '/compact' ? '' : 'width="384" height="340"';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Independent embeds</title>' + films.map((film, i) =>
      '<iframe ' + size + ' name="film' + i + '" allow="autoplay" src="' + embed(film) + '"></iframe>').join(''));
  });
  await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve));
  await attempt('preview', () => testDownloader('preview'));
  await attempt('embeddedPreview', () => testDownloader('preview', true));
  await attempt('previewRepresentation', async () => {
    const saved = name => (tests[name].outcomes || []).find(item => item.result === 'saved' && item.fullyDecoded);
    const first = saved('preview'), embedded = saved('embeddedPreview');
    if (!first || !embedded) return { compared: false };
    assert.equal(first.sha256, embedded.sha256, 'Unchanged public preview must be byte-identical across range requests');
    return { compared: true, sha256: first.sha256 };
  });
  if (!previewOnly) {
    await attempt('rental', () => testDownloader('rental'));
    await attempt('embeddedRental', () => testDownloader('rental', true));
    await attempt('compactEmbeddedRental', () => testDownloader('rental', true, true));
    await attempt('independentEmbeds', async () => {
      const page = await context.newPage();
      try {
        await page.goto('http://localhost:' + hostServer.address().port);
        const [rental, second, otherClock] = [0, 1, 2].map(index => page.frame({ name: 'film' + index }));
        assert.ok(rental && second && otherClock, 'All three embeds loaded');
        await rental.goto('about:blank');
        await rental.goto(embed('clock', true));
        // One viewer has one pointer. Start each frame in turn and leave all playing.
        const full = await startPlayer(rental, paidName);
        const free = await startPlayer(second, previewName);
        const sibling = await startPlayer(otherClock, previewName);
        const seekTime = await seek(full, 120);
        const previewTimes = await Promise.all([free, sibling].map(video => video.evaluate(v => ({ time: v.currentTime, duration: v.duration }))));
        assert.ok(previewTimes.every(v => v.time > 0 && v.duration <= 10.001));
        for (const frame of [second, otherClock]) {
          const paidButton = frame.getByRole('button', { name: paidName });
          assert.ok(!await paidButton.isVisible() || !await paidButton.isEnabled(), 'Sibling embed still requires a rental');
        }
        return { frames: 3, paidSeekTime: seekTime, previewTimes, cookies: 'Block third-party cookies enabled in clean profile' };
      } finally { await page.close(); }
    });
  }
  await attempt('originVisibility', async () => {
    await Promise.all(bodyChecks);
    const hosts = [...observedHosts];
    assert.equal(markerHits.size, 0, 'A configured storage reference was visible');
    assert.ok(counts.responseBodies > 0, 'Response bodies were inspected');
    assert.ok(hosts.length > 0 && hosts.every(host => ['localhost', '127.0.0.1'].includes(host)), 'An external origin was requested');
    return { httpHosts: hosts.sort(), checkedMarkers: sourceMarkers.map(([label]) => label), matchedMarkers: [...markerHits], counts };
  });
} catch (error) {
  report.error = clean(error.message);
  process.exitCode = 1;
} finally {
  await context?.close();
  if (hostServer?.listening) await new Promise(resolve => hostServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await writeFile(path.join(run, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('Browser report', path.join(run, 'browser-results.json'));
}
