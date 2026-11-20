import { createHash, randomUUID } from 'node:crypto';
import { readBoundedText } from '@dustwave/worker-core/response-body';
import { MAX_FILE_BYTES, r2Request, videoContentType } from './source.js';
import { objectWriter } from './r2-write.js';

export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const retry = 'Cloudflare could not confirm this upload step. Retry the same step.';
const conflict = 'This upload is no longer available. Reload the film draft.';

export class FilmUploadError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function view(state) {
  return { uploadId: state.id, partSize: UPLOAD_PART_BYTES, nextPart: state.parts.length + 1,
    complete: state.complete, ...(state.complete ? { objectKey: state.objectKey } : {}) };
}

function providerError(status) {
  if (status === 403) return new FilmUploadError('Cloudflare declined access. Check upload access for this bucket.', 403);
  if (status === 404) return new FilmUploadError('This multipart upload is no longer in Cloudflare. Cancel it and start again.', 409);
  if (status === 412) return new FilmUploadError('A file already exists at the upload destination. Cancel and start a new upload.', 409);
  return new FilmUploadError(retry, 503);
}

async function xmlResult(response, resultTag) {
  let xml;
  try { xml = (await readBoundedText(response, 16 * 1024)).trim(); } catch { throw providerError(); }
  // S3 can return HTTP 200 with an Error document during completion.
  const match = new RegExp('^(?:<\\?xml[^?]*\\?>\\s*)?<' + resultTag + '(?:\\s[^>]*)?>([\\s\\S]*)</' + resultTag + '>$').exec(xml);
  if (!match) throw providerError();
  return match[1];
}

function sameBucket(a, b) {
  return a?.accountId === b?.accountId && a?.bucket === b?.bucket && (a?.jurisdiction ?? 'default') === (b?.jurisdiction ?? 'default');
}

