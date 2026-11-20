import { attachSubtitles } from './subtitles.js';
import { attachVideoControls } from './video-controls.js';

const video = document.querySelector('video');
const play = document.querySelector('#play');
const status = document.querySelector('#status');
const videoControls = attachVideoControls(video, status);
const filmId = location.pathname.split('/')[2] || 'clock';
const prefix = '/film/' + encodeURIComponent(filmId);
const subtitles = attachSubtitles(video, prefix, switchRendition);
let rendition = '', playbackGeneration = 0;
const renditionQuery = () => rendition ? '?subtitle=' + encodeURIComponent(rendition) : '';
const fragment = new URLSearchParams(location.hash.slice(1));
let receipt = fragment.get('receipt');
if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
window.addEventListener('hashchange', () => {
  const next = new URLSearchParams(location.hash.slice(1));
  if (['attempt', 'restore', 'receipt'].some(key => next.has(key))) location.reload();
});

let stream;
let renewal;
let resumePosition = 0;
let viewId;
let playGrant;
let counted = false;
let lastSave = 0;
let savedSecond = -1;
const previewSeconds = Number(document.body.dataset.preview ?? 10);
if (!previewSeconds) play.hidden = true;
let library;
let paid = false;
let checkout;
let purchase = false;
let purchaseCheckedAt = 0;
if (receipt) play.textContent = 'Play rental';
if (!receipt && document.body.dataset.checkout === 'true') {
  import('/checkout.js').then(async ({ attachViewerCheckout }) => {
    const restoreCode = fragment.get('restore');
    if (restoreCode) {
      const box = document.querySelector('#email-return');
      const button = document.querySelector('#redeem-link');
      box.hidden = false;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch(prefix + '/redeem', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
            body: restoreCode, credentials: 'omit', redirect: 'error' });
          if (!response.ok) throw new Error('Unavailable');
          await checkout.restoreAttempt((await response.json()).token);
          box.hidden = true;
        } catch { status.textContent = 'This email link could not be used. Try again or request a new link below.'; }
        finally { button.disabled = false; }
      });
    } else if (document.body.dataset.published === 'false' && !fragment.has('attempt')) {
      status.textContent = 'This film is closed to new viewers. Open your private access link to continue watching.';
    }
    checkout = attachViewerCheckout(filmId, fragment.get('attempt'), (order, watchNow) => {
      receipt = order.receipt;
      purchase = order.kind === 'buy';
      resumePosition = Number(order.position) || 0;
      purchaseCheckedAt = Date.now();
      document.body.dataset.access = order.kind;
      video.classList.remove('preview-ended');
      play.textContent = purchase ? 'Play film' : 'Play rental';
      if (paid && stream) {
        status.textContent = 'Your purchase is ready.';
        if (watchNow && video.paused) startVideo();
        return;
      }
      play.hidden = false;
      status.textContent = purchase ? 'Your purchase is ready.' : 'Your rental is ready.';
      if (watchNow) { window.scrollTo(0, 0); play.click(); }
    });
    if (video.ended || !previewSeconds) checkout.showOffer();
  }).catch(() => {
    status.textContent = 'Checkout could not load. Refresh this player to try again.';
  });
}

function fail(message) {
  playbackGeneration++;
  videoControls.exitPictureInPicture();
  clearTimeout(renewal);
  subtitles.clear();
  playGrant = undefined;
  stream?.destroy();
  stream = undefined;
  video.removeAttribute('src');
  video.load();
  play.hidden = false;
  play.disabled = false;
  status.textContent = message;
}

function loadLibrary() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/hls.js';
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      library = undefined;
      reject(new Error('The player could not load. Select ' + play.textContent + ' to try again.'));
    };
    document.head.appendChild(script);
  });
  return library;
}

async function startVideo() {
  try {
    await video.play();
    play.hidden = true;
    status.textContent = '';
  } catch {
    play.hidden = false;
    status.textContent = 'Select ' + play.textContent + ' to watch.';
  } finally {
    play.disabled = false;
  }
}

