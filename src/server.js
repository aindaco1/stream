import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRentalAuthority } from './rental.js';
import { openFilm } from './media.js';
import { playbackSettings } from './operator.js';
import { filmSpec, sourceFromEnv } from './config.js';
const assets = new Map([
  ['/app.js', ['../public/app.js', 'text/javascript']],
  ['/style.css', ['../public/style.css', 'text/css']],
  ['/hls.js', ['../node_modules/hls.js/dist/hls.light.min.js', 'text/javascript']]
]);
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'none'; frame-ancestors *; base-uri 'none'; form-action 'none'"
};

function reply(req, res, status, type, body, extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': data.length, ...extra });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function rangeFor(header, size) {
  const matches = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!matches || (!matches[1] && !matches[2])) return;
  const start = matches[1] ? Number(matches[1]) : Math.max(0, size - Number(matches[2]));
  const end = matches[1] && matches[2] ? Math.min(size - 1, Number(matches[2])) : size - 1;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size) return [start, end];
}

function playlist(segments) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...segments.map(s => s.duration))),
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-KEY:METHOD=AES-128,URI="key"'];
  segments.forEach(({ duration }, index) => {
    if (index) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:' + duration.toFixed(6) + ',', index + '.ts');
  });
  return [...lines, '#EXT-X-ENDLIST', ''].join('\n');
}

function encrypt(bytes, key, index) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(index), 8);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

export async function makeServer(openMaker) {
  const connections = new Map();
  function connection(maker) {
    // Concurrent embeds share their own maker's index. A failed provider can
    // retry independently and does not block another maker's screening.
    if (!connections.has(maker)) {
      const pending = openMaker(maker).catch(error => { connections.delete(maker); throw error; });
      connections.set(maker, pending);
    }
    return connections.get(maker);
  }
  const template = await readFile(new URL('../public/player.html', import.meta.url), 'utf8');
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { type, data: await readFile(new URL(file, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const send = (status, type, data, extra) => reply(req, res, status, type, data, extra);
    const fail = status => send(status, 'text/plain', { 400: 'Invalid request.', 403: 'Rental access unavailable.',
      404: 'Unavailable.', 405: 'Method unavailable.', 413: 'Request too large.', 503: 'Film temporarily unavailable.' }[status]);
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return fail(400);
      const path = req.url.split('?')[0];
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (read && staticFiles.has(path)) {
        const { type, data } = staticFiles.get(path);
        return send(200, type, data);
      }
      const embed = /^\/embed\/([a-z0-9-]+)$/.exec(path);
      if (read && (embed || path === '/')) {
        const spec = filmSpec(embed?.[1] || 'clock');
        if (!spec) return fail(404);
        return send(200, 'text/html; charset=utf-8', template.replaceAll('{{title}}', spec.title));
      }
      const route = /^\/film\/([a-z0-9-]+)\/(session|preview\.mp4|play\/(index\.m3u8|key|(?:0|[1-9]\d{0,3})\.ts))$/.exec(path);
      if (!route) return fail(404);
      const [, id, action, asset] = route;
      const spec = filmSpec(id);
      if (!spec) return fail(404);
      if (action !== 'session' && !read) return fail(405);
      const grant = /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(req.headers.authorization || '')?.[1];
      if (asset && !grant) return fail(403);
      if (action === 'session') {
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== 'http://' + host || req.headers['content-type'] !== 'text/plain') return fail(403);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return fail(413);
          chunks.push(chunk);
        }
        const { film, authority } = await connection(spec.maker);
        try {
          const grant = await authority.exchange(Buffer.concat(chunks).toString('utf8'), { film: spec.scope, revision: film.revision });
          return send(200, 'application/json', JSON.stringify(grant));
        } catch { return fail(403); }
      }
      const { film, authority } = await connection(spec.maker);
      if (action === 'preview.mp4') {
        const data = await film.preview();
        if (!req.headers.range) return send(200, 'video/mp4', data, { 'Accept-Ranges': 'bytes' });
        const range = rangeFor(req.headers.range, data.length);
        if (!range) return send(416, 'text/plain', '', { 'Content-Range': 'bytes */' + data.length });
        const [from, to] = range;
        return send(206, 'video/mp4', data.subarray(from, to + 1), {
          'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + from + '-' + to + '/' + data.length
        });
      }
      const scope = { film: spec.scope, revision: film.revision };
      let key;
      try {
        if (asset === 'index.m3u8') await authority.verifyGrant(grant, scope);
        else key = await authority.keyForGrant(grant, scope);
      } catch { return fail(403); }
      if (asset === 'index.m3u8') return send(200, 'application/vnd.apple.mpegurl', playlist(film.segments));
      if (asset === 'key') return send(200, 'application/octet-stream', key);
      const index = Number(asset.slice(0, -3));
      if (index >= film.segments.length) return fail(404);
      return send(200, 'video/mp2t', encrypt(await film.segment(index), key, index));
    } catch {
      if (!res.headersSent && !res.destroyed) fail(503);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.maxConnections = 64;
  server.on('close', () => {
    for (const pending of connections.values()) pending.then(({ film }) => film.close(), () => {});
    connections.clear();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = await makeServer(async maker => {
    const env = await playbackSettings({ signing: true, maker });
    const authority = createRentalAuthority(env.STREAM_RENTAL_SECRET);
    return { film: await openFilm(sourceFromEnv(env, maker)), authority };
  });
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () =>
    console.log('Stream is listening at http://127.0.0.1:' + server.address().port + '/embed/clock'));
}
