import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createRentalAuthority } from './rental.js';
import { openFilm } from './media.js';
import { faqLink, siteFooter } from './site-frame.js';
import { renderFilmmakerFaq } from './filmmaker-help.js';
import { createSetup } from './setup.js';
import { escapeHtml, renderFilmInfo, selectedFields } from './film-embed.js';
import { playbackSettings } from './operator.js';
import { filmSpec, sourceFromEnv } from './config.js';
const assets = new Map([
  ['/app.js', ['../public/app.js', 'text/javascript']],
  ['/subtitles.js', ['../public/subtitles.js', 'text/javascript']],
  ['/checkout.js', ['../public/checkout.js', 'text/javascript']],
  ['/payment.js', ['../public/payment.js', 'text/javascript']],
  ['/platform-tip.js', [import.meta.resolve('@dustwave/worker-core/platform-tip'), 'text/javascript']],
  ['/filmmaker.css', ['../public/setup.css', 'text/css']],
  ['/filmmaker-dark.css', ['../public/setup-dark.css', 'text/css']],
  ['/dust-wave-square.webp', ['../public/dust-wave-square.webp', 'image/webp']],
  ['/site-frame.css', ['../public/site-frame.css', 'text/css']],
  ['/screening.css', ['../public/screening.css', 'text/css']],
  ['/style.css', ['../public/style.css', 'text/css']],
  ['/hls.js', ['../node_modules/hls.js/dist/hls.light.min.js', 'text/javascript']]
]);
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self' blob:; worker-src 'none'; frame-ancestors *; base-uri 'none'; form-action 'none'"
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

