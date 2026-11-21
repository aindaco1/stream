import { attachSubtitles } from './subtitles.js';
import { attachVideoControls } from './video-controls.js';
import { attachProgram } from './program-player.js';
import './select-focus.js';

const video = document.querySelector('video');
const play = document.querySelector('#play');
const status = document.querySelector('#status');
const videoControls = attachVideoControls(video, status);
const filmId = location.pathname.split('/')[2] || 'clock';
const prefix = '/film/' + encodeURIComponent(filmId);
const subtitles = attachSubtitles(video, switchRendition);
const fragment = new URLSearchParams(location.hash.slice(1));
let receipt = fragment.get('receipt');
if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
window.addEventListener('hashchange', () => {
  const next = new URLSearchParams(location.hash.slice(1));
  if (['attempt', 'restore', 'receipt'].some(key => next.has(key))) location.reload();
});

let rendition = '', playbackGeneration = 0;
let stream, renewal, viewId, playGrant, checkout, library;
let counted = false, paid = false, purchase = false;
let lastSave = 0, savedSecond = -1, resumePosition = 0, purchaseCheckedAt = 0;
const previewSeconds = Number(document.body.dataset.preview ?? 10);
const programData = document.body.dataset.program;
const program = programData ? attachProgram(JSON.parse(programData), prefix, navigate,
  (url, button) => checkout?.downloadFile(url, button)) : null;
document.body.classList.toggle('is-program', Boolean(program));

const mediaPrefix = () => (paid && program?.titleBase) || prefix;
const renditionQuery = () => rendition ? '?subtitle=' + encodeURIComponent(rendition) : '';
if (!previewSeconds) play.hidden = true;
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
      status.textContent = 'This screening is closed to new viewers. Open your private access link to continue watching.';
    }
    checkout = attachViewerCheckout(filmId, fragment.get('attempt'), (order, watchNow) => {
      const continuing = paid && stream && (!program || program.versionBase === prefix + '/v/' + order.program?.revision);
      receipt = order.receipt;
      purchase = order.kind === 'buy';
      resumePosition = Number(order.position) || 0;
      purchaseCheckedAt = Date.now();
      if (program) {
        const member = continuing ? program.id : order.memberId;
        program.unlock(order.program, member, order.kind);
        document.getElementById('download').dataset.path = program.versionBase + '/download';
      }
      document.body.dataset.access = order.kind;
      video.classList.remove('preview-ended');
      play.textContent = program && resumePosition > 0 ? 'Continue watching' : (purchase ? (program ? 'Play program' : 'Play film') : 'Play rental');
      status.textContent = purchase ? 'Your purchase is ready.' : 'Your rental is ready.';
      if (continuing) {
        if (watchNow && video.paused) startVideo();
        return;
      }
      if (paid || stream) stopPlayback();
      play.hidden = false;
      if (watchNow) { window.scrollTo(0, 0); play.click(); }
    }, () => program?.revision);
    if (video.ended || !previewSeconds) checkout.showOffer();
  }).catch(() => {
    status.textContent = 'Checkout could not load. Refresh this player to try again.';
  });
}

function stopPlayback() {
  playbackGeneration++;
  clearTimeout(renewal);
  subtitles.clear();
  playGrant = undefined;
  const previous = stream;
  stream = undefined;
  previous?.destroy();
  video.removeAttribute('src');
  video.load();
  play.disabled = false;
}

function fail(message) {
  stopPlayback();
  videoControls.exitPictureInPicture();
  play.hidden = false;
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
  const generation = playbackGeneration;
  try {
    await video.play();
    if (generation !== playbackGeneration) return;
    play.hidden = true;
    status.textContent = '';
  } catch {
    if (generation !== playbackGeneration) return;
    play.hidden = false;
    status.textContent = 'Select ' + play.textContent + ' to watch.';
  } finally {
    if (generation === playbackGeneration) play.disabled = false;
  }
}

