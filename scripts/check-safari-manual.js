import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rehearsalOrigins } from './safari-settings.js';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sampleFrame, referenceMismatch } from './safari-frames.js';
const { bind, publisherHost, player: upstream } = rehearsalOrigins();
const cap = randomBytes(18).toString('hex');
const joinToken = randomBytes(24).toString('hex');
let redeemed = false;
let viewerAddress;
const operator =
  process.env.STREAM_STATE_DIR || join(homedir(), 'Library/Application Support/Dust Wave Stream Prototype');
const returnHandles = new Map(['clock', 'feature'].map((film) => [film, randomBytes(24).toString('hex')]));
const tickets = new Map();
for (const film of ['clock', 'feature'])
  tickets.set(
    film,
    (
      await readFile(join(operator, film === 'feature' ? 'feature/receipt.txt' : 'receipt.txt'), 'utf8')
    ).trim(),
  );
const report = {
  target: 'manual Safari',
  transport: 'Real Mobile Safari. Native taps and same-origin read-only QA frame observer.',
  runs: [],
  passed: false,
  started: new Date().toISOString(),
};
const evidence = resolve(process.env.EVIDENCE_DIR || 'test-results');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const outfile = join(evidence, 'safari-manual-' + Date.now() + '.json');
const reference = {
  clock: process.env.STREAM_CLOCK_FILE || '.local/clock.mp4',
  feature: process.env.STREAM_FEATURE_FILE || '.local/feature-clock.mp4',
};
function mediaState(value) {
  if (!value || !Number.isFinite(value.time) || !Number.isFinite(value.duration))
    throw Error('Invalid media state');
  return {
    time: value.time,
    duration: value.duration,
    muted: value.muted === true,
    paused: value.paused === true,
    ended: value.ended === true,
  };
}