async function rental(resumeAt = 0, autoplay = true) {
  const generation = ++playbackGeneration;
  // The first session can use the receipt just confirmed by the order check.
  // A new play after a pause or a ten-minute grant renewal rechecks the sale.
  if (purchase && Date.now() - purchaseCheckedAt > 30000) {
    receipt = await checkout.purchaseReceipt();
    purchaseCheckedAt = Date.now();
  }
  const [response] = await Promise.all([fetch(prefix + '/session', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: receipt, credentials: 'omit'
  }), loadLibrary()]);
  if (!response.ok) throw new Error(purchase ? 'This purchase is unavailable.' : 'This rental is unavailable or has expired.');
  const { grant, expiresAt, rentalExpiresAt } = await response.json();
  if (generation !== playbackGeneration) return;
  playGrant = grant;
  if (!window.Hls?.isSupported()) throw new Error('Open this prototype in a browser with Media Source playback.');
  stream?.destroy();
  const base = new URL(prefix + '/play/', location.origin);
  const player = new window.Hls({
    enableWorker: false, maxBufferLength: 12, maxMaxBufferLength: 20, startPosition: resumeAt,
    xhrSetup(xhr, url) {
      const target = new URL(url, location.origin);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error('Unexpected media address.');
      xhr.setRequestHeader('Authorization', 'Bearer ' + grant);
    }
  });
  stream = player;
  player.on(window.Hls.Events.ERROR, (_, event) => {
    if (stream !== player) return;
    if (event.response?.code === 403 || event.networkDetails?.status === 403) {
      fail('Checking your film access…');
      checkout?.checkAccess();
    } else if (event.fatal) {
      fail('Playback stopped. Select ' + play.textContent + ' to try again.');
    }
  });
  player.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (stream !== player) return;
    subtitles.show('play', grant);
    play.hidden = true;
    play.disabled = false;
    status.textContent = '';
    if (autoplay) startVideo();
  });
  player.attachMedia(video);
  player.loadSource(new URL('index.m3u8' + renditionQuery(), base).href);
  // Reattach with a new grant and encryption key while preserving the viewer's position.
  clearTimeout(renewal);
  const remaining = expiresAt * 1000 - Date.now();
  if (!purchase && expiresAt === rentalExpiresAt) {
    renewal = setTimeout(() => fail('Your rental has expired.'), Math.max(0, remaining));
  } else {
    renewal = setTimeout(() => {
      rental(video.currentTime, !video.paused).catch(error => fail(error.message));
    }, Math.max(1000, remaining - 15000));
  }
}

function switchRendition(next) {
  if (next === rendition) return;
  rendition = next;
  const position = video.currentTime;
  const playing = !video.paused && !video.ended;
  if (paid && stream) {
    subtitles.suspend();
    rental(position, playing).catch(error => fail(error.message));
  } else if (!paid && video.currentSrc && !video.ended) {
    const generation = ++playbackGeneration;
    subtitles.suspend();
    video.addEventListener('loadedmetadata', () => {
      if (generation !== playbackGeneration) return;
      subtitles.resume();
      video.currentTime = Math.min(position, video.duration);
      if (playing) startVideo();
    }, { once: true });
    video.src = prefix + '/preview.mp4' + renditionQuery();
    video.load();
  }
}

play.addEventListener('click', async () => {
  play.disabled = true;
  status.textContent = 'Loading…';
  try {
    if (receipt) {
      if (paid && stream) { await startVideo(); return; }
      subtitles.clear();
      if (!video.paused) video.pause();
      paid = true;
      counted = false;
      viewId = crypto.randomUUID();
      await rental(resumePosition);
    } else {
      if (!previewSeconds) return;
      counted = false;
      viewId = crypto.randomUUID();
      playbackGeneration++;
      video.src = prefix + '/preview.mp4' + renditionQuery();
      subtitles.show('preview');
      await video.play();
      play.hidden = true;
      play.disabled = false;
      status.textContent = '';
    }
  } catch (error) {
    fail(receipt ? error.message : 'The preview could not play. Please try again.');
  }
});

function bookmark(force = false) {
  if (!paid || !counted || !stream || !checkout || !Number.isFinite(video.duration) || video.readyState < 2) return;
  if (!force && Date.now() - lastSave < 30000) return;
  const second = video.ended || video.duration - video.currentTime < 2 ? 0 : Math.floor(video.currentTime);
  if (second === savedSecond) return;
  checkout.savePosition(second);
  savedSecond = second;
  lastSave = Date.now();
}
video.addEventListener('timeupdate', () => bookmark());
for (const event of ['pause','seeked','ended']) video.addEventListener(event, () => bookmark(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) bookmark(true); });
window.addEventListener('pagehide', () => bookmark(true));
document.addEventListener('stream-access-ended', () => {
  receipt = undefined;
  paid = false;
  delete document.body.dataset.access;
  fail('Film access ended.');
  play.hidden = !previewSeconds;
  play.textContent = 'Play ' + previewSeconds + '-second preview';
  checkout?.showOffer();
});
video.addEventListener('playing', () => {
  video.classList.remove('preview-ended');
  if (counted || !viewId || document.body.dataset.checkout !== 'true') return;
  counted = true;
  const headers = { 'Content-Type': 'text/plain' };
  if (paid) headers.Authorization = 'Bearer ' + playGrant;
  fetch(prefix + '/view', { method: 'POST', headers, body: (paid ? 'paid ' : 'preview ') + viewId,
    credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
});
video.addEventListener('ended', () => {
  if (paid) {
    resumePosition = 0;
    fail(purchase ? 'Screening complete.' : 'Rental screening complete.');
    return;
  }
  clearTimeout(renewal);
  play.hidden = false;
  if (receipt) {
    status.textContent = purchase ? 'Your purchase is ready.' : 'Your rental is ready.';
  } else {
    status.textContent = document.body.dataset.checkout === 'true' ? 'Preview complete.' : 'Preview complete. A rental unlocks the full film.';
    if (document.body.dataset.checkout === 'true') {
      video.classList.add('preview-ended');
      play.textContent = 'Replay preview';
      checkout?.showOffer();
    }
  }
});