function playlist(segments, subtitleId) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...segments.map(s => s.duration))),
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-KEY:METHOD=AES-128,URI="key"'];
  segments.forEach(({ duration }, index) => {
    if (index) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:' + duration.toFixed(6) + ',', index + '.ts' + (subtitleId ? '?subtitle=' + subtitleId : ''));
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

function viewingOrder(text) {
  let request;
  try { request = JSON.parse(text); } catch { return null; }
  const address = request?.viewingAddress;
  if (!request || Object.keys(request).some(key => !['token','tipPercent','viewingAddress'].includes(key)) ||
      typeof request.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.token) ||
      !Number.isInteger(request.tipPercent) || request.tipPercent < 0 || request.tipPercent > 15 ||
      address?.country !== 'US' || address.state !== 'NM' ||
      Object.keys(address).some(key => !['country','state','city','line1','postalCode'].includes(key)) ||
      typeof address.postalCode !== 'string' || !/^\d{5}(-\d{4})?$/.test(address.postalCode)) return null;
  for (const [field, limit] of [['line1',200],['city',100]]) {
    if (typeof address[field] !== 'string' || !address[field].trim() || address[field].length > limit || /\p{Cc}/u.test(address[field])) return null;
  }
  return { token:request.token, tipPercent:request.tipPercent, viewingAddress:address };
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

function attachmentName(title, extension) {
  const name = String(title).replace(/[\p{C}/\\]/gu, '').trim().slice(0, 150).toWellFormed() || 'film';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
  return `attachment; filename="film.${extension}"; filename*=UTF-8''${encoded}.${extension}`;
}

const checkoutHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex'
};

export async function makeServer(openMaker, { setup, publicOrigin, catalog, checkout, recovery, maxIndexes = 32 } = {}) {
  if (!Number.isSafeInteger(maxIndexes) || maxIndexes < 1) throw new Error('A positive media index limit is required.');
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin) throw new Error('Set STREAM_PUBLIC_ORIGIN to an HTTPS origin.');
  }
  const connections = new Map();
  let stopping = false;
  function retire(entry) {
    if (connections.get(entry.key) !== entry) return;
    connections.delete(entry.key);
    entry.ready.then(({ film }) => film.close(), () => {});
  }
  function acquire(spec, entitled, held) {
    if (stopping) throw new Error('Film service is closing.');
    const key = spec.id ? [spec.id, spec.revision, entitled].join(':') : spec.maker;
    let entry = connections.get(key);
    if (!entry) {
      if (connections.size >= maxIndexes) {
        const idle = [...connections.values()].find(item => item.users === 0);
        if (!idle) throw new Error('Film indexes are busy.');
        retire(idle);
      }
      entry = { key, users: 0 };
      entry.ready = Promise.resolve().then(async () => spec.id ?
        { film: await catalog.open(spec.id, { entitled }), authority: spec.authority } : openMaker(spec.maker)
      ).catch(error => {
        if (connections.get(key) === entry) connections.delete(key);
        throw error;
      });
    } else {
      // Refresh insertion order so only the least recently used idle index retires.
      connections.delete(key);
    }
    connections.set(key, entry);
    if (!held.has(entry)) {
      held.add(entry);
      entry.users++;
    }
    return entry.ready;
  }
  const [template, payPage, returnPage, screening] = await Promise.all(
    ['player', 'checkout', 'return', 'screening'].map(name => readFile(new URL('../public/' + name + '.html', import.meta.url), 'utf8')));
  const lookup = (id, entitled = false) => catalog?.get(id, { entitled }) || (openMaker && filmSpec(id));
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { type, data: await readFile(new URL(file, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const held = new Set();
    const connection = (spec, entitled = false) => acquire(spec, entitled, held);
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
      if (path === '/faq') {
        if (!read) return fail(405);
        const back = setup ? '<a href="/setup/dashboard">Filmmaker workspace</a>' : '<a href="/screening">Screening room</a>';
        return send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1"><title>FAQ · Stream</title>
          <link rel="stylesheet" href="/site-frame.css"><link rel="stylesheet" href="/filmmaker.css"><link rel="stylesheet" href="/filmmaker-dark.css" media="(prefers-color-scheme: dark)"></head>
          <body><a class="skip" href="#main">Skip to content</a><header class="masthead"><div class="bar"><strong class="brand">Stream</strong>${back}${faqLink(true)}</div></header>
          <main id="main" tabindex="-1" class="filmmaker-help">${renderFilmmakerFaq()}</main>${siteFooter(setup ? '/setup/dashboard' : '/screening')}</body></html>`,
          { 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      }
      if (read && staticFiles.has(path)) {
        const { type, data } = staticFiles.get(path);
        return send(200, type, data);
      }
      if (catalog && read && (path === '/screening' || path === '/')) {
        const embeds = catalog.list().map(({ id, title }) =>
          '<iframe src="/embed/' + encodeURIComponent(id) + '" title="' + escapeHtml(title) +
          '" loading="lazy" allow="autoplay; fullscreen; encrypted-media; payment" allowfullscreen></iframe>').join('\n');
        return send(200, 'text/html; charset=utf-8', screening.replace('{{faqLink}}', faqLink()).replace('{{footer}}', siteFooter('/screening')).replace('{{embeds}}', () => embeds || '<p>No films available.</p>'),
          { 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Robots-Tag': 'noindex' });
      }
      if (checkout && (path === '/checkout/webhook' || path === '/checkout/platform-webhook')) {
        if (req.method !== 'POST') return fail(405);
        const result = await checkout.webhook(await body(req, 256 * 1024), req.headers['stripe-signature'], path === '/checkout/platform-webhook');
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
      const poster = /^\/film\/(f-[a-f0-9-]{36})\/thumbnail\.jpg$/.exec(path);
      if (poster && catalog) {
        if (!read) return fail(405);
        const bytes = await catalog.poster(poster[1]);
        return bytes ? send(200, 'image/jpeg', bytes) : fail(404);
      }
      const embed = /^\/embed\/([a-z0-9-]+)$/.exec(path);
      if (read && (embed || path === '/')) {
        const id = embed?.[1] || 'clock';
        const published = lookup(id);
        const spec = published || lookup(id, true);
        if (!spec) return fail(404);
        const payable = Boolean(checkout && spec.id);
        const fields = selectedFields(new URL(req.url, origin).searchParams.get('show') || '');
        const text = { title: escapeHtml(published?.title || 'Private screening'), poster: published?.thumbnail ? ' poster="/film/' + id + '/thumbnail.jpg"' : '', filmInfo: renderFilmInfo(published?.info, fields) };
        const html = template.replaceAll('{{checkout}}', String(payable))
          .replaceAll('{{manualNm}}', String(payable && checkout.manualNmEnabled === true))
          .replaceAll('{{preview}}', String(published ? spec.previewSeconds ?? 10 : 0))
          .replaceAll('{{emailRecovery}}', String(Boolean(recovery && payable)))
          .replaceAll('{{published}}', String(Boolean(published)))
          .replaceAll('{{rent}}', String(published?.prices?.rent ?? ''))
          .replaceAll('{{rentalHours}}', String(published?.rentalHours ?? 48))
          .replaceAll('{{buy}}', String(published?.prices?.buy ?? ''))
          .replace(/\{\{(title|filmInfo|poster)\}\}/g, (_, key) => text[key]);
        return send(200, 'text/html; charset=utf-8', html, payable ? stripePlayerHeaders : {});
      }
      const route = /^\/film\/([a-z0-9-]+)\/(checkout|buy|abandon|order|session|download|restore|redeem|position|view|preview\.mp4|(?:preview|play)\/subtitles(?:\/([a-zA-Z0-9_-]{1,64})\.vtt)?|play\/(index\.m3u8|key|(?:0|[1-9]\d{0,3})\.ts))$/.exec(path);
      if (!route) return fail(404);
      const [, id, action, trackId, asset] = route;
      const entitled = ['abandon', 'order', 'session', 'download', 'restore', 'redeem', 'position', 'view'].includes(action) || action.startsWith('play/');
      const spec = lookup(id, entitled);
      if (!spec) return fail(404);
      const grant = /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(req.headers.authorization || '')?.[1];
      if (action.startsWith('play/') && !grant) return fail(403);
      if (['restore', 'redeem', 'position', 'view'].includes(action)) {
        if (!checkout || !spec.id) return fail(404);
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'text/plain') return fail(403);
        const value = (await body(req, 512)).toString('utf8');
        if (action === 'restore' || action === 'redeem') {
          if (!recovery) return fail(404);
          if (action === 'restore') {
            recovery.request(spec, value, origin);
            return send(202, 'application/json', '{}');
          }
          const token = recovery.redeem(spec, value);
          return token ? send(200, 'application/json', JSON.stringify({ token })) : fail(403);
        }
        const [first, second, ...extra] = value.split(' ');
        if (extra.length) return fail(400);
        if (action === 'position') {
          if (!/^[\w-]{43}$/.test(first) || !/^\d{1,5}$/.test(second) || Number(second) > 14400) return fail(400);
          if (!await checkout.position({ offer: spec, token: first, seconds: Number(second) })) return fail(403);
        } else {
          if (!['preview','paid'].includes(first) || !/^[a-f0-9-]{36}$/.test(second)) return fail(400);
          if (first === 'preview') {
            const published = lookup(id);
            if (!published || (published.previewSeconds ?? 10) <= 0) return fail(403);
          } else {
            if (!grant) return fail(403);
            try {
              const verified = await spec.authority.verifyGrant(grant, { film: spec.scope, revision: spec.revision });
              if (!await checkout.accessAllowed({ offer: spec, kind: verified.access || 'rent', orderId: verified.orderId, rentalExpiresAt: verified.rentalExpiresAt })) return fail(403);
            } catch { return fail(403); }
          }
          catalog.recordView?.(id, first, second);
        }
        return send(200, 'application/json', '{}');
      }
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
        const authorized = () => checkout.accessAllowed({offer:spec,orderId:purchase.orderId,kind:'buy'});
        if (!authorized()) return fail(403);
        const range = req.headers.range && rangeFor(req.headers.range, file.size);
        if (req.headers.range && !range) return send(416, 'text/plain', '', { 'Content-Range': 'bytes */' + file.size });
        const [from, to] = range || [0, file.size - 1];
        const extension = ['mp4', 'mov', 'mkv'].includes(file.extension) ? file.extension : 'mp4';
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': file.contentType || 'video/mp4',
          'Content-Disposition': attachmentName(file.title, extension), 'Accept-Ranges': 'bytes',
          ...(range && { 'Content-Range': 'bytes ' + from + '-' + to + '/' + file.size }),
          'Content-Length': to - from + 1 });
        if (req.method === 'HEAD') return res.end();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        async function* original() {
          for await (const chunk of file.stream(from,to + 1,controller.signal)) {
            if (!authorized()) throw new Error('Purchase revoked.');
            yield chunk;
          }
        }
        try { await pipeline(original(), res, { signal: controller.signal }); }
        finally { res.off('close', cancel); }
        return;
      }
      if (['checkout', 'buy', 'abandon', 'order', 'session'].includes(action)) {
        if (action !== 'session' && (!checkout || !spec.id)) return fail(404);
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== origin) return fail(403);
        const opening = action === 'buy' || action === 'checkout';
        const type = req.headers['content-type'];
        const withAddress = opening && type === 'application/json';
        if (type !== 'text/plain' && !withAddress) return fail(403);
        const token = (await body(req, withAddress ? 2048 : action === 'session' ? 4096 : 64)).toString('utf8');
        if (action !== 'session') {
          let input;
          if (withAddress) input = viewingOrder(token);
          else {
            const match = /^([A-Za-z0-9_-]{43})(?: (0|[1-9]|1[0-5]))?$/.exec(token);
            if (match && (opening || match[2] === undefined)) input = { token:match[1], tipPercent:Number(match[2] || 0) };
          }
          if (!input) return fail(400);
          const result = opening ? await checkout.start({ ...input, offer: await catalog.verify(id), kind: action === 'buy' ? 'buy' : 'rent', origin }) :
            await checkout[action === 'abandon' ? 'abandon' : 'status']({ offer: spec, token });
          return send(200, 'application/json', JSON.stringify(result), checkoutHeaders);
        }
        // Published orders have a saved revision, so invalid receipts never open R2.
        const runtime = spec.id ? { authority: spec.authority, revision: spec.revision } : await connection(spec);
        try {
          const grant = await runtime.authority.exchange(token, { film: spec.scope, revision: runtime.revision ?? runtime.film.revision });
          if (spec.id && !await checkout.verifyPlayback({ offer: spec, kind: grant.access || 'rent',
            orderId: grant.orderId, rentalExpiresAt: grant.rentalExpiresAt })) return fail(403);
          return send(200, 'application/json', JSON.stringify(grant));
        } catch { return fail(403); }
      }
      if (!read) return fail(405);
      const subtitles = new URL(req.url, origin).searchParams.getAll('subtitle');
      const rendition = subtitles[0];
      if (subtitles.length && (subtitles.length !== 1 || !/^s\d{1,5}$/.test(rendition))) return fail(400);
      const hasRendition = film => !rendition || film.subtitleTracks?.some(track => track.id === rendition && track.format === 'bitmap');
      async function sendSubtitles(film, options, allowed) {
        if (!allowed()) return fail(403);
        const tracks = film.subtitleTracks || [];
        if (!trackId) return send(200, 'application/json', JSON.stringify(tracks.map(({ id, language, label, kind, format, forced }) =>
          ({ id, language, label, kind, format, forced }))));
        if (!tracks.some(track => track.id === trackId && track.format !== 'bitmap')) return fail(404);
        const vtt = await film.subtitles(trackId, options);
        return allowed() ? send(200, 'text/vtt; charset=utf-8', vtt) : fail(403);
      }
      if (action === 'preview.mp4' || action.startsWith('preview/')) {
        const seconds = spec.previewSeconds ?? 10;
        if (!seconds) return fail(403);
        const { film } = await connection(spec);
        const allowed = () => {
          const published = lookup(id);
          return published && (published.previewSeconds ?? 10) === seconds && published.revision === spec.revision;
        };
        if (action !== 'preview.mp4') return await sendSubtitles(film, { end: seconds }, allowed);
        if (!hasRendition(film)) return fail(404);
        const clip = await film.preview(seconds, { subtitleId: rendition });
        return allowed() ? sendMp4(clip) : fail(403);
      }
      const runtime = spec.id ? { authority: spec.authority, revision: spec.revision } : await connection(spec);
      const { authority } = runtime;
      const scope = { film: spec.scope, revision: runtime.revision ?? runtime.film.revision };
      let key, access;
      const authorized = () => !spec.id || (access?.expiresAt > Date.now()/1000 && checkout.accessAllowed({
        offer:spec,kind:access.access || 'rent',orderId:access.orderId,rentalExpiresAt:access.rentalExpiresAt}));
      try {
        if (spec.id || asset === 'index.m3u8' || !asset) access = await authority.verifyGrant(grant, scope);
        if (!authorized()) return fail(403);
        if (asset && asset !== 'index.m3u8') key = await authority.keyForGrant(grant, scope);
      } catch { return fail(403); }
      if (asset === 'key') return send(200, 'application/octet-stream', key);
      const film = runtime.film || (await connection(spec, true)).film;
      if (!authorized()) return fail(403);
      if (!asset) return await sendSubtitles(film, {}, () => {
        const live = lookup(id, true);
        return authorized() && access.expiresAt > Date.now() / 1000 && live?.scope === spec.scope && live.revision === spec.revision;
      });
      if (!hasRendition(film)) return fail(404);
      if (asset === 'index.m3u8') return send(200, 'application/vnd.apple.mpegurl', playlist(film.segments, rendition));
      const index = Number(asset.slice(0, -3));
      if (index >= film.segments.length) return fail(404);
      const segment = await film.segment(index, { subtitleId: rendition });
      if (!authorized()) return fail(403);
      return send(200, 'video/mp2t', encrypt(segment, key, index));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) fail([400, 403, 404, 409, 410, 413, 429].includes(error.statusCode) ? error.statusCode : 503);
    } finally {
      for (const entry of held) {
        entry.users--;
        if (stopping && !entry.users) retire(entry);
      }
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.maxConnections = 64;
  server.on('close', () => {
    stopping = true;
    for (const entry of connections.values()) if (!entry.users) retire(entry);
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
    console.log('Setup: ' + (process.env.STREAM_PUBLIC_ORIGIN || 'http://127.0.0.1:' + server.address().port) + '/setup'));
}
