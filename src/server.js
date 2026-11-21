import { workspacePage } from './setup-view.js';
import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createRentalAuthority } from './rental.js';
import { airplayLeases, captionCues, captionMaster, captionSegment, screenerReference } from './airplay.js';
import { openFilm } from './media.js';
import { faqLink, siteFooter } from './site-frame.js';
import { renderFilmmakerFaq } from './filmmaker-help.js';
import { createSetup } from './setup.js';
import { escapeHtml, filmByline, posterStyles, renderFilmInfo, selectedFields } from './film-embed.js';
import { formatDuration } from './offer-fields.js';
import { programPresentation, streamProgramArchive } from './program-delivery.js';
import { playbackSettings } from './operator.js';
import { filmSpec, sourceFromEnv } from './config.js';
const assets = new Map([
  ['/app.js', ['../public/app.js', 'text/javascript']],
  ['/watch-time.js', ['../public/watch-time.js', 'text/javascript']],
  ['/airplay.js', ['../public/airplay.js', 'text/javascript']],
  ['/film-embed.js', ['./film-embed.js', 'text/javascript']],
  ['/program-lineup.css', ['../public/program-lineup.css', 'text/css']],
  ['/program-player.js', ['../public/program-player.js', 'text/javascript']],
  ['/video-controls.js', ['../public/video-controls.js', 'text/javascript']],
  ['/select-focus.js', ['../public/select-focus.js', 'text/javascript']],
  ['/subtitles.js', ['../public/subtitles.js', 'text/javascript']],
  ['/checkout.js', ['../public/checkout.js', 'text/javascript']],
  ['/payment.js', ['../public/payment.js', 'text/javascript']],
  ['/platform-tip.js', [import.meta.resolve('@dustwave/worker-core/platform-tip'), 'text/javascript']],
  ['/appearance.js', [import.meta.resolve('@dustwave/admin-shell/appearance-browser'), 'text/javascript']],
  ['/filmmaker.css', ['../public/setup.css', 'text/css']],
  ['/filmmaker-dark.css', ['../public/setup-dark.css', 'text/css']],
  ['/dust-wave-square.webp', ['../public/dust-wave-square.webp', 'image/webp']],
  ['/site-frame.css', ['../public/site-frame.css', 'text/css']],
  ['/screening.css', ['../public/screening.css', 'text/css']],
  ['/poster.css', ['../public/poster.css', 'text/css']],
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

function playlist(segments, subtitleId, captions = false) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...segments.map(s => s.duration))),
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (!captions) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="key"');
  segments.forEach(({ duration }, index) => {
    if (index) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:' + duration.toFixed(6) + ',', index + (captions ? '.vtt' : '.ts') + (subtitleId ? '?subtitle=' + subtitleId : ''));
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
  if (!request || Object.keys(request).some(key => !['token','tipPercent','viewingAddress','programRevision'].includes(key)) ||
      typeof request.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.token) ||
      !Number.isInteger(request.tipPercent) || request.tipPercent < 0 || request.tipPercent > 15) return null;
  const { programRevision, viewingAddress:address } = request;
  if (programRevision !== undefined && (typeof programRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(programRevision))) return null;
  if (address !== undefined) {
    if (address?.country !== 'US' || address.state !== 'NM' ||
        Object.keys(address).some(key => !['country','state','city','line1','postalCode'].includes(key)) ||
        typeof address.postalCode !== 'string' || !/^\d{5}(-\d{4})?$/.test(address.postalCode)) return null;
    for (const [field, limit] of [['line1',200],['city',100]]) {
      if (typeof address[field] !== 'string' || !address[field].trim() || address[field].length > limit || /\p{Cc}/u.test(address[field])) return null;
    }
  }
  return { token:request.token, tipPercent:request.tipPercent, viewingAddress:address, programRevision };
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

export async function makeServer(openMaker, { setup, publicOrigin, catalog, checkout, recovery, workspaceOrigin = process.env.STREAM_WORKSPACE_ORIGIN, maxIndexes = 32 } = {}) {
  if (!Number.isSafeInteger(maxIndexes) || maxIndexes < 1) throw new Error('A positive media index limit is required.');
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin) throw new Error('Set STREAM_PUBLIC_ORIGIN to an HTTPS origin.');
  }
  if (workspaceOrigin) {
    const workspace = new URL(workspaceOrigin);
    const local = workspace.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(workspace.hostname);
    if (workspace.origin !== workspaceOrigin || !(workspace.protocol === 'https:' || local)) throw new Error('Use a workspace HTTPS or loopback origin.');
  }
  const connections = new Map();
  const receivers = airplayLeases();
  const receiverCues = new WeakMap();
  let stopping = false;
  function retire(entry) {
    if (connections.get(entry.key) !== entry) return;
    connections.delete(entry.key);
    entry.ready.then(({ film }) => film.close(), () => {});
  }
  function acquire(spec, entitled, held, memberId) {
    if (stopping) throw new Error('Film service is closing.');
    const key = spec.id ? [spec.id, spec.revision, entitled, memberId].join(':') : spec.maker;
    let entry = connections.get(key);
    if (!entry) {
      if (connections.size >= maxIndexes) {
        const idle = [...connections.values()].find(item => item.users === 0);
        if (!idle) throw new Error('Film indexes are busy.');
        retire(idle);
      }
      entry = { key, users: 0 };
      entry.ready = Promise.resolve().then(async () => spec.id ?
        { film: await catalog.open(spec.id, { entitled, ...(spec.type === 'program' && {revision: spec.revision, memberId}) }), authority: spec.authority } : openMaker(spec.maker)
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
  const lookup = (id, entitled = false, revision) => catalog?.get(id, { entitled, ...(revision && {revision}) }) || (openMaker && filmSpec(id));
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { type, data: await readFile(new URL(file, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const held = new Set();
    const connection = (spec, entitled = false, memberId) => acquire(spec, entitled, held, memberId);
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
      if (setup && read && (path === '/' || path === '/faq')) {
        return send(303, 'text/plain', '', { Location: path === '/' ? '/setup/home' : '/setup/faq' });
      }
      if (path === '/faq') {
        if (!read) return fail(405);
        if (workspaceOrigin && (!publicOrigin || workspaceOrigin.startsWith('https://'))) {
          return send(303, 'text/plain', '', { Location: new URL('/faq', workspaceOrigin).href });
        }
        return send(200, 'text/html; charset=utf-8', workspacePage('FAQ', null, renderFilmmakerFaq(), { faq: true, signInHref: '#getting-started' }),
          { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      }
      if (read && staticFiles.has(path)) {
        const { type, data } = staticFiles.get(path);
        return send(200, type, data);
      }
      if (catalog && read && (path === '/screening' || path === '/')) {
        const embeds = catalog.list().map(({ id, title }) =>
          '<iframe src="/embed/' + encodeURIComponent(id) + '" title="' + escapeHtml(title) +
          '" loading="lazy" allow="autoplay; fullscreen; encrypted-media; payment; picture-in-picture" allowfullscreen></iframe>').join('\n');
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
      const poster = /^\/film\/([fp]-[a-f0-9-]{36})(?:\/v\/([\w-]{43})\/title\/(f-[a-f0-9-]{36}))?\/thumbnail\.jpg$/.exec(path);
      if (poster && catalog) {
        if (!read) return fail(405);
        if (poster[3]) {
          const current = lookup(poster[1]);
          if (current?.type !== 'program' || current.revision !== poster[2] || !current.lineup.some(item => item.id === poster[3])) return fail(404);
        }
        const bytes = await catalog.poster(poster[1], {revision:poster[2], memberId:poster[3]});
        return bytes ? send(200, 'image/jpeg', bytes) : fail(404);
      }
      const embed = /^\/embed\/([a-z0-9-]+)$/.exec(path);
      if (read && (embed || path === '/')) {
        const id = embed?.[1] || 'clock';
        const published = lookup(id);
        const spec = published || lookup(id, true);
        if (!spec) return fail(404);
        const payable = Boolean(checkout && spec.id);
        const params = new URL(req.url, origin).searchParams;
        const show = params.get('show'), style = params.get('poster');
        const themed = posterStyles.has(style);
        const fields = selectedFields(show || '');
        const title = escapeHtml(published?.title || 'Private screening');
        const heading = `<h1 id="film-title">${title}</h1>`;
        const summary = '<p id="program-summary" hidden></p>';
        const info = renderFilmInfo(published?.info, fields);
        const text = {
          title, poster: published?.thumbnail ? ' poster="/film/' + id + '/thumbnail.jpg"' : '',
          posterAttribute: '', posterStyles: '', masthead: '', detailsTitle: heading + summary, filmInfo: info, posterInfo: ''
        };
        if (themed) {
          const program = spec.type === 'program';
          const byline = program ? '' : filmByline(published?.info, fields);
          const runtime = program ? summary : `<span>${escapeHtml(formatDuration(published?.duration))}</span>`;
          text.posterAttribute = ` data-poster="${style}"`;
          text.posterStyles = '<link rel="stylesheet" href="/poster.css">';
          text.masthead = `<header class="poster-head"><div class="poster-imprint"><span id="poster-byline"${byline ? '' : ' hidden'}>${escapeHtml(byline)}</span>${runtime}</div>${style === 'broadside' ? heading : ''}</header>`;
          text.detailsTitle = style === 'marquee' ? heading : '';
          text.posterInfo = info;
          text.filmInfo = '';
        }
        text.programStyles = spec.type === 'program' ? '<link rel="stylesheet" href="/program-lineup.css">' : '';
        text.program = spec.type === 'program' ? escapeHtml(JSON.stringify(published ?
          programPresentation(published, show === null ? undefined : fields) : {title:'Private screening',lineup:[]})) : '';
        const html = template.replaceAll('{{checkout}}', String(payable))
          .replaceAll('{{manualNm}}', String(payable && checkout.manualNmEnabled === true))
          .replaceAll('{{preview}}', String(published ? spec.previewSeconds ?? 10 : 0))
          .replaceAll('{{emailRecovery}}', String(Boolean(recovery && payable)))
          .replaceAll('{{published}}', String(Boolean(published)))
          .replaceAll('{{rent}}', String(published?.prices?.rent ?? ''))
          .replaceAll('{{rentalHours}}', String(published?.rentalHours ?? 48))
          .replaceAll('{{buy}}', String(published?.prices?.buy ?? ''))
          .replace(/\{\{(title|filmInfo|poster|program|programStyles|posterStyles|masthead|detailsTitle|posterInfo|posterAttribute)\}\}/g, (_, key) => text[key]);
        return send(200, 'text/html; charset=utf-8', html, payable ? stripePlayerHeaders : {});
      }
      const versioned = /^\/film\/(p-[a-f0-9-]{36})\/v\/([\w-]{43})(?:\/title\/(f-[a-f0-9-]{36}))?\/(.+)$/.exec(path);
      const mediaPath = versioned ? '/film/' + versioned[1] + '/' + versioned[4] : path;
      const receiver = /^\/film\/([a-z0-9-]+)\/airplay\/([A-Za-z0-9_-]{43})\/(index\.m3u8|video\.m3u8|captions\.(?:m3u8|vtt)|key|(?:0|[1-9]\d{0,3})\.(?:ts|vtt))$/.exec(mediaPath);
      const route = receiver ? [path, receiver[1], 'play/' + receiver[3], undefined, receiver[3]] : /^\/film\/([a-z0-9-]+)\/(checkout|buy|abandon|order|session|airplay|download|restore|redeem|position|view|preview\.mp4|(?:preview|play)\/subtitles(?:\/([a-zA-Z0-9_-]{1,64})\.vtt)?|play\/(index\.m3u8|key|(?:0|[1-9]\d{0,3})\.ts))$/.exec(mediaPath);
      if (!route) return fail(404);
      const [, id, action, trackId, asset] = route;
      const entitled = ['abandon', 'order', 'session', 'airplay', 'download', 'restore', 'redeem', 'position', 'view'].includes(action) || action.startsWith('play/');
      const revision = versioned?.[2], memberId = versioned?.[3];
      const spec = lookup(id, entitled, revision);
      if (!spec) return fail(404);
      if ((action === 'airplay' || receiver) && (!checkout || !spec.id)) return fail(404);
      if (spec.type === 'program') {
        const memberAction = action.startsWith('play/') || action === 'position' || action === 'airplay';
        if ((revision && revision !== spec.revision) ||
            (memberAction && !memberId) ||
            (memberId && (!spec.lineup.some(member => member.id === memberId) || !(memberAction || ['view','download'].includes(action)))) ||
            (revision && !(memberAction || ['session','view','download'].includes(action))) ||
            (!revision && ['session','download'].includes(action))) return fail(404);
      } else if (versioned) return fail(404);
      const grant = /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(req.headers.authorization || '')?.[1];
      if (action.startsWith('play/') && !grant && !receiver) return fail(403);
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
        const [first, second, duration, ...extra] = value.split(' ');
        if (extra.length) return fail(400);
        if (action === 'position') {
          if (duration !== undefined) return fail(400);
          if (!/^[\w-]{43}$/.test(first) || !/^\d{1,5}$/.test(second) || Number(second) > 14400) return fail(400);
          if (!await checkout.position({ offer: spec, token: first, seconds: Number(second), memberId })) return fail(403);
        } else {
          if (!['preview','paid'].includes(first) || !/^[a-f0-9-]{36}$/.test(second)) return fail(400);
          if (duration !== undefined && (first !== 'paid' || !/^(0|[1-9]\d{0,4})$/.test(duration) || Number(duration) > 86400)) return fail(400);
          if (spec.type === 'program' && (first === 'paid') !== Boolean(memberId)) return fail(403);
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
          catalog.recordView?.(id, first, second, {revision:spec.revision, memberId:memberId || spec.previewId, seconds:duration === undefined ? undefined : Number(duration)});
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
        const authorized = () => checkout.accessAllowed({offer:spec,orderId:purchase.orderId,kind:'buy'});
        if (!authorized()) return fail(403);
        if (spec.type === 'program' && !memberId) {
          const files = [];
          for (const member of spec.lineup) files.push(await catalog.programFile(id, revision, member.id));
          if (!authorized()) return fail(403);
          res.writeHead(200, { ...headers, 'Content-Type':'application/zip', 'Content-Disposition':attachmentName(spec.title,'zip') });
          if (req.method === 'HEAD') return res.end();
          const controller = new AbortController();
          const cancel = () => controller.abort();
          res.once('close',cancel);
          try { await pipeline(streamProgramArchive(files,controller.signal,authorized),res,{signal:controller.signal}); }
          finally { res.off('close',cancel); }
          return;
        }
        const file = memberId ? await catalog.programFile(id, revision, memberId) : await catalog.download(id, downloadGrant);
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
      if (['checkout', 'buy', 'abandon', 'order', 'session', 'airplay'].includes(action)) {
        if (action !== 'session' && (!checkout || !spec.id)) return fail(404);
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== origin) return fail(403);
        const opening = action === 'buy' || action === 'checkout';
        const type = req.headers['content-type'];
        const jsonOrder = opening && type === 'application/json';
        if (type !== 'text/plain' && !jsonOrder) return fail(403);
        const token = (await body(req, jsonOrder ? 2048 : ['session', 'airplay'].includes(action) ? 4096 : 64)).toString('utf8');
        if (action !== 'session' && action !== 'airplay') {
          let input;
          if (jsonOrder) input = viewingOrder(token);
          else {
            const match = /^([A-Za-z0-9_-]{43})(?: (0|[1-9]|1[0-5]))?$/.exec(token);
            if (match && (opening || match[2] === undefined)) input = { token:match[1], tipPercent:Number(match[2] || 0) };
          }
          if (!input) return fail(400);
          let result;
          if (opening) {
            const changed = () => send(409, 'application/json', JSON.stringify({code:'program_revision_changed'}), checkoutHeaders);
            if (spec.type === 'program' && input.programRevision !== spec.revision) return changed();
            const offer = await catalog.verify(id);
            if (offer.type === 'program' && offer.revision !== input.programRevision) return changed();
            try {
              result = await checkout.start({...input, offer, kind:action === 'buy' ? 'buy' : 'rent', origin});
            } catch (err) {
              if (offer.type === 'program' && err.code === 'viewer_offer_changed') return changed();
              throw err;
            }
          } else {
            result = await checkout[action === 'abandon' ? 'abandon' : 'status']({offer:spec, token, resolveEdition:rev => lookup(id,true,rev)});
          }
          return send(200, 'application/json', JSON.stringify(result), checkoutHeaders);
        }
        // Published orders have a saved revision, so invalid receipts never open R2.
        const runtime = spec.id ? { authority: spec.authority, revision: spec.revision } : await connection(spec);
        try {
          const grant = await runtime.authority.exchange(token, { film: spec.scope, revision: runtime.revision ?? runtime.film.revision });
          if (action === 'airplay' && (grant.access !== 'rent' || !grant.orderId)) return fail(403);
          if (spec.id && !await checkout.verifyPlayback({ offer: spec, kind: grant.access || 'rent',
            orderId: grant.orderId, rentalExpiresAt: grant.rentalExpiresAt })) return fail(403);
          if (action === 'airplay') {
            const lease = receivers.issue(spec, grant, memberId);
            if (!lease) return fail(403);
            return send(200, 'application/json', JSON.stringify({ path: path + '/' + lease.token + '/index.m3u8', expiresAt: lease.rentalExpiresAt }));
          }
          return send(200, 'application/json', JSON.stringify(grant));
        } catch (error) { return fail(error.statusCode === 429 ? 429 : 403); }
      }
      // The Google Cast default receiver fetches adaptive media from a web origin.
      // Only its credential-free reads of an authorized receiver URL need CORS.
      const castRead = receiver && req.headers.origin === 'https://www.gstatic.com';
      const preflight = castRead && req.method === 'OPTIONS' &&
        ['GET','HEAD'].includes(req.headers['access-control-request-method']);
      if (!read && !preflight) return fail(405);
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
      const order = () => ({ offer: spec, kind: access.access || 'rent', orderId: access.orderId, rentalExpiresAt: access.rentalExpiresAt });
      const authorized = () => !spec.id || ((receiver ? receivers.active(access) : access.expiresAt > Date.now()/1000) && checkout.accessAllowed(order()));
      try {
        if (receiver) {
          access = receivers.read(receiver[2], spec, memberId);
          if (!access || !authorized() || !await checkout.verifyPlayback(order()) || !authorized()) return fail(403);
          if (castRead) {
            res.setHeader('Access-Control-Allow-Origin', 'https://www.gstatic.com');
            res.setHeader('Vary', 'Origin');
            if (preflight) return send(204, 'text/plain', '', {
              'Access-Control-Allow-Methods':'GET, HEAD',
              'Access-Control-Allow-Headers':'Content-Type, Accept-Encoding, Range'
            });
          }
          receivers.touch(access);
          key = access.key;
        } else {
          if (spec.id || asset === 'index.m3u8' || !asset) access = await authority.verifyGrant(grant, scope);
          if (!authorized()) return fail(403);
          if (asset && asset !== 'index.m3u8') key = await authority.keyForGrant(grant, scope, memberId);
        }
      } catch { return fail(403); }
      if (asset === 'key') return send(200, 'application/octet-stream', key);
      const film = runtime.film || (await connection(spec, true, memberId)).film;
      if (!authorized()) return fail(403);
      if (!asset) return await sendSubtitles(film, {}, () => {
        const live = lookup(id, true, revision);
        return authorized() && access.expiresAt > Date.now() / 1000 && live?.scope === spec.scope && live.revision === spec.revision;
      });
      const hlsType = 'application/vnd.apple.mpegurl';
      const receiverText = receiver && rendition && film.subtitleTracks?.find(track => track.id === rendition && track.format === 'text');
      if (receiverText) {
        if (asset === 'captions.vtt') {
          const track = await film.subtitles(rendition);
          return authorized() ? send(200, 'text/vtt; charset=utf-8', track) : fail(403);
        }
        if (asset === 'index.m3u8') return send(200, hlsType, captionMaster(receiverText));
        if (asset === 'captions.m3u8') return send(200, hlsType, playlist(film.segments, rendition, true));
        if (!asset.endsWith('.vtt')) return fail(404);
        const interval = film.segments[Number.parseInt(asset, 10)];
        if (!interval) return fail(404);
        let tracks = receiverCues.get(film);
        if (!tracks) { tracks = new Map(); receiverCues.set(film, tracks); }
        let cues = tracks.get(rendition);
        if (!cues) {
          cues = captionCues(await film.subtitles(rendition));
          if (tracks.size >= 2) tracks.delete(tracks.keys().next().value);
          tracks.set(rendition, cues);
        }
        return authorized() ? send(200, 'text/vtt; charset=utf-8', captionSegment(cues, interval)) : fail(403);
      }
      if (!hasRendition(film)) return fail(404);
      if (asset === 'index.m3u8' || asset === 'video.m3u8') return send(200, hlsType, playlist(film.segments, rendition));
      if (!asset.endsWith('.ts')) return fail(404);
      const index = Number.parseInt(asset, 10);
      if (index >= film.segments.length) return fail(404);
      const segment = await film.segment(index, { subtitleId: rendition, watermark: screenerReference(spec, access) });
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
