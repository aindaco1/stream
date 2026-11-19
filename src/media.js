import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  BufferTarget, CustomSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, MpegTsOutputFormat, Output
} from 'mediabunny';
import { BLOCK_SIZE } from './source.js';

const META = { metadataOnly: true };
const EPSILON = 1e-8;
const MAX_SEGMENTS = 4096;
const MAX_PACKET_BYTES = 4 * 1024 * 1024;
const MAX_RENDER_BYTES = 12 * 1024 * 1024;
const MAX_PACKETS = 8000;

// Block-aligned reads let interleaved audio and video share provider requests.
function privateInput(source, head, getReadBudget) {
  const blocks = new Map();
  function block(index) {
    let promise = blocks.get(index);
    blocks.delete(index);
    if (!promise) {
      const budget = getReadBudget();
      if (++budget.reads > budget.maxReads || Date.now() >= budget.deadline) {
        throw new Error('Film exceeds the prototype source read budget.');
      }
      const start = index * BLOCK_SIZE;
      promise = source.read(head, start, Math.min(start + BLOCK_SIZE, head.size));
      promise.catch(() => { if (blocks.get(index) === promise) blocks.delete(index); });
    }
    blocks.set(index, promise);
    if (blocks.size > 24) blocks.delete(blocks.keys().next().value);
    return promise;
  }
  return new Input({ formats: [MP4], source: new CustomSource({
    getSize: () => head.size,
    maxCacheSize: 512 * 1024,
    async read(start, end) {
      if (end - start > MAX_PACKET_BYTES) throw new Error('Film index or packet exceeds prototype limits.');
      const result = new Uint8Array(end - start);
      for (let pos = start; pos < end;) {
        const bytes = await block(Math.floor(pos / BLOCK_SIZE));
        const offset = pos % BLOCK_SIZE;
        const length = Math.min(bytes.length - offset, end - pos);
        if (length <= 0) throw new Error('Private source returned an incomplete block.');
        result.set(bytes.subarray(offset, offset + length), pos - start);
        pos += length;
      }
      return result;
    },
    dispose() { blocks.clear(); }
  }) });
}

export function revisionFor(head) {
  return createHash('sha256').update(head.revision).digest('base64url');
}

async function keyframeSegments(video, duration) {
  const starts = [];
  let key = await video.getFirstKeyPacket(META);
  while (key) {
    if (!Number.isFinite(key.timestamp) || key.timestamp < 0 || key.timestamp >= duration ||
        (starts.length && key.timestamp <= starts.at(-1)) || starts.length >= MAX_SEGMENTS) {
      throw new Error('Unsupported keyframe timeline.');
    }
    starts.push(key.timestamp);
    key = await video.getNextKeyPacket(key, META);
  }
  if (starts[0] !== 0) throw new Error('Film must begin with a keyframe at zero.');
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? duration;
    if (end - start > 12) throw new Error('Export the film with keyframes at least every 12 seconds.');
    return Object.freeze({ start, end, duration: end - start });
  });
}

async function copyTrack({ sink, outputTrack, decoderConfig, isVideo }, start, end, preview, budget) {
  const first = isVideo ? await sink.getKeyPacket(start + EPSILON) :
    (await sink.getPacket(start + EPSILON) ?? await sink.getFirstPacket());
  if (!first || (isVideo && Math.abs(first.timestamp - start) > EPSILON)) throw new Error('Missing segment start.');
  let previous = -Infinity;
  // Read one packet per track. The general iterator may prefetch 128 large packets per track.
  for (let packet = first; packet; packet = await sink.getNextPacket(packet)) {
    if (budget.cancelled) return;
    if (++budget.packets > MAX_PACKETS) throw new Error('Media interval exceeds prototype packet limit.');
    if (packet.timestamp + EPSILON >= end) break;
    if (!Number.isFinite(packet.timestamp) || !(packet.duration > 0) || !Number.isFinite(packet.duration) ||
        packet.timestamp < previous) throw new Error('Unsupported packet timing.');
    previous = packet.timestamp;
    if (packet.timestamp < start - EPSILON) continue;
    // A whole AAC frame can cross the preview boundary. Drop it and never send its payload.
    if (preview && packet.timestamp + packet.duration > end + EPSILON) continue;
    budget.bytes += packet.data.byteLength;
    if (budget.bytes > MAX_RENDER_BYTES) throw new Error('Media interval exceeds prototype byte limit.');
    await outputTrack.add(packet.clone({ timestamp: Math.max(0, packet.timestamp - start) }), { decoderConfig });
  }
  outputTrack.close();
}

