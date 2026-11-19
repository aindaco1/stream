import { open, stat } from 'node:fs/promises';
import { AwsClient } from 'aws4fetch';

export const BLOCK_SIZE = 128 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

function checkedHead(size, revision) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES || !revision) {
    throw new Error('Invalid source metadata or unsupported film size.');
  }
  return { size, revision };
}

function checkRange({ size }, start, end, limit = BLOCK_SIZE) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > size || end - start > limit) {
    throw new Error('Invalid source range.');
  }
}

function fileHead(info) {
  if (!info.isFile()) throw new Error('A regular source file is required.');
  return checkedHead(Number(info.size), [info.dev, info.ino, info.size, info.ctimeNs].join('-'));
}

export function createFileSource(path) {
  return {
    async head() { return fileHead(await stat(path, { bigint: true })); },
    async read(head, start, end) {
      checkRange(head, start, end);
      const handle = await open(path, 'r');
      try {
        const check = async () => {
          if (fileHead(await handle.stat({ bigint: true })).revision !== head.revision) {
            throw new Error('Source revision changed.');
          }
        };
        await check();
        const data = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(data, 0, data.length, start);
        if (bytesRead !== data.length) throw new Error('Incomplete source range.');
        await check();
        return data;
      } finally {
        await handle.close();
      }
    }
  };
}

function r2Request({ accountId, bucket, jurisdiction = 'default', accessKeyId, secretAccessKey }, suffix, fetcher) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      !['default', 'eu', 'us', 'fedramp'].includes(jurisdiction) || !accessKeyId || !secretAccessKey) {
    throw new Error('Invalid private R2 configuration.');
  }
  const region = jurisdiction === 'default' ? '' : '.' + jurisdiction;
  const url = 'https://' + accountId + region + '.r2.cloudflarestorage.com/' + bucket + suffix;
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  return async (method, headers, signal = AbortSignal.timeout(15000)) => fetcher(await client.sign(url, {
    method, headers, redirect: 'error', signal, aws: { allHeaders: true }
  }));
}

export async function checkR2Bucket(settings, fetcher = fetch) {
  const response = await r2Request(settings, '', fetcher)('HEAD');
  if (response.status !== 200) throw new Error('Bucket is unavailable.');
}

export function createR2Source(settings, fetcher = fetch) {
  const parts = typeof settings.objectKey === 'string' ? settings.objectKey.split('/') : [];
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) {
    throw new Error('Invalid private R2 configuration.');
  }
  const request = r2Request(settings, '/' + parts.map(encodeURIComponent).join('/'), fetcher);
  async function rangeResponse(head, start, end, signal) {
    const response = await request('GET', { Range: `bytes=${start}-${end - 1}`, 'If-Match': head.revision }, signal);
    const expected = `bytes ${start}-${end - 1}/${head.size}`;
    if (response.status !== 206 || response.headers.get('etag') !== head.revision ||
        response.headers.get('content-range') !== expected ||
        Number(response.headers.get('content-length')) !== end - start || !response.body) {
      await response.body?.cancel();
      throw new Error('Source revision or range is unavailable.');
    }
    return response;
  }
  return {
    async head() {
      const response = await request('HEAD');
      const revision = response.headers.get('etag');
      if (response.status !== 200 || !/^"[^"\s]+"$/.test(revision || '')) {
        throw new Error('Private source is unavailable.');
      }
      return checkedHead(Number(response.headers.get('content-length')), revision);
    },
    async read(head, start, end) {
      checkRange(head, start, end);
      const response = await rangeResponse(head, start, end);
      const data = new Uint8Array(end - start);
      const reader = response.body.getReader();
      let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > data.length) {
            await reader.cancel();
            throw new Error('Unexpected source range length.');
          }
          data.set(value, offset);
          offset += value.length;
        }
      } finally {
        reader.releaseLock();
      }
      if (offset !== data.length) throw new Error('Incomplete source range.');
      return data;
    },
    // An authorized buyer receives the original in one conditional upstream
    // GET. Time only active network operations; the downstream can pause reads.
    async *stream(head, start, end, signal) {
      checkRange(head, start, end, head.size);
      const controller = new AbortController();
      const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      async function timed(operation) {
        const timer = setTimeout(() => controller.abort(), 15000);
        try { return await operation(); } finally { clearTimeout(timer); }
      }
      let reader;
      try {
        const response = await timed(() => rangeResponse(head, start, end, abort));
        reader = response.body.getReader();
        let received = 0;
        while (true) {
          abort.throwIfAborted();
          const { done, value } = await timed(() => reader.read());
          if (done) break;
          received += value.byteLength;
          if (received > end - start) throw new Error('Unexpected source range length.');
          yield value;
        }
        if (received !== end - start) throw new Error('Incomplete source range.');
      } finally {
        controller.abort();
        if (reader) {
          try { await reader.cancel(); } finally { reader.releaseLock(); }
        }
      }
    }
  };
}
