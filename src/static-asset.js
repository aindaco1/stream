import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Only fixed, process-loaded application files belong here. Pages and all
// filmmaker, viewer and media responses keep their own access/cache policy.
export function staticAsset(type, data) {
  const etag = 'W/"' + createHash('sha256').update(data).digest('base64url') + '"';
  const gzip = type.startsWith('text/') && data.length >= 1024 ? gzipSync(data) : null;
  return (req, send, headers = {}) => {
    const extra = { ...headers, ETag: etag, 'Cache-Control': 'public, no-cache' };
    if (gzip) extra.Vary = 'Accept-Encoding';
    const tags = (req.headers['if-none-match'] || '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
    if (tags.includes('*') || tags.includes(etag.slice(2))) return send(304, type, '', extra);
    if (gzip && acceptsGzip(req.headers['accept-encoding'])) {
      return send(200, type, gzip, { ...extra, 'Content-Encoding': 'gzip' });
    }
    return send(200, type, data, extra);
  };
}

function acceptsGzip(header = '') {
  const codings = header.toLowerCase().split(',').map(coding => coding.trim().split(/\s*;\s*q\s*=\s*/));
  const match = codings.find(([name]) => name === 'gzip') ?? codings.find(([name]) => name === '*');
  return Boolean(match && (match[1] === undefined || Number(match[1]) > 0));
}
