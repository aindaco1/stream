import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { BLOCK_SIZE } from './source.js';
import { mediaTransport } from './media-sandbox.js';

const execute = promisify(execFile);
const rendering = { slots: 2, active: 0, queue: [] };
const extraction = { slots: 1, active: 0, queue: [] };

async function limited(pool, work) {
  if (pool.active >= pool.slots) {
    if (pool.queue.length >= 12) throw new Error('Media renderer is busy.');
    await new Promise(resolve => pool.queue.push(resolve));
  } else pool.active++;
  try { return await work(); } finally {
    const next = pool.queue.shift();
    if (next) next(); else pool.active--;
  }
}

// FFmpeg sees one seekable loopback resource. Only our source adapter knows the R2 host and credentials.
export async function mediaProcess(source, head, format, { probe = false, before = [], after, stdin, maxOutput, maxRead, timeout = 90000, onFailure, checkSandbox = false }) {
  // A feature-length subtitle scan cannot occupy the workers needed for playback.
  return limited(timeout > 90000 ? extraction : rendering, async () => {
    const path = '/' + randomUUID();
    const url = 'http://stream-input.invalid' + path;
    const shutdown = new AbortController();
    let total = 0, requests = 0;
    const server = createServer(async (req, res) => {
      if ((req.url !== url && req.url !== 'http://stream-input.invalid:80' + path) || !['HEAD', 'GET'].includes(req.method)) {
        res.writeHead(404).end(); return;
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(head.size, Number(match[2]) + 1) : head.size;
      if (++requests > Math.ceil(maxRead / BLOCK_SIZE) + 96 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start >= end || start < 0 || (req.headers.range && !match)) { res.writeHead(416).end(); return; }
      res.writeHead(match ? 206 : 200, {
        'Accept-Ranges': 'bytes', 'Content-Length': end - start, ...(match ? { 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + head.size } : {})
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const connection = new AbortController();
      res.once('close', () => connection.abort());
      const signal = AbortSignal.any([shutdown.signal, connection.signal]);
      async function* read() {
        if (source.stream) {
          // Older FFmpeg sends open-ended HTTP ranges. Bound the upstream requests ourselves so
          // a metadata probe or abandoned seek never requests an entire feature from R2.
          for (let offset = start; offset < end;) {
            signal.throwIfAborted();
            // Probe/seek requests may quit as soon as the header arrives. An encoder
            // reading frames benefits from one continuous, still bounded transfer.
            const rangeSize = probe ? (offset === start ? BLOCK_SIZE : 2 * 1024 * 1024) : 4 * 1024 * 1024;
            const next = Math.min(end, offset + rangeSize, offset + maxRead - total);
            if (next <= offset) throw new Error('Source read budget exceeded.');
            total += next - offset;
            for await (const data of source.stream(head, offset, next, signal)) yield data;
            offset = next;
          }
        } else {
          for (let offset = start; offset < end;) {
            signal.throwIfAborted();
            const next = Math.min(offset + BLOCK_SIZE, end);
            total += next - offset;
            if (total > maxRead) throw new Error('Source read budget exceeded.');
            const data = await source.read(head, offset, next);
            if (data.length !== next - offset) throw new Error('Incomplete source range.');
            yield data;
            offset = next;
          }
        }
      }
      try { await pipeline(Readable.from(read()), res, { signal }); } catch { res.destroy(); }
    });
    server.maxConnections = 4;
    server.requestTimeout = timeout;
    let transport;
    try {
      transport = await mediaTransport(server, probe ? 'ffprobe' : 'ffmpeg', checkSandbox);
      const { proxy } = transport;
      // Format selection comes from local magic bytes. Disable external QuickTime references and every
      // input protocol except the HTTP transport needed to read our own private socket.
      const input = ['-protocol_whitelist', 'http,tcp', '-http_proxy', proxy, '-format_whitelist', 'mov,matroska,webm', '-f', format,
        ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
        '-probesize', '2097152', '-analyzeduration', '2000000', '-max_streams', '64', ...before, '-i', url];
      const args = ['-hide_banner', '-loglevel', 'error', '-max_alloc', '134217728',
        ...(probe ? [] : ['-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1']), ...input, ...after];
      const running = execute(transport.executable, [...transport.prefix, ...args], {
        env: { PATH: process.env.PATH, LC_ALL: 'C', http_proxy: proxy }, encoding: 'buffer', timeout, maxBuffer: maxOutput, killSignal: 'SIGKILL'
      });
      running.child.stdin.on('error', () => {}); // A completed bounded interval can close the subtitle pipe early.
      running.child.stdin.end(stdin);
      const { stdout } = await running;
      return stdout;
    } catch (error) {
      onFailure?.(error);
      throw new Error('The private media could not be processed within its format or resource limits.');
    } finally {
      shutdown.abort();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await transport?.cleanup?.();
    }
  });
}