let app, host;
async function publisherScript(appOrigin, cap) {
  const invite = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const link = invite.get('join');
  const creds = await fetch('/' + cap + '/join', {
    method: 'POST',
    body: link,
    headers: { 'content-type': 'text/plain' },
  });
  if (!creds.ok) {
    document.querySelector('p').textContent = 'This rehearsal invitation has expired.';
    return;
  }
  const handles = new URLSearchParams(await creds.text());
  const scenarios = [
    ['feature', 'clock', [2700, 5340, 300]],
    ['clock', 'feature', [120, 20]],
  ];
  let index = 0;
  const state = document.querySelector('p');
  const post = async (record) => {
    const response = await fetch('/' + cap + '/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw Error('The Mac could not verify this screening.');
  };
  async function phase() {
    const [paid, free, seeks] = scenarios[index];
    const frames = document.querySelectorAll('iframe');
    const sample = (frame, cmd, args) =>
      new Promise((resolve, reject) => {
        const nonce = Math.random().toString(36).slice(2);
        const timeout = setTimeout(() => {
          window.removeEventListener('message', listen);
          reject(Error('Timeout in ' + cmd));
        }, 60000);
        function listen(e) {
          if (e.origin !== appOrigin || e.source !== frame.contentWindow || e.data?.nonce !== nonce) return;
          window.removeEventListener('message', listen);
          clearTimeout(timeout);
          resolve(e.data.result);
        }
        window.addEventListener('message', listen);
        frame.contentWindow.postMessage({ nonce, cmd, args }, appOrigin);
      });
    state.textContent = 'Checking ' + paid + ' rental';
    const played = new Set();
    state.textContent = 'Tap Play rental, then tap Play 10-second preview below.';
    const events = (e) => {
      if (e.origin === appOrigin && e.data?.type === 'playing') {
        if (e.source === frames[0].contentWindow) {
          played.add(0);
          state.textContent = 'Rental playing. Tap Play 10-second preview below.';
        }
        if (e.source === frames[1].contentWindow) {
          played.add(1);
          state.textContent = 'Checking the screening. Leave Safari open.';
        }
      }
    };
    window.addEventListener('message', events);
    frames[0].src = appOrigin + '/return/' + paid + '/' + handles.get(paid);
    frames[1].src = appOrigin + '/embed/' + free + '?qa=free';
    try {
      const until = Date.now() + 600000;
      while (played.size < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
      if (played.size !== 2) throw Error('Trusted clicks did not start both films');
      const paidState = await sample(frames[0], 'state'),
        freeState = await sample(frames[1], 'state');
      const data = { paid, free, paidState, freeState, seeks: [] };
      if (paidState.paused) throw Error('Starting preview paused paid screen');
      for (const seconds of seeks)
        data.seeks.push({ ...(await sample(frames[0], 'seek', seconds)), seconds });
      let freeEnd = Date.now() + 18000;
      do {
        data.freeAfter = await sample(frames[1], 'state');
        if (data.freeAfter.ended) break;
        await new Promise((r) => setTimeout(r, 200));
      } while (Date.now() < freeEnd);
      data.paidAfter = await sample(frames[0], 'state');
      if (!data.freeAfter.ended || data.paidAfter.paused) throw Error('Preview did not end independently');
      await post({ data, userAgent: navigator.userAgent });
      if (++index < scenarios.length) {
        await phase();
      } else {
        await post({ complete: true });
        state.textContent = 'Safari rehearsal complete';
      }
    } catch (e) {
      state.textContent = 'Safari rehearsal interrupted';
      await post({ error: true }).catch(() => {});
    } finally {
      window.removeEventListener('message', events);
    }
  }
  phase();
}
function frameAgent(hostOrigin, sampleFrame) {
  const video = document.querySelector('video');
  const free = new URL(location.href).searchParams.get('qa') === 'free';
  if (free) video.muted = true;
  video.addEventListener('playing', () => parent.postMessage({ type: 'playing' }, hostOrigin));
  window.addEventListener('message', async (e) => {
    if (e.origin !== hostOrigin || e.source !== parent || !e.data?.nonce) return;
    const { cmd, nonce, args } = e.data;
    let result;
    if (cmd === 'state') {
      result = {
        time: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        ended: video.ended,
        muted: video.muted,
        status: document.querySelector('#status').textContent,
      };
    } else if (cmd === 'seek') {
      const start = performance.now();
      sampleFrame(args);
      while (!window.streamSample && performance.now() - start < 50000)
        await new Promise((r) => setTimeout(r, 75));
      if (!window.streamSample) result = { error: 'No presented frame' };
      else result = { ...window.streamSample, seekMs: Math.round(performance.now() - start) };
    } else return;
    parent.postMessage({ nonce, result }, hostOrigin);
  });
}
const appPath =
  /^\/(?:embed\/(?:clock|feature)|app\.js|style\.css|hls\.js|film\/(?:clock|feature)\/(?:session|preview\.mp4|play\/(?:index\.m3u8|key|[0-9]{1,4}\.ts)))$/;
const server = createServer(async (q, r) => {
  try {
    const origin = new URL('http://' + q.headers.host).origin;
    const p = new URL(q.url, origin).pathname;
    if (redeemed && q.socket.remoteAddress !== viewerAddress) {
      r.writeHead(403);
      return r.end();
    }
    const send = (code, type, value) => {
      r.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      r.end(value);
    };
    if (
      origin === host &&
      p === '/' + cap + '/join' &&
      q.method === 'POST' &&
      q.headers.origin === host &&
      !redeemed
    ) {
      let text = '';
      for await (const chunk of q) {
        text += chunk;
        if (text.length > 100) throw Error('invalid');
      }
      if (text !== joinToken) return send(403, 'text/plain', '');
      redeemed = true;
      viewerAddress = q.socket.remoteAddress;
      console.log('Private test invitation redeemed');
      return send(200, 'text/plain', new URLSearchParams(returnHandles).toString());
    }
    if (origin === host && p === '/' + cap && q.method === 'GET') {
      return send(
        200,
        'text/html',
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}iframe{width:100%;height:224px;display:block}p{margin:4px}</style><title>Stream Safari rehearsal</title><p>Prepare</p><iframe title="Rental" allow="autoplay"></iframe><iframe title="Preview" allow="autoplay"></iframe><script>(' +
          publisherScript.toString() +
          ')(' +
          JSON.stringify(app) +
          ',' +
          JSON.stringify(cap) +
          ')</script>',
      );
    }
    if (
      redeemed &&
      origin === host &&
      p === '/' + cap + '/record' &&
      q.headers.origin === host &&
      q.method === 'POST'
    ) {
      let text = '';
      for await (const chunk of q) {
        text += chunk;
        if (text.length > 20000) throw Error('too large');
      }
      const payload = JSON.parse(text);
      if (payload.data) {
        const { paid, free, seeks } = payload.data;
        const expected = report.runs.length === 0 ? ['feature', 'clock'] : ['clock', 'feature'];
        const plannedSeeks = paid === 'feature' ? [2700, 5340, 300] : [120, 20];
        if (
          paid !== expected[0] ||
          free !== expected[1] ||
          !Array.isArray(seeks) ||
          seeks.length !== plannedSeeks.length ||
          !seeks.every((sample, i) => sample.seconds === plannedSeeks[i])
        ) {
          throw Error('Unexpected browser screening');
        }
        const reviewed = {
          paid,
          free,
          paidState: mediaState(payload.data.paidState),
          freeState: mediaState(payload.data.freeState),
          freeAfter: mediaState(payload.data.freeAfter),
          paidAfter: mediaState(payload.data.paidAfter),
          seeks: [],
        };
        for (const s of seeks) {
          if (
            !/^[01]{2940}$/.test(s.mask) ||
            !Number.isFinite(s.mediaTime) ||
            Math.abs(s.mediaTime - s.seconds) > 7 ||
            !Number.isFinite(s.seekMs) ||
            !Number.isSafeInteger(s.presentedFrames)
          )
            throw Error('Invalid presented frame');
          reviewed.seeks.push({
            seconds: s.seconds,
            decoded: s.mediaTime,
            presentedFrames: s.presentedFrames,
            seekMs: s.seekMs,
            mismatch: referenceMismatch(reference[paid], s, paid === 'clock' ? 24 : 12),
          });
        }
        report.runs.push(reviewed);
        report.safariVersion = /Version\/([0-9.]+)/.exec(String(payload.userAgent))?.[1] || 'unknown';
        console.log(
          'measured',
          paid,
          reviewed.seeks.map((s) => [s.seconds, s.mismatch]),
        );
      } else if (payload.complete || payload.error) {
        if (payload.error) report.error = 'The browser could not complete this screening.';
        report.passed =
          payload.complete === true &&
          report.runs.length === 2 &&
          report.runs.every(
            (s) =>
              s.seeks.every((r) => r.mismatch < 0.025) &&
              !s.paidState.paused &&
              !s.paidState.muted &&
              s.paidState.duration === (s.paid === 'feature' ? 5400 : 136) &&
              s.freeAfter.duration === 10 &&
              s.freeAfter.ended &&
              Math.abs(s.freeAfter.time - 10) < 0.05 &&
              !s.paidAfter.paused,
          );
        process.exitCode = report.passed ? 0 : 1;
        await writeFile(outfile, JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log('final', report.passed, outfile);
        setTimeout(() => server.close(), 100);
        return send(report.passed ? 200 : 422, 'text/plain', report.passed ? 'verified' : 'failed');
      }
      return send(200, 'text/plain', 'ok');
    }
    if (!redeemed || origin !== app) return send(404, 'text/plain', '');
    const returned = /^\/return\/(clock|feature)\/([a-f0-9]{48})$/.exec(p);
    if (q.method === 'GET' && returned && returnHandles.get(returned[1]) === returned[2]) {
      const film = returned[1];
      returnHandles.delete(film);
      r.writeHead(303, {
        location: '/embed/' + film + '?qa=paid#receipt=' + encodeURIComponent(tickets.get(film)),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return r.end();
    }
    if (p === '/' + cap + '/observe.js')
      return send(
        200,
        'text/javascript',
        '(' + frameAgent.toString() + ')(' + JSON.stringify(host) + ',' + sampleFrame.toString() + ')',
      );
    if (
      !appPath.test(p) ||
      !q.url.startsWith('/') ||
      q.url.startsWith('//') ||
      !['GET', 'POST', 'HEAD'].includes(q.method)
    )
      return send(404, 'text/plain', '');

    const headers = {};
    for (const key of ['authorization', 'range', 'content-type'])
      if (q.headers[key]) headers[key] = q.headers[key];
    if (q.method === 'POST' && (q.headers.origin !== app || !p.endsWith('/session')))
      return send(403, 'text/plain', '');
    if (q.headers.origin === app) headers.origin = upstream.origin;
    let body;
    if (q.method === 'POST') {
      body = '';
      for await (const chunk of q) {
        body += chunk;
        if (body.length > 2048) throw Error('invalid body');
      }
    }
    const destination = new URL(q.url, upstream);
    if (destination.origin !== upstream.origin || destination.username || destination.password)
      return send(404, 'text/plain', '');
    const u = await fetch(destination, {
      method: q.method,
      headers,
      body,
      redirect: 'error',
    });
    const h = Object.fromEntries(u.headers);
    delete h['content-length'];
    delete h.connection;
    delete h['keep-alive'];
    let data = Buffer.from(await u.arrayBuffer());
    if (p.startsWith('/embed/'))
      data = Buffer.from(
        data.toString().replace('</body>', '<script src="/' + cap + '/observe.js"></script></body>'),
      );
    r.writeHead(u.status, h);
    r.end(data);
  } catch {
    r.writeHead(503);
    r.end();
  }
});
await new Promise((resolve) => server.listen(0, bind, resolve));
const n = server.address().port;
app = 'http://' + bind + ':' + n;
host = new URL('http://' + publisherHost + ':' + n).origin;
const url = host + '/' + cap + '#join=' + joinToken;
const qrDir = await mkdtemp(join(operator, 'iphone-rehearsal-'));
const qr = join(qrDir, 'Safari rehearsal.png');
const swift = fileURLToPath(new URL('./safari-qr.swift', import.meta.url));
const encoding = spawnSync('swift', [swift, qr], { input: url, stdio: ['pipe', 'ignore', 'ignore'] });
if (encoding.status !== 0) {
  server.close();
  throw Error('Unable to render private QR with Swift/Core Image');
}
await chmod(qr, 0o600);
console.log('Scan the one-use QR on this LAN within 10 minutes:', qr);
const expiry = setTimeout(
  () => {
    server.close();
    process.exitCode = 1;
    console.log('Rehearsal expired');
  },
  10 * 60 * 1000,
);
expiry.unref();