export function createFilmUploads(store, { fetchImpl = fetch } = {}) {
  function context(owner, draftId) {
    const maker = store.maker(owner);
    if (!maker || typeof draftId !== 'string' || maker.draft.id !== draftId || store.film(owner, draftId)) throw new FilmUploadError(conflict, 409);
    const rights = maker.draft.rights;
    if (!rights?.version || !rights.statement || !(Date.parse(rights.acceptedAt) <= Date.now())) {
      throw new FilmUploadError('Confirm your rights to distribute this film first.', 403);
    }
    return { current: maker.r2, state: store.upload(owner, draftId) };
  }

  function active(owner, draftId, id) {
    const { current, state } = context(owner, draftId);
    if (!state || state.id !== id || !sameBucket(current, state.bucket)) throw new FilmUploadError(conflict, 409);
    return state;
  }

  function save(owner, draftId, state) {
    if (store.saveUpload(owner, draftId, state) === false) throw new FilmUploadError(conflict, 409);
  }

  async function request(owner, state, action, method, query = '', headers = {}, body) {
    try {
      const read = action === 'HeadObject';
      const settings = read ? store.credentials(owner, state.bucket) : store.uploadCredentials(owner, state.bucket);
      if (!settings) throw new FilmUploadError('Enable upload access for this bucket first.', 403);
      const access = read ? settings : await objectWriter(settings, state.objectKey, [action]);
      return await r2Request(access, '/' + state.objectKey + query, fetchImpl)(method, headers, AbortSignal.timeout(60000), body);
    } catch (error) {
      if (error instanceof FilmUploadError) throw error;
      throw providerError();
    }
  }

  async function start(owner, draftId, { size, fileId, extension = 'mp4' }) {
    const { current, state: existing } = context(owner, draftId);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new FilmUploadError('Choose a video up to 10 GB.', 413);
    if (!['mp4', 'mov', 'mkv'].includes(extension)) throw new FilmUploadError('Choose an MP4, MOV or MKV file.');
    if (typeof fileId !== 'string' || !uuid.test(fileId)) throw new FilmUploadError('Select the film again before starting the upload.');
    if (!current || !store.uploadCredentials(owner, current)) throw new FilmUploadError('Enable upload access for this bucket first.', 403);
    let state = existing;
    if (!state || (state.complete && state.fileId !== fileId)) {
      const { accountId, bucket, jurisdiction = 'default' } = current;
      state = { id: randomUUID(), fileId, size, bucket: { accountId, bucket, jurisdiction },
        objectKey: 'stream-films/' + randomUUID() + '.' + extension, extension, writeId: randomUUID(), parts: [], complete: false };
      save(owner, draftId, state);
    }
    if (!sameBucket(state.bucket, current) || state.fileId !== fileId || state.size !== size || (state.extension ?? 'mp4') !== extension) {
      throw new FilmUploadError('Cancel the current upload before choosing a different film.', 409);
    }
    if (state.remoteId || state.complete) return view(state);
    // R2 initiation has no idempotency key. A lost response can leave an empty handle until its
    // lifecycle expiry. Parts are only accepted for the handle durably recorded below.
    const response = await request(owner, state, 'CreateMultipartUpload', 'POST', '?uploads', {
      'Content-Type': videoContentType(extension),
      'If-None-Match': '*', 'x-amz-meta-write-id': state.writeId
    });
    if (!response.ok) { await response.body?.cancel(); throw providerError(response.status); }
    const xml = await xmlResult(response, 'InitiateMultipartUploadResult');
    // R2 supplies an opaque URL-safe identifier. Only the server retains this provider handle.
    const id = /<UploadId>([^<\s]{1,2048})<\/UploadId>/.exec(xml)?.[1];
    if (!id || /&(?!amp;)/.test(id)) throw providerError();
    state.remoteId = id.replaceAll('&amp;', '&');
    save(owner, draftId, state);
    return view(state);
  }

  async function part(owner, draftId, id, number, bytes) {
    const state = active(owner, draftId, id);
    if (!state.remoteId || !Number.isSafeInteger(number) || number < 1 ||
        number > Math.ceil(state.size / UPLOAD_PART_BYTES) || number > state.parts.length + 1) throw new FilmUploadError('Send the next film part in order.', 409);
    const required = Math.min(UPLOAD_PART_BYTES, state.size - (number - 1) * UPLOAD_PART_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== required) throw new FilmUploadError('The film part has the wrong length.', 400);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const saved = state.parts[number - 1];
    if ((saved && saved.hash !== hash) || (!saved && state.pending && state.pending !== hash)) {
      throw new FilmUploadError('This part differs from the selected film. Cancel and start again.', 409);
    }
    if (saved) return view(state);
    if (state.complete || state.completing) throw new FilmUploadError(conflict, 409);
    if (!state.pending) {
      state.pending = hash;
      save(owner, draftId, state);
    }
    const query = '?partNumber=' + number + '&uploadId=' + encodeURIComponent(state.remoteId);
    const response = await request(owner, state, 'UploadPart', 'PUT', query, { 'x-amz-content-sha256': hash }, bytes);
    await response.body?.cancel();
    if (!response.ok) throw providerError(response.status);
    const etag = response.headers.get('etag');
    if (!/^"[a-fA-F0-9]{32}"$/.test(etag || '')) throw providerError();
    state.parts.push({ etag, hash });
    delete state.pending;
    save(owner, draftId, state);
    return view(state);
  }

  async function committed(owner, state) {
    const head = await request(owner, state, 'HeadObject', 'HEAD');
    await head.body?.cancel();
    if (head.status === 404) return false;
    if (!head.ok) throw providerError(head.status);
    return head.headers.get('x-amz-meta-write-id') === state.writeId && Number(head.headers.get('content-length')) === state.size;
  }

  function finish(owner, draftId, state) {
    if (store.finishUpload(owner, draftId, state.objectKey) === false) throw new FilmUploadError(conflict, 409);
    return view({ ...state, complete: true });
  }

  async function complete(owner, draftId, id) {
    const state = active(owner, draftId, id);
    if (state.complete) return view(state);
    if (!state.remoteId || state.parts.length !== Math.ceil(state.size / UPLOAD_PART_BYTES)) throw new FilmUploadError('Send every part before completing this upload.', 409);
    if (!state.completing) {
      state.completing = true;
      save(owner, draftId, state);
    }
    const parts = state.parts.map(({ etag }, i) => '<Part><PartNumber>' + (i + 1) + '</PartNumber><ETag>' + etag + '</ETag></Part>').join('');
    const response = await request(owner, state, 'CompleteMultipartUpload', 'POST', '?uploadId=' + encodeURIComponent(state.remoteId),
      { 'Content-Type': 'application/xml', 'If-None-Match': '*' }, '<CompleteMultipartUpload>' + parts + '</CompleteMultipartUpload>');
    if (!response.ok) {
      await response.body?.cancel();
      // Replaying completion can return NoSuchUpload after a lost success response. Only our marked object counts.
      if ([404, 409, 412].includes(response.status) && await committed(owner, state)) return finish(owner, draftId, state);
      throw providerError(response.status);
    }
    const result = await xmlResult(response, 'CompleteMultipartUploadResult');
    if (!/<ETag>[^<]+<\/ETag>/.test(result)) throw providerError();
    return finish(owner, draftId, state);
  }

  async function cancel(owner, draftId, id) {
    const { state } = context(owner, draftId);
    if (!state) return { cancelled: true };
    if (state.id !== id) throw new FilmUploadError(conflict, 409);
    if (state.complete) throw new FilmUploadError('This film has already finished uploading.', 409);
    if (state.remoteId) {
      const response = await request(owner, state, 'AbortMultipartUpload', 'DELETE', '?uploadId=' + encodeURIComponent(state.remoteId));
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw providerError(response.status);
      if (state.completing && await committed(owner, state)) {
        finish(owner, draftId, state);
        throw new FilmUploadError('This film finished uploading before cancellation. Reload the draft.', 409);
      }
    }
    store.clearUpload(owner, draftId);
    return { cancelled: true };
  }

  function status(owner, draftId) {
    const { state } = context(owner, draftId);
    return state ? view(state) : null;
  }
  return { start, part, complete, cancel, status };
}
