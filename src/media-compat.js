import sharp from 'sharp';
import { BufferSource, BufferTarget, Conversion, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny';
import { mediaProcess } from './media-process.js';

const MiB = 1024 * 1024;
const markPeriod = 60;
const markDuration = 4;

export function segmentWatermark(reference, start, end) {
  if (reference === undefined) return;
  if (typeof reference !== 'string' || !/^[A-Z0-9]{8}$/.test(reference)) throw new Error('Invalid rental reference.');
  if (start % markPeriod < markDuration || Math.ceil(start / markPeriod) * markPeriod < end) return reference;
}

const videoCodecs = new Set(['h264', 'hevc', 'av1', 'vp9']);
const textCodecs = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function trackInfo(stream) {
  let language = 'und';
  try { language = new Intl.Locale(stream.tags?.language || 'und').baseName; } catch {}
  const languageName = language === 'und' ? '' : new Intl.DisplayNames('en', { type: 'language' }).of(language);
  const name = String(stream.tags?.title || '').replace(/[\p{C}<>]/gu, '').trim().slice(0, 80);
  const title = /[\\/]|(?:https?|file):/i.test(name) ? '' : name;
  return { id: 's' + stream.index, language, label: title || languageName || 'Subtitle track ' + stream.index,
    kind: stream.disposition?.hearing_impaired ? 'captions' : 'subtitles', forced: Boolean(stream.disposition?.forced),
    format: bitmapCodecs.has(stream.codec_name) ? 'bitmap' : 'text' };
}

export async function probeFilm(source, head) {
  const prefix = Buffer.from(await source.read(head, 0, Math.min(head.size, 16)));
  let format;
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3) format = 'matroska';
  else if (/^(ftyp|moov|mdat|free|wide|skip|pnot)$/u.test(prefix.toString('latin1', 4, 8))) format = 'mov';
  else throw new Error('Choose an MP4, MOV or MKV film.');
  const data = JSON.parse(await mediaProcess(source, head, format, { probe: true, maxOutput: MiB, maxRead: 64 * MiB, timeout: 45000,
    after: ['-show_entries', 'format=start_time,duration:format_tags=major_brand:stream=index,codec_type,codec_name,profile,width,height,start_time,duration:stream_disposition=default,forced,hearing_impaired,attached_pic:stream_tags=language,title,DURATION', '-of', 'json'] }));
  const streams = data.streams ?? [];
  const best = type => {
    const items = streams.filter(s => s.codec_type === type && !s.disposition?.attached_pic);
    return items.find(s => s.disposition?.default) ?? items[0];
  };
  const video = best('video'), audio = best('audio');
  const durationTag = video?.tags?.DURATION;
  const origin = Number(data.format?.start_time) || 0;
  const duration = Number(video?.duration) || (/^\d+:\d\d:\d\d(?:\.\d+)?$/.test(durationTag) ? millis(durationTag) / 1000 - origin : Number(data.format?.duration));
  if (!videoCodecs.has(video?.codec_name) || !(video.width > 0 && video.height > 0) ||
      video.width * video.height > 36_000_000 || !(duration > 0 && duration <= 14400)) throw new Error('Unsupported video codec, dimensions or duration.');
  const tracks = streams.filter(s => s.codec_type === 'subtitle');
  return { format, extension: format === 'matroska' ? 'mkv' : data.format?.tags?.major_brand === 'qt  ' ? 'mov' : 'mp4',
    video: { index: video.index, width: video.width, height: video.height, codec_name: video.codec_name, profile: video.profile },
    audio: audio && { index: audio.index }, duration,
    baseline: format === 'mov' && video.codec_name === 'h264' && /baseline/i.test(video.profile) &&
      (!audio || audio.codec_name === 'aac' && audio.profile === 'LC'),
    subtitleTracks: tracks.filter(s => textCodecs.has(s.codec_name) || bitmapCodecs.has(s.codec_name)).map(trackInfo),
    unsupportedSubtitleTracks: tracks.filter(s => !textCodecs.has(s.codec_name) && !bitmapCodecs.has(s.codec_name)).map(s => ({ label: trackInfo(s).label, codec: s.codec_name })) };
}

