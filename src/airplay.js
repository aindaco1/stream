import { createHash, randomBytes } from 'node:crypto';

// A receiver can fetch only HLS for the film and revision the viewer rented.
// Its opaque URL is separate from the receipt, checkout token and normal grants.
export function airplayLeases({ now = Date.now, capacity = 512 } = {}) {
  const sessions = new Map();
  const idle = 10 * 60 * 1000;
  const active = session => session && now() < session.until && now() < session.rentalExpiresAt * 1000;
  function touch(session) {
    session.until = Math.min(now() + idle, session.rentalExpiresAt * 1000);
    return session;
  }
  return {
    issue(offer, access) {
      if (!offer.id || offer.type === 'program' || access.access !== 'rent' || !access.orderId ||
          !Number.isSafeInteger(access.rentalExpiresAt) || access.rentalExpiresAt * 1000 <= now()) return;
      let current;
      for (const [token, item] of sessions) {
        if (!active(item)) sessions.delete(token);
        else if (item.orderId === access.orderId && item.id === offer.id && item.revision === offer.revision &&
          item.scope === offer.scope && item.rentalExpiresAt === access.rentalExpiresAt) current = item;
      }
      if (current) return touch(current);
      if (sessions.size >= capacity) throw Object.assign(new Error('Receiver sessions busy.'), { statusCode: 429 });
      const token = randomBytes(32).toString('base64url');
      const session = touch({ token, key: randomBytes(16), id: offer.id, revision: offer.revision, scope: offer.scope,
        access: 'rent', orderId: access.orderId, rentalExpiresAt: access.rentalExpiresAt });
      sessions.set(token, session);
      return session;
    },
    read(token, offer) {
      const session = sessions.get(token);
      if (!active(session)) { sessions.delete(token); return; }
      if (session.id === offer.id && session.scope === offer.scope && session.revision === offer.revision) return session;
    },
    active, touch
  };
}

// A stable anonymous reference for a settled rental. It conveys no playback access.
export function screenerReference(offer, access) {
  if (!offer.screenerWatermark || access?.access !== 'rent' || !access.orderId) return;
  return createHash('sha256').update(JSON.stringify(['screener', offer.scope, access.orderId])).digest('hex').slice(0, 8).toUpperCase();
}

export function captionMaster(track) {
  const suffix = '?subtitle=' + track.id;
  return ['#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cc",NAME="Selected captions",DEFAULT=YES,AUTOSELECT=YES,URI="captions.m3u8' + suffix + '"',
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,SUBTITLES="cc"', 'video.m3u8', ''].join('\n');
}

const timings = line => {
  const [h, m, s] = line.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const timestamp = sec => new Date(Math.round(sec * 1000)).toISOString().slice(11, 23);
export function captionCues(sanitizedVtt) {
  return sanitizedVtt.trim().split('\n\n').slice(1).map(block => {
    const [time, ...text] = block.split('\n');
    const [start, end] = time.split(' --> ').map(timings);
    return { start, end, text: text.join('\n') };
  });
}
export function captionSegment(cues, segment) {
  // Every video segment starts a new discontinuity with timestamps rebased to zero.
  const lines = ['WEBVTT', 'X-TIMESTAMP-MAP=LOCAL:' + timestamp(segment.start) + ',MPEGTS:0', ''];
  for (const cue of cues) {
    if (cue.end <= segment.start || cue.start >= segment.end) continue;
    lines.push(timestamp(cue.start) + ' --> ' + timestamp(cue.end), cue.text, '');
  }
  return lines.join('\n') + '\n';
}
