import { readBoundedText } from '@dustwave/worker-core/response-body';
import { MAX_FILE_BYTES, r2Request, videoContentType } from './source.js';

export function bucketSelection({ accountId, jurisdiction = 'default', bucket }) {
  return [accountId, jurisdiction, bucket].join('/');
}

export function isBucketFileKey(key) {
  return typeof key === 'string' && Buffer.byteLength(key) <= 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..');
}

export function hasVideoExtension(key) {
  return videoContentType(/\.([^.\/]+)$/.exec(key)?.[1]?.toLowerCase()) !== 'application/octet-stream';
}

// R2's URL encoding lets every XML-safe or XML-unsafe filename round-trip as text.
export async function listBucketVideos(settings, { cursor = '', allFiles = false } = {}, fetcher = fetch) {
  const query = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url', 'max-keys': '100' });
  if (cursor) query.set('continuation-token', cursor);
  const response = await r2Request(settings, '?' + query, fetcher)('GET');
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Bucket listing unavailable.');
  }
  const xml = (await readBoundedText(response, 512 * 1024)).trim();
  const truncated = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml)?.[1];
  if (!truncated || !/<ListBucketResult[\s>]/.test(xml) || !xml.endsWith('</ListBucketResult>')) {
    throw new Error('Incomplete bucket listing.');
  }
  const files = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const encoded = /<Key>([^<]*)<\/Key>/.exec(match[1])?.[1];
    const bytes = Number(/<Size>(\d+)<\/Size>/.exec(match[1])?.[1]);
    if (encoded === undefined || !Number.isSafeInteger(bytes)) throw new Error('Incomplete bucket entry.');
    const key = decodeURIComponent(encoded);
    if (bytes <= 0 || bytes > MAX_FILE_BYTES || !isBucketFileKey(key)) continue;
    const video = hasVideoExtension(key);
    if (video || allFiles) files.push({key, bytes, ...(!video && {other:true})});
  }
  let next = null;
  if (truncated === 'true') {
    const value = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!value || value.length > 4096) throw new Error('Missing bucket continuation.');
    next = value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) =>
      ({amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"}[entity]));
    if (next === cursor) throw new Error('Bucket continuation did not advance.');
  }
  return { files, next };
}