// The reference is server-generated and validated before rendering. Supplying a tiny
// in-memory PNG avoids temporary files and works with FFmpeg builds without drawtext.
async function screenerImage(label, video) {
  const scale = Math.min(1, 1280 / video.width, 720 / video.height);
  const frameWidth = video.width * scale;
  const width = Math.max(1, Math.round(Math.min(180, video.height * scale * .78, frameWidth * .45, Math.max(68, frameWidth * .20))));
  const height = Math.max(1, Math.round(width * 24 / 116));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 116 24">
    <rect width="116" height="24" rx="3" fill="black" opacity=".62"/>
    <text x="58" y="17" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="15" fill="white" opacity=".96">${label}</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

export async function transcode(source, head, media, start, end, preview, pictureData, watermark) {
  const length = end - start;
  const before = ['-threads', '2', '-max_pixels', '36000000', ...(pictureData ? ['-copyts'] : []), ...(start ? ['-ss', String(start)] : [])];
  const trim = 'trim=start=' + (pictureData ? start : 0) + ':end=' + (pictureData ? end : length) + ',setpts=PTS-STARTPTS';
  // Fixed output cadence and bounded size keep codecs without native browser decoding seekable on the same HLS timeline.
  const scale = ',fps=24' + (preview ? ',trim=end_frame=' + Math.floor(length * 24) : '') +
    ",scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p";
  // A late seek replays the compact subtitle packets from the start so even a long-lived picture and
  // palette are reconstructed. The main video seeks directly to the requested time.
  const pictureInput = pictureData ? ['-max_pixels', '36000000', '-threads', '2', '-canvas_size', media.video.width + 'x' + media.video.height, '-protocol_whitelist', 'pipe',
    '-format_whitelist', 'matroska,webm', '-f', 'matroska', '-i', 'pipe:0'] : [];
  const videoLabel = '[0:' + media.video.index + ']setpts=PTS-STARTPTS+' + start + '/TB[clock];[clock][1:s:0]';
  const inputs = [...pictureInput];
  let graph = pictureData ? videoLabel + 'overlay=eof_action=pass,' + trim + scale : '[0:' + media.video.index + ']' + trim + scale;
  if (watermark) {
    inputs.push('-protocol_whitelist', 'data', '-f', 'png_pipe', '-i', await screenerImage(watermark, media.video));
    const time = `(t+${start})`;
    // Keep the whole label inside the overlap of a centered square and 16:9 crop.
    // Moving on both axes makes a fixed edge crop less effective across minutes.
    const minute = `floor(${time}/${markPeriod})`;
    const x = `(W-w)/2+if(mod(${minute},2),-1,1)*max(0,min(W,H)-w)*0.30`;
    const y = `(H-h)/2+if(between(mod(${minute},4),1,2),1,-1)*max(0,min(H,W*9/16)-h)*0.25`;
    const visible = `lt(mod(${time},${markPeriod}),${markDuration})`;
    graph += `[film];[film][${pictureData ? 2 : 1}:v]overlay=x='${x}':y='${y}':enable='${visible}'`;
  }
  const filters = pictureData || watermark ? ['-filter_complex', graph + '[v]', '-map', '[v]'] :
    ['-map', '0:' + media.video.index, '-vf', trim + scale];
  const args = [...inputs, ...filters, ...(media.audio ? ['-map', '0:' + media.audio.index, '-af', (pictureData ? 'asetpts=PTS-STARTPTS,' : '') + 'atrim=end=' + length + ',asetpts=PTS-STARTPTS',
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '112k', '-bsf:a', "noise=drop='lt(pts,0)'"] : ['-an']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-t', String(length),
    // Frame-threaded VBV can encode the same frame differently on successive MP4 range requests.
    '-c:v', 'libx264', '-threads', preview ? '1' : '2', '-preset', preview ? 'superfast' : 'veryfast', '-profile:v', 'baseline', '-bf', '0', '-g', '48', '-crf', '22',
    '-maxrate', '2500k', '-bufsize', '2500k', ...(preview ? ['-movflags', '+empty_moov+frag_keyframe+default_base_moof+negative_cts_offsets', '-f', 'mp4'] :
      ['-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts']), 'pipe:1'];
  // 2.5 Mbps video plus stereo audio and MP4 overhead, still bounded at three minutes.
  const maxOutput = preview ? Math.max(16 * MiB, Math.ceil(length * 352_000) + MiB) : 16 * MiB;
  const bytes = await mediaProcess(source, head, media.format, { before, after: args, stdin: pictureData, maxOutput,
    maxRead: preview ? previewReadBudget(length) : 512 * MiB, timeout: preview ? Math.max(90000, length * 2000) : 90000 });
  if (!preview) return bytes;
  // FFmpeg's stdout is unseekable. Copy its already-trimmed packets to a fast-start
  // MP4 so the browser can learn the duration and find the first frame in one request.
  const input = new Input({ formats: [MP4], source: new BufferSource(bytes) });
  try {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const copy = await Conversion.init({ input, output, tags: { creationTime: null }, showWarnings: false });
    if (!copy.isValid || copy.discardedTracks.length) throw new Error('Could not index the preview tracks.');
    await copy.execute();
    return new Uint8Array(target.buffer);
  } finally {
    input.dispose();
  }
}

function previewReadBudget(seconds, minimum = 512 * MiB) {
  // Allow the same source bitrate throughout the longer interval.
  return Math.max(minimum, Math.ceil(seconds * 8 * MiB));
}

export async function picturePackets(source, head, media, track, end) {
  const bytes = await mediaProcess(source, head, media.format, {
    before: end ? ['-t', String(end)] : [],
    after: ['-map', '0:' + track.id.slice(1), '-c:s', 'copy', ...(end ? ['-t', String(end)] : []), '-map_metadata', '-1', '-map_chapters', '-1',
      '-avoid_negative_ts', 'disabled', '-f', 'matroska', 'pipe:1'],
    maxOutput: end ? 8 * MiB : 64 * MiB, maxRead: end ? previewReadBudget(end, 256 * MiB) : head.size + 64 * MiB, timeout: end ? 45000 : 900000
  });
  // FFmpeg writes a Matroska header even when no subtitle packet begins before this preview ends.
  // Inspect our own muxer's top-level elements and Segment children; skip opaque payloads.
  let offset = 0;
  function number(id) {
    const first = bytes[offset++];
    if (!first) throw new Error('Invalid picture track.');
    const width = Math.clz32(first) - 23;
    let value = id ? first : first & (255 >> width);
    if (offset + width - 1 > bytes.length) throw new Error('Incomplete picture track.');
    for (let i = 1; i < width; i++) value = value * 256 + bytes[offset++];
    return value;
  }
  while (offset < bytes.length) {
    const id = number(true), size = number(false);
    if (id === 0x1f43b675) return bytes; // Cluster
    if (id !== 0x18538067) offset += size; // Segment wraps its level-one children.
  }
  return null;
}

function millis(time) {
  const parts = time.split(':').map(Number);
  return Math.round(parts.reduce((acc, part) => acc * 60 + part, 0) * 1000);
}
function stamp(ms) {
  return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' + String(Math.floor(ms / 60000) % 60).padStart(2, '0') + ':' +
    String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
}

// Rebuild cues as plain WebVTT. Container titles, styles, regions, cue settings and executable markup never reach the player.
export function safeVtt(raw, end) {
  const cues = [];
  let bytes = 0;
  const limit = Math.floor(end * 1000);
  for (const block of raw.replaceAll('\r', '').split(/\n[\t ]*\n/)) {
    const lines = block.trim().split('\n');
    const timing = /^(?:(\d{2,}:)?\d\d:\d\d\.\d{3}) --> (?:(\d{2,}:)?\d\d:\d\d\.\d{3})(?:[ \t].*)?$/.exec(lines[0]);
    if (!timing) continue;
    const [a, b] = lines[0].split(' --> ');
    const start = millis(a), stop = Math.min(limit, millis(b.split(/[ \t]/)[0]));
    if (!(start >= 0 && start < stop)) continue;
    let payload = lines.slice(1).join('\n').slice(0, 8192);
    for (const marker of payload.matchAll(/<((?:\d{2,}:)?\d\d:\d\d\.\d{3})>/g)) {
      if (millis(marker[1]) >= limit) { payload = payload.slice(0, marker.index); break; }
    }
    const text = payload.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').trim();
    if (text) {
      const cue = stamp(start) + ' --> ' + stamp(stop) + '\n' + text;
      bytes += Buffer.byteLength(cue) + 2;
      if (cues.length >= 25000 || bytes > 2 * MiB - 8) throw new Error('Subtitle track exceeds its cue or byte limit.');
      cues.push(cue);
    }
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

export async function renderText(source, head, media, track, end, preview) {
  const raw = await mediaProcess(source, head, media.format, {
    before: [...(preview ? ['-t', String(end)] : [])], after: ['-map', '0:' + track.id.slice(1), '-c:s', 'webvtt', '-t', String(end), '-f', 'webvtt', 'pipe:1'],
    maxOutput: 2 * MiB, maxRead: preview ? previewReadBudget(end, 256 * MiB) : head.size + 64 * MiB, timeout: preview ? 45000 : 900000
  });
  return safeVtt(raw.toString('utf8'), end);
}
