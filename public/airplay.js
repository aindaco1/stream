// The receiver fetches this same-origin HLS URL directly. It never receives the viewer's receipt.
export async function requestAirPlayLease(prefix, receipt, rentalEnd) {
  try {
    const response = await fetch(prefix + '/airplay', {
      method: 'POST', headers: { 'Content-Type':'text/plain' }, body:receipt,
      credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer',
      signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) return;
    const { path, expiresAt } = await response.json();
    const base = prefix + '/airplay/';
    if (typeof path !== 'string' || !path.startsWith(base) ||
        !/^[A-Za-z0-9_-]{43}\/index\.m3u8$/.test(path.slice(base.length)) ||
        !Number.isSafeInteger(rentalEnd) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()/1000 || expiresAt > rentalEnd) return;
    return {path, expiresAt};
  } catch { /* Local playback still works if a receiver lease cannot be issued. */ }
}

export function attachAirPlay(video, status) {
  const button = video.closest('.video-stage').querySelector('#airplay');
  const supported = typeof video.webkitShowPlaybackTargetPicker === 'function' &&
    Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  let active;

  function update() {
    button.hidden = !active;
    button.setAttribute('aria-pressed', String(Boolean(active && video.webkitCurrentPlaybackTargetIsWireless)));
  }
  button.addEventListener('click', () => {
    if (!active) return;
    // WebKit requires a direct user gesture. Discovery and lease issuance happen before this click.
    try { video.webkitShowPlaybackTargetPicker(); }
    catch { status.textContent = 'AirPlay could not open. Try the AirPlay control in Safari’s video player.'; }
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', update);

  function open(lease, { caption, position, autoplay, ready, retry, expire }) {
    const life = new AbortController();
    let selection;
    let expiry;
    let lastPosition = position;
    let wantsPlay = autoplay;
    const previousPreload = video.preload;

    function selectAirPlaySubtitle(id, resumeAt, play) {
      selection?.abort();
      selection = new AbortController();
      lastPosition = resumeAt;
      wantsPlay = play;
      video.addEventListener('loadedmetadata', () => {
        if (resumeAt > 0) video.currentTime = Math.min(resumeAt, video.duration || resumeAt);
        ready(play);
      }, {once:true, signal:selection.signal});
      video.src = lease.path + (id ? '?subtitle=' + encodeURIComponent(id) : '');
      video.load();
    }
    function checkEnd() {
      const remaining = lease.expiresAt * 1000 - Date.now();
      if (remaining <= 0) expire();
      else expiry = setTimeout(checkEnd, Math.min(remaining, 2147483647));
    }
    const player = {selectAirPlaySubtitle, destroy() {
      if (active === player) active = undefined;
      clearTimeout(expiry);
      selection?.abort();
      life.abort();
      video.preload = previousPreload;
      update();
    }};
    active = player;
    video.disableRemotePlayback = false;
    video.preload = 'metadata';
    video.addEventListener('timeupdate', () => {
      if (video.readyState >= 2 && !video.error) lastPosition = video.currentTime;
    }, {signal:life.signal});
    video.addEventListener('play', () => { wantsPlay = true; }, {signal:life.signal});
    video.addEventListener('pause', () => {
      if (!video.error && video.readyState >= 2) wantsPlay = false;
    }, {signal:life.signal});
    video.addEventListener('error', () => {
      if (video.error) retry(lastPosition, wantsPlay);
    }, {signal:life.signal, once:true});
    selectAirPlaySubtitle(caption, position, autoplay);
    expiry = setTimeout(checkEnd, 0);
    update();
    return player;
  }
  return { supported, open };
}
