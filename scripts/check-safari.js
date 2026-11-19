import { spawn } from 'node:child_process';
import { sampleFrame, referenceMismatch } from './safari-frames.js';
import { rehearsalOrigins } from './safari-settings.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const target = process.argv[2] || 'desktop';
assert.ok(['desktop', 'simulator'].includes(target), 'Select desktop or simulator');
const { bind, publisherHost, player } = rehearsalOrigins();
const state =
  process.env.STREAM_STATE_DIR ||
  path.join(homedir(), 'Library/Application Support/Dust Wave Stream Prototype');
const receipts = {
  clock: (await readFile(path.join(state, 'receipt.txt'), 'utf8')).trim(),
  feature: (await readFile(path.join(state, 'feature/receipt.txt'), 'utf8')).trim(),
};
const evidence = path.resolve(process.env.EVIDENCE_DIR || 'test-results');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const report = { target, started: new Date().toISOString(), runs: [] };
const runName = 'safari-' + target + '-' + Date.now() + '.json';
const publisherPath = '/' + randomBytes(15).toString('hex');
let session, driver, site, publisherURL;
const port = Number(process.env.SAFARI_DRIVER_PORT || 0);
const referenceFiles = {
  clock: process.env.STREAM_CLOCK_FILE || '.local/clock.mp4',
  feature: process.env.STREAM_FEATURE_FILE || '.local/feature-clock.mp4',
};
function safe(error) {
  return String(error?.message || error)
    .replace(/(?:https?|blob):[^\s]+/gi, '[URL]')
    .replace(/[a-z\d_.=-]{24,}/gi, '[redacted]')
    .slice(0, 400);
}
const source = (film, receipt) => {
  const url = new URL('/embed/' + film, player);
  if (receipt) {
    url.search = '?return=1'; // Return navigation reloads the public document.
    url.hash = new URLSearchParams({ receipt });
  }
  return url.href;
};
const server = createServer((req, res) => {
  const view = req.url.split('?')[0];
  if (req.method !== 'GET' || req.headers.host !== new URL(publisherURL).host || view !== publisherPath) {
    res.writeHead(404);
    return res.end();
  }
  // Only the two public film URLs appear in this embedding page.
  res.writeHead(200, {
    'content-type': 'text/html',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stream Safari rehearsal</title>' +
      '<style>body{margin:0}iframe{display:block;width:min(100%,480px);height:280px;border:0}</style>' +
      ['feature', 'clock']
        .map(
          (film) =>
            '<iframe title="' + film + '" allow="autoplay; fullscreen" src="' + source(film) + '"></iframe>',
        )
        .join(''),
  );
});
async function listen(s, host, port) {
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, resolve);
  });
}
async function until(fn, label, limit = 30_000) {
  const start = Date.now();
  do {
    const value = await fn();
    if (value) return value;
    await delay(150);
  } while (Date.now() - start < limit);
  throw new Error('Timed out waiting for ' + label);
}
const elementId = 'element-6066-11e4-a52e-4f735466cecf';
let driverURL;
async function wire(method, resource, body) {
  const response = await fetch(driverURL + resource, {
    method,
    signal: AbortSignal.timeout(105_000),
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(value?.error + ': ' + value?.message);
  return value;
}
const call = (method, route, body) => wire(method, '/session/' + session + route, body);
const js = (script, ...args) => call('POST', '/execute/sync', { script, args });
async function selectFrame(film) {
  await call('POST', '/frame', { id: null });
  const frame = await call('POST', '/element', {
    using: 'css selector',
    value: 'iframe[title="' + film + '"]',
  });
  await call('POST', '/frame', { id: frame });
}
async function getState() {
  return js(
    'const v=document.querySelector("video");return v ? {time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,ready:v.readyState,paused:v.paused,ended:v.ended,muted:v.muted,error:v.error?.code||0,status:document.querySelector("#status").textContent} : null;',
  );
}
async function userPlay(label) {
  await until(
    () =>
      js(
        'const b=document.getElementById("play");return !!b && !b.disabled && b.textContent==arguments[0]',
        label,
      ),
    label,
  );
  // Keep the ordinary first-click rental audible. The sibling preview is muted
  // so the OS need not choose between two audible playback sessions.
  await js('document.querySelector("video").muted=arguments[0]', label !== 'Play rental');
  const button = await call('POST', '/element', { using: 'css selector', value: '#play' });
  await call('POST', '/element/' + button[elementId] + '/click', {});
  try {
    return await until(async () => {
      const s = await getState();
      return s?.time > 0.12 && !s.paused && s;
    }, label + ' playback');
  } catch (error) {
    const s = await getState();
    throw new Error(error.message + ' ' + JSON.stringify(s));
  }
}
async function checkSeek(film, seconds) {
  const began = Date.now();
  await js('(' + sampleFrame.toString() + ')(arguments[0]);', seconds);
  const s = await until(() => js('return window.streamSample'), 'decoded frame at ' + seconds, 40_000);
  const mismatch = referenceMismatch(referenceFiles[film], s, film === 'feature' ? 12 : 24);
  assert.ok(
    mismatch < 0.025,
    'Decoded timecode differs from the source at ' + seconds + 's; mismatch ' + mismatch.toFixed(4),
  );
  return {
    requestedSeconds: seconds,
    decodedSeconds: s.mediaTime,
    presentedFrames: s.presentedFrames,
    seekAndProbeMs: Date.now() - began,
    referenceMaskMismatch: Number(mismatch.toFixed(4)),
  };
}
async function screening(paid, free, positions) {
  const record = { paid, free, seeks: [] };
  report.runs.push(record);
  record.firstClickMuted = false;
  await call('POST', '/url', { url: publisherURL });
  await selectFrame(paid);
  await js('location.replace(arguments[0]);', source(paid, receipts[paid]));
  await selectFrame(paid);
  const started = await userPlay('Play rental');
  record.paidDuration = started.duration;
  assert.ok(Math.abs(started.duration - (paid === 'feature' ? 5400 : 136)) < 0.2);
  await selectFrame(free);
  const preview = await userPlay('Play 10-second preview');
  record.previewDuration = preview.duration;
  assert.ok(Math.abs(preview.duration - 10) < 0.05);
  await selectFrame(paid);
  record.afterPreviewStarts = await getState();
  if (record.afterPreviewStarts.paused) {
    throw new Error('Safari paused the paid player when its sibling preview started');
  }
  for (const seconds of positions) record.seeks.push(await checkSeek(paid, seconds));
  await selectFrame(free);
  record.freeAfterPaidSeek = await until(
    async () => {
      const previewState = await getState();
      return previewState.ended && previewState;
    },
    'independent preview to finish',
    18000,
  );
  assert.ok(
    record.freeAfterPaidSeek.duration <= 10.05 && record.freeAfterPaidSeek.time <= 10.05,
    'Free sibling exceeded preview',
  );
  await selectFrame(paid);
  record.paidAfterPreviewEnds = await getState();
  assert.ok(
    !record.paidAfterPreviewEnds.paused && record.paidAfterPreviewEnds.time > positions.at(-1),
    'Paid film kept playing after the sibling preview ended',
  );
  record.passed = true;
}
try {
  if (!port) {
    const socket = createServer();
    await listen(socket, '127.0.0.1', 0);
    const p = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    driver = spawn('/usr/bin/safaridriver', ['-p', String(p)], { stdio: 'ignore' });
    driverURL = 'http://127.0.0.1:' + p;
  } else driverURL = 'http://127.0.0.1:' + port;
  await until(
    () =>
      fetch(driverURL + '/status').then(
        (r) => r.ok,
        () => false,
      ),
    'SafariDriver',
  );
  const caps = { browserName: 'Safari', platformName: target === 'desktop' ? 'macOS' : 'iOS' };
  if (target === 'simulator') caps['safari:useSimulator'] = true;
  if (process.env.SAFARI_DEVICE_UDID) caps['safari:deviceUDID'] = process.env.SAFARI_DEVICE_UDID;
  const created = await wire('POST', '/session', { capabilities: { alwaysMatch: caps } });
  session = created.sessionId;
  report.browser = Object.fromEntries(
    Object.entries(created.capabilities).filter(([k]) =>
      [
        'browserName',
        'browserVersion',
        'platformName',
        'safari:platformVersion',
        'safari:deviceType',
        'safari:useSimulator',
      ].includes(k),
    ),
  );
  await listen(server, bind, 0);
  site = server.address();
  publisherURL = 'http://' + publisherHost + ':' + site.port + publisherPath;
  report.userAgent = await js('return navigator.userAgent');
  report.mediaAPIs = await js(
    'return {mse:!!window.MediaSource,managed:!!window.ManagedMediaSource,renderedFrameCallback:!!HTMLVideoElement.prototype.requestVideoFrameCallback}',
  );
  await screening('feature', 'clock', [2700, 5340, 300]);
  await screening('clock', 'feature', [120, 20]);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = safe(error);
  process.exitCode = 1;
} finally {
  if (session) await call('DELETE', '').catch(() => {});
  if (driver) driver.kill('SIGTERM');
  if (site) await new Promise((resolve) => server.close(resolve));
  report.completed = new Date().toISOString();
  for (const film of Object.keys(referenceFiles))
    report[film + 'ReferenceSha256'] = createHash('sha256')
      .update(await readFile(referenceFiles[film]))
      .digest('hex');
  await writeFile(path.join(evidence, runName), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log((report.passed ? 'PASS' : 'INCOMPLETE') + ' ' + target, runName, report.error || '');
}