async function rental(resumeAt = 0, autoplay = true) {
  const generation = ++playbackGeneration;
  const media = mediaPrefix();
  try {
    if (purchase && Date.now() - purchaseCheckedAt > 30000) {
      const checked = await checkout.purchaseReceipt();
      if (generation !== playbackGeneration) return;
      receipt = checked;
      purchaseCheckedAt = Date.now();
    }
    const [response] = await Promise.all([fetch((program?.versionBase || prefix) + '/session', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: receipt, credentials: 'omit'
    }), loadLibrary()]);
    if (generation !== playbackGeneration) return;
    if (!response.ok) throw new Error(purchase ? 'This purchase is unavailable.' : 'This rental is unavailable or has expired.');
    const { grant, expiresAt, rentalExpiresAt } = await response.json();
    if (generation !== playbackGeneration) return;
    if (!window.Hls?.isSupported()) throw new Error('Open this prototype in a browser with Media Source playback.');
    stream?.destroy();
    stream = undefined;
    playGrant = grant;
    const bitmap = await subtitles.show(media, 'play', grant);
    if (generation !== playbackGeneration) return;
    rendition = bitmap;
    const base = new URL(media + '/play/', location.origin);
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
      subtitles.resume();
      play.hidden = true;
      play.disabled = false;
      status.textContent = '';
      if (autoplay) startVideo();
    });
    player.attachMedia(video);
    player.loadSource(new URL('index.m3u8' + renditionQuery(), base).href);
    clearTimeout(renewal);
    const remaining = expiresAt * 1000 - Date.now();
    if (!purchase && expiresAt === rentalExpiresAt) {
      renewal = setTimeout(() => {
        if (program) {
          document.dispatchEvent(new Event('stream-access-ended'));
          checkout?.checkAccess();
        }
        else fail('Your rental has expired.');
      }, Math.max(0, remaining));
    } else {
      renewal = setTimeout(() => rental(video.currentTime, !video.paused), Math.max(1000, remaining - 15000));
    }
  } catch (error) { if (generation === playbackGeneration) fail(error.message); }
}

function switchRendition(next) {
  if (next === rendition) return;
  rendition = next;
  const position = video.currentTime;
  const playing = !video.paused && !video.ended;
  if (paid && stream) {
    subtitles.suspend();
    rental(position, playing);
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

function newView() {
  counted = false;
  lastSave = 0;
  savedSecond = -1;
  viewId = crypto.randomUUID();
}

function navigate(id, autoplay) {
  if (!receipt || !program) return;
  const shouldPlay = autoplay ?? (!stream || !video.paused);
  if (paid && stream && id === program.id) {
    if (shouldPlay) startVideo();
    return;
  }
  stopPlayback();
  program.activate(id);
  resumePosition = 0;
  paid = true;
  rendition = '';
  newView();
  checkout.savePosition(0, mediaPrefix());
  status.textContent = 'Loading title…';
  play.hidden = true;
  rental(0, shouldPlay);
}

play.addEventListener('click', async () => {
  play.disabled = true;
  status.textContent = 'Loading…';
  if (receipt) {
    if (paid && stream) { await startVideo(); return; }
    stopPlayback();
    paid = true;
    newView();
    await rental(resumePosition);
    return;
  }
  if (!previewSeconds) return;
  newView();
  const generation = ++playbackGeneration;
  try {
    rendition = await subtitles.show(prefix, 'preview');
    if (generation !== playbackGeneration) return;
    video.src = prefix + '/preview.mp4' + renditionQuery();
    subtitles.resume();
    await startVideo();
  } catch {
    if (generation === playbackGeneration) fail('The preview could not play. Please try again.');
  }
});

function bookmark(force = false) {
  if (!paid || !counted || !stream || !checkout || !Number.isFinite(video.duration) || video.readyState < 2) return;
  if (!force && Date.now() - lastSave < 30000) return;
  const second = video.ended || video.duration - video.currentTime < 2 ? 0 : Math.floor(video.currentTime);
  if (second === savedSecond) return;
  checkout.savePosition(second, mediaPrefix());
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
  program?.lock();
  rendition = '';
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
  fetch(mediaPrefix() + '/view', { method: 'POST', headers, body: (paid ? 'paid ' : 'preview ') + viewId,
    credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
});
video.addEventListener('ended', () => {
  if (paid) {
    if (program?.advance()) return;
    resumePosition = 0;
    fail(purchase ? 'Screening complete.' : 'Rental screening complete.');
    return;
  }
  clearTimeout(renewal);
  videoControls.exitPictureInPicture();
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