export async function openFilm(source, { previewSeconds = 10 } = {}) {
  if (!Number.isFinite(previewSeconds) || previewSeconds < 0 || previewSeconds > 30) throw new Error('Unsupported preview length.');
  const head = await source.head();
  const reads = new AsyncLocalStorage();
  const initialization = { reads: 0, maxReads: 64, deadline: Date.now() + 30000 };
  const input = privateInput(source, head, () => reads.getStore() ?? initialization);
  try {
    const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!videoTrack) throw new Error('Missing video track.');
    const videoConfig = await videoTrack.getDecoderConfig();
    const audioConfig = await audioTrack?.getDecoderConfig();
    // Baseline AVC has no B-frames. A presentation-time cutoff is also a decode-order cutoff.
    if (!/^avc[13]\.42/i.test(videoConfig?.codec ?? '') || (audioTrack && audioConfig?.codec !== 'mp4a.40.2')) {
      throw new Error('Use baseline H.264 video and optional AAC-LC audio for this prototype.');
    }
    const tracks = [videoTrack, ...(audioTrack ? [audioTrack] : [])];
    const duration = await input.computeDuration(tracks, META);
    if (!(duration > 0) || duration > 4 * 60 * 60) throw new Error('Unsupported film duration.');
    const video = new EncodedPacketSink(videoTrack);
    const audio = audioTrack ? new EncodedPacketSink(audioTrack) : null;
    const segments = Object.freeze(await keyframeSegments(video, duration));
    const pending = new Map();
    const queue = [];
    let active = 0;
    async function renderInterval(start, end, preview) {
      if (active < 4) active++;
      else await new Promise(resolve => queue.push(resolve));
      try {
        const current = await source.head();
        if (current.revision !== head.revision || current.size !== head.size) throw new Error('Film was replaced. Reconnect the source.');
        const target = new BufferTarget();
        const format = preview ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new MpegTsOutputFormat();
        const output = new Output({ target, format });
        // Every byte range of the same preview must address one stable MP4 representation.
        if (preview) output.setMetadataTags({ creationTime: null });
        const videoOut = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoOut);
        const jobs = [{ sink: video, outputTrack: videoOut, decoderConfig: videoConfig, isVideo: true }];
        if (audio) {
          const audioOut = new EncodedAudioPacketSource('aac');
          output.addAudioTrack(audioOut);
          jobs.push({ sink: audio, outputTrack: audioOut, decoderConfig: audioConfig, isVideo: false });
        }
        const budget = { bytes: 0, packets: 0, cancelled: false };
        await output.start();
        const copies = jobs.map(job => copyTrack(job, start, end, preview, budget));
        try {
          await Promise.all(copies);
          await output.finalize();
        } catch (error) {
          budget.cancelled = true;
          await output.cancel();
          await Promise.allSettled(copies);
          throw error;
        }
        return new Uint8Array(target.buffer);
      } finally {
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    }
    // Several embeds can ask for the same public interval simultaneously. Share only in-flight work.
    function render(start, end, preview) {
      const key = (preview ? 'preview:' : 'segment:') + start;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 20) throw new Error('Media renderer is busy.');
      const budget = { reads: 0, maxReads: 128, deadline: Date.now() + 45000 };
      const job = reads.run(budget, () => renderInterval(start, end, preview)).finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    }
    return Object.freeze({
      revision: revisionFor(head), duration, segments,
      async preview() {
        if (!previewSeconds) throw new Error('Preview is disabled.');
        if (previewSeconds >= duration) throw new Error('Preview must end before the film ends.');
        return render(0, previewSeconds, true);
      },
      async segment(index) {
        if (!Number.isInteger(index) || index < 0 || index >= segments.length) throw new Error('Unknown segment.');
        const { start, end } = segments[index];
        return render(start, end, false);
      },
      close() { input.dispose(); }
    });
  } catch (error) {
    input.dispose();
    throw error;
  }
}
