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
  const webkit = typeof video.webkitShowPlaybackTargetPicker === 'function';
  const remote = video.remote;
  const picker = webkit || typeof remote?.prompt === 'function';
  const supported = picker && Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  let active, enabled = false, prompting = false;

  // Each player lives in its own iframe. Use its existing private rental link
  // if this browser or its receivers cannot offer a direct handoff.
  const doc = video.ownerDocument;
  const access = doc?.getElementById('access-tools');
  function canHandoff() {
    return access && !access.hidden && Boolean(doc.getElementById('access-link')?.value);
  }
  function showHandoff() {
    if (!canHandoff()) {
      status.textContent = 'This browser could not find a compatible TV.';
      return;
    }
    const details = access.querySelector('details');
    doc.getElementById('tv-help').hidden = false;
    details.open = true;
    doc.getElementById('copy-link').focus();
  }
  if (!webkit) {
    button.setAttribute('aria-label', 'Play on TV');
    button.setAttribute('title', 'Play on TV');
  }
  function update() {
    button.hidden = !enabled || (!active && !canHandoff());
    const connected = webkit ? video.webkitCurrentPlaybackTargetIsWireless : remote?.state === 'connected';
    button.setAttribute('aria-pressed', String(Boolean(enabled && connected)));
  }
  function setRentalActive(value) {
    enabled = value;
    update();
  }
  button.addEventListener('click', async () => {
    if (!enabled || prompting) return;
    if (!active) return showHandoff();
    const current = active;
    prompting = true;
    try {
      // Invoke directly within the click to preserve the user gesture.
      if (webkit) video.webkitShowPlaybackTargetPicker();
      else await remote.prompt();
    } catch (error) {
      if (!enabled || active !== current) return;
      if (['NotAllowedError','AbortError'].includes(error.name)) {
        if (canHandoff()) status.textContent = 'For AirPlay, open your private rental link in Safari under “Watch on another device”.';
      } else showHandoff();
    } finally { prompting = false; }
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', update);
  remote?.addEventListener('connect', update);
  remote?.addEventListener('disconnect', update);

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
      if (active === player) { active = undefined; setRentalActive(false); }
      clearTimeout(expiry);
      selection?.abort();
      life.abort();
      video.preload = previousPreload;
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
    setRentalActive(true);
    return player;
  }
  return { supported, open, setRentalActive };
}
