import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { objectWriter } from './r2-write.js';
import { r2Request } from './source.js';
import { cropRect, thumbnailKey } from './thumbnail-frame.js';

const maxBytes = 8 * 1024 * 1024;
export class ThumbnailError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
function frameValues(input) {
  if (!input || typeof input !== 'object') throw new ThumbnailError('Check the thumbnail framing.');
  const values = {};
  for (const [name, min, max] of [['x', 0, 100], ['y', 0, 100], ['zoom', 100, 200]]) {
    const n = input[name];
    if (!Number.isInteger(n) || n < min || n > max) throw new ThumbnailError('Check the thumbnail framing.');
    values[name] = n;
  }
  return values;
}
async function bytes(response, limit = maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new ThumbnailError('Choose an image under 8 MB.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function normalize(input) {
  try {
    const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
    const png = input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
    if (!(jpeg || png || webp)) throw new Error();
    const image = sharp(input, { limitInputPixels: 48_000_000, failOn: 'warning' });
    const { format } = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(format)) throw new Error();
    return await image.rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#181818' }).jpeg({ quality: 85 }).toBuffer();
  } catch { throw new ThumbnailError('Choose a readable JPEG, PNG or WebP up to 48 megapixels.'); }
}
export function createThumbnails(store, fetcher = fetch) {
  function request(owner, film, writer) {
    const key = thumbnailKey(film.id);
    if (key === film.objectKey) throw new ThumbnailError('This thumbnail path is already the film original.', 409);
    const access = writer || store.credentials(owner, film.bucket);
    return r2Request({ ...film.bucket, ...access }, '/' + key, fetcher);
  }
  async function read(owner, film, method = 'GET') {
    const response = await request(owner, film)(method);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      if (response.status === 403) throw new ThumbnailError('Check the bucket permissions in Storage setup.', 403);
      throw new ThumbnailError('Cloudflare could not read the thumbnail. Try again.', 503);
    }
    const h = response.headers;
    try {
      if (h.get('x-amz-meta-film') !== film.id || h.get('content-type') !== 'image/jpeg' ||
          !(Number(h.get('content-length')) > 0 && Number(h.get('content-length')) <= maxBytes)) {
        throw new ThumbnailError('The reserved thumbnail path already contains a different file.', 409);
      }
      const frame = frameValues(JSON.parse(h.get('x-amz-meta-frame')));
      const version = h.get('x-amz-meta-version');
      if (!/^[a-f0-9-]{36}$/.test(version) || !h.get('etag')) throw new ThumbnailError('The saved thumbnail metadata is unavailable.');
      return { frame, version, etag: h.get('etag'), data: method === 'GET' ? await bytes(response) : undefined };
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  }
  async function change(owner, film, { version, remove, frame, input }) {
    const access = store.uploadCredentials(owner, film.bucket);
    if (!access) throw new ThumbnailError('Enable uploads in Storage setup for this bucket.', 403);
    const writer = objectWriter(access, thumbnailKey(film.id), ['PutObject', 'DeleteObject']);
    if (!remove) frame = frameValues(frame);
    // Finish decoding the upload before taking a short cross-process lock on remote edits.
    const image = input?.length ? await normalize(input) : undefined;
    const lock = store.beginThumbnailEdit(owner, film.id);
    if (!lock) throw new ThumbnailError('Another thumbnail edit is being saved. Try again.', 409);
    let observed;
    try {
      const previous = await read(owner, film, !remove && !image ? 'GET' : 'HEAD');
      observed = previous?.version || '';
      if (version !== observed) throw new ThumbnailError('The thumbnail changed. Reload the editor before saving.', 409);
      if (!previous && !image && !remove) throw new ThumbnailError('Choose a thumbnail image first.');
      if (!previous && remove) return '';
      const next = remove ? '' : randomUUID();
      const headers = remove ? {} : { 'Content-Type': 'image/jpeg', 'x-amz-meta-film': film.id,
        'x-amz-meta-frame': JSON.stringify(frame), 'x-amz-meta-version': next,
        ...(previous ? { 'If-Match': previous.etag } : { 'If-None-Match': '*' }) };
      // If the network response is lost, readers resolve the object's actual state in R2.
      observed = undefined;
      store.markThumbnailPending(owner, film.id);
      const response = await request(owner, film, writer)(remove ? 'DELETE' : 'PUT', headers, undefined, remove ? undefined : image || previous.data);
      await response.body?.cancel();
      if (response.status === 403) observed = previous?.version || '';
      if (!response.ok) throw new ThumbnailError(response.status === 403 ? 'Cloudflare declined the thumbnail update. Reconnect this bucket in Storage setup.' :
        'Cloudflare could not save the change. Reload the thumbnail and try again.', response.status === 403 ? 403 : 409);
      observed = next;
      return next;
    } finally { store.finishThumbnailEdit(owner, film.id, lock, observed); }
  }
  // Keep only small rendered posters. Publication is checked by the caller even on a cache hit.
  const cache = new Map();
  async function poster(owner, film) {
    if (!film.thumbnail) return;
    const key = film.id + '/' + film.thumbnail;
    const cached = cache.get(key);
    if (cached?.until > Date.now()) return cached.data;
    const saved = await read(owner, film);
    if (!saved) return;
    const image = sharp(saved.data, { limitInputPixels: 1920 ** 2 });
    const { width, height } = await image.metadata();
    const data = await image.extract(cropRect(width, height, saved.frame))
      .resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    if (film.thumbnail === saved.version && data.length <= 512 * 1024) {
      if (cache.size >= 24) cache.delete(cache.keys().next().value);
      cache.set(key, { data, until: Date.now() + 300000 });
    }
    return data;
  }
  return { read, change, poster };
}
export { maxBytes as maxThumbnailBytes };
