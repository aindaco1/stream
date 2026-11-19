const video = document.querySelector('video');
const play = document.querySelector('#play');
const status = document.querySelector('#status');
const filmId = location.pathname.split('/')[2] || 'clock';
const prefix = '/film/' + encodeURIComponent(filmId);
const receipt = new URLSearchParams(location.hash.slice(1)).get('receipt');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let stream;
let renewal;
let library;
let paid = false;
if (receipt) play.textContent = 'Play rental';

function fail(message) {
  clearTimeout(renewal);
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
      reject(new Error('The rental player could not load. Select Play rental to try again.'));
    };
    document.head.appendChild(script);
  });
  return library;
}

async function rental(resumeAt = 0, autoplay = true) {
  const [response] = await Promise.all([fetch(prefix + '/session', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: receipt, credentials: 'omit'
  }), loadLibrary()]);
  if (!response.ok) throw new Error('This rental is unavailable or has expired.');
  const { grant, expiresAt, rentalExpiresAt } = await response.json();
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
    if (event.fatal && stream === player) fail('Playback stopped. Select Play rental to try again.');
  });
  player.on(window.Hls.Events.MANIFEST_PARSED, () => {
    play.hidden = true;
    play.disabled = false;
    status.textContent = '';
    if (autoplay) video.play().catch(() => { status.textContent = 'Press play on the video to continue.'; });
  });
  player.attachMedia(video);
  player.loadSource(new URL('index.m3u8', base).href);
  // Reattach with a new grant and encryption key while preserving the viewer's position.
  clearTimeout(renewal);
  const remaining = expiresAt * 1000 - Date.now();
  if (expiresAt === rentalExpiresAt) {
    renewal = setTimeout(() => fail('Your rental has expired.'), Math.max(0, remaining));
  } else {
    renewal = setTimeout(() => {
      rental(video.currentTime, !video.paused).catch(error => fail(error.message));
    }, Math.max(1000, remaining - 15000));
  }
}

play.addEventListener('click', async () => {
  play.disabled = true;
  status.textContent = 'Loading…';
  try {
    if (receipt) {
      paid = true;
      await rental();
    } else {
      video.src = prefix + '/preview.mp4';
      await video.play();
      play.hidden = true;
      play.disabled = false;
      status.textContent = '';
    }
  } catch (error) {
    fail(receipt ? error.message : 'The preview could not play. Please try again.');
  }
});

video.addEventListener('ended', () => {
  if (paid) {
    fail('Rental screening complete.');
    return;
  }
  clearTimeout(renewal);
  play.hidden = false;
  status.textContent = 'Preview complete. A rental unlocks the full film.';
});
