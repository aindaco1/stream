import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createRentalAuthority } from './rental.js';
import { openFilm } from './media.js';
import { createSetup } from './setup.js';
import { escapeHtml } from './setup-view.js';
import { playbackSettings } from './operator.js';
import { filmSpec, sourceFromEnv } from './config.js';
const assets = new Map([
  ['/app.js', ['../public/app.js', 'text/javascript']],
  ['/checkout.js', ['../public/checkout.js', 'text/javascript']],
  ['/payment.js', ['../public/payment.js', 'text/javascript']],
  ['/screening.css', ['../public/screening.css', 'text/css']],
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

async function body(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Only published player pages load Stripe. Each filmmaker's payment UI mounts
// inside that film's frame. Card details are collected by Stripe.
const stripePlayerHeaders = {
  'Referrer-Policy': 'strict-origin',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com",
    "style-src 'self'", "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://link.com https://*.link.com",
    "frame-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com https://link.com https://*.link.com",
    "img-src 'self' data: https://*.stripe.com https://*.link.com", "media-src 'self' blob:", "worker-src 'none'",
    "frame-ancestors *", "base-uri 'none'", "form-action 'self'"
  ].join('; ')
};

function attachmentName(title) {
  const name = String(title).replace(/[\p{C}/\\]/gu, '').trim().slice(0, 150).toWellFormed() || 'film';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  return "attachment; filename=\"film.mp4\"; filename*=UTF-8''" + encoded + '.mp4';
}

const checkoutHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex'
};

export async function makeServer(openMaker, { setup, publicOrigin, catalog, checkout } = {}) {
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin) throw new Error('Set STREAM_PUBLIC_ORIGIN to an HTTPS origin.');
  }
  const connections = new Map();
  function connection(spec) {
    const key = spec.id || spec.maker;
    // Concurrent embeds share their own maker's index. A failed provider can
    // retry independently and does not block another maker's screening.
    if (!connections.has(key)) {
      const opening = spec.id ? catalog.open(spec.id).then(film => ({ film, authority: spec.authority })) : openMaker(spec.maker);
      const pending = opening.catch(error => { connections.delete(key); throw error; });
      connections.set(key, pending);
    }
    return connections.get(key);
  }
  const [template, payPage, returnPage, screening] = await Promise.all(
    ['player', 'checkout', 'return', 'screening'].map(name => readFile(new URL('../public/' + name + '.html', import.meta.url), 'utf8')));
  const lookup = id => catalog?.get(id) || (openMaker && filmSpec(id));
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { type, data: await readFile(new URL(file, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const send = (status, type, data, extra) => reply(req, res, status, type, data, extra);
    const fail = status => send(status, 'text/plain', { 400: 'Invalid request.', 403: 'Film access unavailable.',
      404: 'Unavailable.', 405: 'Method unavailable.', 409: 'Offer unavailable.', 410: 'Order expired.',
      413: 'Request too large.', 429: 'Try again later.', 503: 'Film temporarily unavailable.' }[status] || 'Unavailable.');
    try {
      const host = req.headers.host || '';
      if (publicOrigin ? host !== new URL(publicOrigin).host : !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return fail(400);
      const origin = publicOrigin || 'http://' + host;
      const path = req.url.split('?')[0];
      const sendMp4 = (data, extra = {}) => {
        const mediaHeaders = { ...extra, 'Accept-Ranges': 'bytes' };
        if (!req.headers.range) return send(200, 'video/mp4', data, mediaHeaders);
        const range = rangeFor(req.headers.range, data.length);
        if (!range) return send(416, 'text/plain', '', { ...extra, 'Content-Range': 'bytes */' + data.length });
        const [from, to] = range;
        return send(206, 'video/mp4', data.subarray(from, to + 1), {
          ...mediaHeaders, 'Content-Range': 'bytes ' + from + '-' + to + '/' + data.length
        });
      };
      if (setup && (path === '/setup' || path.startsWith('/setup/'))) {
        return await setup.handle(req, { path, origin, send, sendMp4 });
      }
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (read && staticFiles.has(path)) {
        const { type, data } = staticFiles.get(path);
        return send(200, type, data);
      }
      if (catalog && read && (path === '/screening' || path === '/')) {
        const embeds = catalog.list().map(({ id, title }) =>
          '<iframe src="/embed/' + encodeURIComponent(id) + '" title="' + escapeHtml(title) +
          '" allow="autoplay; fullscreen; encrypted-media; payment" allowfullscreen></iframe>').join('\n');
        return send(200, 'text/html; charset=utf-8', screening.replace('{{embeds}}', () => embeds || '<p>No films available.</p>'),
          { 'Content-Security-Policy': "default-src 'none'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Robots-Tag': 'noindex' });
      }
      if (checkout && path === '/checkout/webhook') {
        if (req.method !== 'POST') return fail(405);
        const result = await checkout.webhook(await body(req, 256 * 1024), req.headers['stripe-signature']);
        return send(200, 'application/json', JSON.stringify(result));
      }
      if (checkout && read && (path === '/checkout/return' || path === '/checkout/cancel')) {
        const cancelled = path === '/checkout/cancel';
        return send(200, 'text/html; charset=utf-8', returnPage
          .replaceAll('{{heading}}', cancelled ? 'Checkout cancelled' : 'Return to your film')
          .replaceAll('{{message}}', cancelled ? 'You can close this tab and return to the preview.' :
            'You can close this tab. Your player checks the payment with Stripe and unlocks your film when it clears.'), checkoutHeaders);
      }
      const pay = /^\/pay\/([a-z0-9-]+)$/.exec(path);
      if (checkout && read && pay) {
        const offer = catalog.get(pay[1]);
        if (!offer) return fail(404);
        return send(200, 'text/html; charset=utf-8', payPage.replaceAll('{{title}}', () => escapeHtml(offer.title)), checkoutHeaders);
      }
      const embed = /^\/embed\/([a-z0-9-]+)$/.exec(path);
      if (read && (embed || path === '/')) {
        const spec = lookup(embed?.[1] || 'clock');
        if (!spec) return fail(404);
        const payable = Boolean(checkout && spec.id);
        const html = template.replaceAll('{{checkout}}', String(payable))
          .replaceAll('{{rent}}', String(spec.prices?.rent ?? ''))
          .replaceAll('{{buy}}', String(spec.prices?.buy ?? ''))
          .replaceAll('{{title}}', () => escapeHtml(spec.title));
        return send(200, 'text/html; charset=utf-8', html, payable ? stripePlayerHeaders : {});
      }
      const route = /^\/film\/([a-z0-9-]+)\/(checkout|buy|order|session|download|preview\.mp4|play\/(index\.m3u8|key|(?:0|[1-9]\d{0,3})\.ts))$/.exec(path);
      if (!route) return fail(404);
      const [, id, action, asset] = route;
      const spec = lookup(id);
      if (!spec) return fail(404);
      const grant = /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(req.headers.authorization || '')?.[1];
      if (asset && !grant) return fail(403);
      if (action === 'download') {
        if (!checkout || !spec.id) return fail(404);
        let downloadGrant = grant;
        const scope = { film: spec.scope, revision: spec.revision };
        if (req.method === 'POST') {
          if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return fail(403);
          const form = new URLSearchParams((await body(req, 8192)).toString('utf8'));
          try { downloadGrant = (await spec.authority.exchange(form.get('receipt'), scope)).grant; }
          catch { return fail(403); }
        } else if (!read) return fail(405);
        if (!downloadGrant) return fail(403);
        let purchase;
        try { purchase = await spec.authority.verifyDownloadGrant(downloadGrant, scope); }
        catch { return fail(403); }
        if (!await checkout.verifyPurchase({ offer: spec, orderId: purchase.orderId })) return fail(403);
        const file = await catalog.download(id, downloadGrant);
        const range = req.headers.range && rangeFor(req.headers.range, file.size);
        if (req.headers.range && !range) return send(416, 'text/plain', '', { 'Content-Range': 'bytes */' + file.size });
        const [from, to] = range || [0, file.size - 1];
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'video/mp4',
          'Content-Disposition': attachmentName(file.title), 'Accept-Ranges': 'bytes',
          ...(range && { 'Content-Range': 'bytes ' + from + '-' + to + '/' + file.size }),
          'Content-Length': to - from + 1 });
        if (req.method === 'HEAD') return res.end();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try { await pipeline(file.stream(from, to + 1, controller.signal), res, { signal: controller.signal }); }
        finally { res.off('close', cancel); }
        return;
      }
      if (['checkout', 'buy', 'order', 'session'].includes(action)) {
        if (action !== 'session' && (!checkout || !spec.id)) return fail(404);
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'text/plain') return fail(403);
        const token = (await body(req, action === 'session' ? 4096 : 64)).toString('utf8');
        if (action !== 'session') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail(400);
          const result = action === 'order' ? await checkout.status({ offer: spec, token }) :
            await checkout.start({ offer: await catalog.verify(id), kind: action === 'buy' ? 'buy' : 'rent', token, origin });
          return send(200, 'application/json', JSON.stringify(result), checkoutHeaders);
        }
        const { film, authority } = await connection(spec);
        try {
          const grant = await authority.exchange(token, { film: spec.scope, revision: film.revision });
          return send(200, 'application/json', JSON.stringify(grant));
        } catch { return fail(403); }
      }
      if (!read) return fail(405);
      const { film, authority } = await connection(spec);
      if (action === 'preview.mp4') return sendMp4(await film.preview());
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
    } catch (error) {
      if (!res.headersSent && !res.destroyed) fail([400, 403, 404, 409, 410, 413, 429].includes(error.statusCode) ? error.statusCode : 503);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.maxConnections = 64;
  server.on('close', () => {
    for (const pending of connections.values()) pending.then(({ film }) => film.close(), () => {});
    connections.clear();
    setup?.close();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = await makeServer(async maker => {
    const env = await playbackSettings({ signing: true, maker });
    const authority = createRentalAuthority(env.STREAM_RENTAL_SECRET);
    return { film: await openFilm(sourceFromEnv(env, maker)), authority };
  }, { setup: await createSetup(), publicOrigin: process.env.STREAM_PUBLIC_ORIGIN });
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () =>
    console.log('Filmmaker setup: ' + (process.env.STREAM_PUBLIC_ORIGIN || 'http://127.0.0.1:' + server.address().port) + '/setup'));
}
