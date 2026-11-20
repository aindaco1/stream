import { createHash, randomUUID } from 'node:crypto';

const etag = bytes => '"' + createHash('md5').update(bytes).digest('hex') + '"';
const xml = body => new Response(body, { headers: { 'content-type': 'application/xml' } });

export function filmUploadBucket() {
  const calls = [], uploads = new Map(), objects = new Map();
  async function fetcher(request) {
    const { pathname, searchParams: query } = new URL(request.url);
    const key = pathname.split('/').slice(2).map(decodeURIComponent).join('/');
    const { method, headers } = request;
    const body = Buffer.from(await request.arrayBuffer());
    calls.push({ method, key, query, headers, body });
    if (method === 'HEAD') {
      const object = objects.get(key);
      return new Response(null, object ? { headers: object.headers } : { status: 404 });
    }
    if (method === 'GET') {
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      if (headers.get('if-match') !== object.headers.get('etag')) return new Response(null, { status: 412 });
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));
      if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) >= object.data.length) {
        return new Response(null, { status: 416 });
      }
      const part = object.data.subarray(Number(match[1]), Number(match[2]) + 1);
      const rangeHeaders = new Headers(object.headers);
      rangeHeaders.set('content-range', 'bytes ' + match[1] + '-' + match[2] + '/' + object.data.length);
      rangeHeaders.set('content-length', String(part.length));
      return new Response(part, { status: 206, headers: rangeHeaders });
    }
    if (method === 'POST' && query.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, { key, headers, parts: new Map() });
      return xml('<InitiateMultipartUploadResult><UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>');
    }
    const id = query.get('uploadId');
    const upload = uploads.get(id);
    if (!upload || upload.key !== key) return new Response(null, { status: 404 });
    if (method === 'PUT') {
      const part = Number(query.get('partNumber'));
      if (!Number.isInteger(part) || part < 1) return new Response(null, { status: 400 });
      upload.parts.set(part, body);
      return new Response(null, { headers: { etag: etag(body) } });
    }
    if (method === 'DELETE') {
      uploads.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      if (objects.has(key) && headers.get('if-none-match') === '*') return new Response(null, { status: 412 });
      const requested = [...body.toString().matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>\s*<\/Part>/g)];
      const parts = [];
      for (const [, number, expected] of requested) {
        const part = upload.parts.get(Number(number));
        if (!part || etag(part) !== expected.replaceAll('&quot;', '"')) return new Response(null, { status: 400 });
        parts.push(part);
      }
      if (!parts.length) return new Response(null, { status: 400 });
      const data = Buffer.concat(parts);
      const metadata = new Headers({ 'content-length': String(data.length), etag: etag(data) });
      for (const [name, value] of upload.headers) {
        if (name.startsWith('x-amz-meta-') || name === 'content-type') metadata.set(name, value);
      }
      objects.set(key, { data, headers: metadata });
      uploads.delete(id);
      return xml('<CompleteMultipartUploadResult><ETag>' + etag(data) + '</ETag></CompleteMultipartUploadResult>');
    }
    throw Error('Unexpected fixture operation ' + method);
  }
  return { calls, uploads, objects, fetcher };
}
