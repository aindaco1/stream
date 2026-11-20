import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

export const testWriterId = '8'.repeat(32), testWriterSecret = 'b'.repeat(64);
export function thumbnailBucket() {
  const objects = new Map();
  async function fetcher(request) {
    const url = new URL(request.url), [, bucket, ...parts] = url.pathname.split('/');
    const key = parts.join('/');
    assert.match(key, /^stream-thumbnails\/f-[a-f\d-]{36}\.jpg$/);
    const write = ['PUT', 'DELETE'].includes(request.method);
    if (write) {
      const token = Buffer.from(request.headers.get('x-amz-security-token'), 'base64').toString();
      const [header, payload, signature] = token.slice(4).split('.');
      const claim = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(token.slice(0, 4), 'jwt/');
      assert.deepEqual(claim.paths, { objectPaths: [key] });
      assert.deepEqual(claim.actions, ['PutObject', 'DeleteObject']);
      assert.equal(claim.bucket, bucket);
      assert.equal(claim.aud, url.host);
      assert.ok(claim.exp > Date.now() / 1000);
      if (signature !== createHmac('sha256', testWriterSecret).update(header + '.' + payload).digest('base64url')) return new Response(null, { status: 403 });
    } else assert.equal(request.headers.has('x-amz-security-token'), false);
    const old = objects.get(url.href);
    if (request.method === 'PUT') {
      if (old ? request.headers.get('if-match') !== old.headers.etag : request.headers.get('if-none-match') !== '*') {
        return new Response(null, { status: 412 });
      }
      const image = Buffer.from(await request.arrayBuffer());
      const headers = Object.fromEntries([...request.headers].filter(([key]) => key.startsWith('x-amz-meta-') || key === 'content-type'));
      headers.etag = '"' + createHash('md5').update(image).digest('hex') + '"';
      headers['content-length'] = String(image.length);
      objects.set(url.href, { headers, image });
      return new Response(null);
    }
    if (request.method === 'DELETE') { objects.delete(url.href); return new Response(null, { status: 204 }); }
    if (!old) return new Response(null, { status: 404 });
    return new Response(request.method === 'GET' ? old.image : null, { headers: old.headers });
  }
  return { objects, fetcher };
}
