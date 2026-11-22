// Track IDs belong to an individual media file. Carry the viewer's language and
// accessibility preference across a program, including titles without that track.
export function matchingCaption(tracks, preference, source) {
  if (!preference) return;
  if (source === preference.source) {
    const original = tracks.find(track => track.id === preference.id);
    if (original) return original;
  }
  const language = tag => {
    try { return new Intl.Locale(tag).baseName.toLowerCase(); } catch { return 'und'; }
  };
  const wanted = language(preference.language);
  let best, highest = -1;
  for (const track of tracks) {
    const lang = language(track.language);
    if (lang.split('-')[0] !== wanted.split('-')[0]) continue;
    // With no language metadata, a generated stream number is not a language match.
    if (wanted === 'und' && (!preference.label || track.label !== preference.label ||
        /^Subtitle track \d+$/.test(track.label))) continue;
    if (!preference.forced && track.forced) continue;
    let score = lang === wanted ? 8 : 0;
    if (track.label === preference.label) score += 4;
    if (track.kind === preference.kind) score += 2;
    if (Boolean(track.forced) === Boolean(preference.forced)) score++;
    if (score > highest) { highest = score; best = track; }
  }
  return best;
}

// Native fullscreen and the inline menu operate on the same text tracks. Paid
// tracks use an Authorization header; native track elements receive only blob URLs.
export function attachSubtitles(video, setRendition) {
  const control = document.getElementById('subtitle-control');
  const select = document.getElementById('subtitles');
  const status = document.getElementById('subtitle-status');
  let source, scope, grant, selected = '', preference, request, suspended = false;
  let placeholder, receiverPath = '';
  // WebKit renders text from the receiver's HLS playlist. Chromium also needs
  // a local text track while playing that same receiver-ready stream.
  const playlistText = () => receiverPath && typeof video.webkitShowPlaybackTargetPicker === 'function';
  const entries = new Map();

  // Safari can leave the chosen HLS subtitle disabled when system captions are off.
  function showReceiverText() {
    if (!playlistText() || entries.get(selected)?.track.format !== 'text') return;
    for (const track of video.textTracks) {
      if (track.kind === 'subtitles') track.mode = 'showing';
    }
  }
  video.textTracks.addEventListener('addtrack', showReceiverText);
  video.addEventListener('loadedmetadata', showReceiverText);

  function clear() {
    request?.abort();
    request = undefined;
    suspended = true;
    for (const { element, url } of entries.values()) {
      element?.remove();
      if (url) URL.revokeObjectURL(url);
    }
    entries.clear();
    if (placeholder) URL.revokeObjectURL(placeholder);
    placeholder = undefined;
    select.replaceChildren(new Option('Off', ''));
    control.hidden = true;
    status.textContent = '';
    selected = '';
    scope = grant = source = undefined;
  }

  function read(id) {
    const receiverTrack = receiverPath && id;
    const url = receiverTrack
      ? new URL('captions.vtt?subtitle=' + encodeURIComponent(id), new URL(receiverPath, location.origin))
      : source + '/' + scope + '/subtitles' + (id ? '/' + encodeURIComponent(id) + '.vtt' : '');
    return fetch(url, {
      headers: grant && !receiverTrack ? { Authorization: 'Bearer ' + grant } : {}, signal: request.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
    });
  }

  async function choose(id, fromViewer = false) {
    const entry = entries.get(id);
    if (fromViewer) preference = entry && { ...entry.track, source };
    selected = id;
    select.value = id;
    status.textContent = '';
    if (playlistText()) {
      if (fromViewer) setRendition(id);
      return;
    }
    for (const [key, { element }] of entries) {
      element.default = key === id;
      element.track.mode = key === id ? 'showing' : 'disabled';
    }
    if (fromViewer) setRendition(receiverPath || entry?.track.format === 'bitmap' ? id : '');
    if (!entry || entry.track.format === 'bitmap' || entry.url || entry.loading) return;
    entry.loading = true;
    try {
      const response = await read(id);
      if (!response.ok) throw Error();
      const blob = await response.blob();
      if (entries.get(id) !== entry) return;
      entry.url = URL.createObjectURL(blob);
      entry.element.src = entry.url;
      entry.element.track.mode = selected === id ? 'showing' : 'disabled';
    } catch {
      if (entries.get(id) === entry && selected === id) {
        choose('');
        status.textContent = 'Subtitles could not load. Choose the track again to retry.';
      }
    } finally { entry.loading = false; }
  }

  select.addEventListener('change', () => choose(select.value, true));
  video.textTracks.addEventListener('change', () => {
    if (playlistText() || !entries.size || suspended || video.readyState < 2) return;
    const active = [...entries].find(([, entry]) => entry.element.track.mode === 'showing')?.[0] || '';
    const current = entries.get(selected);
    if (!active && current && (current.loading || current.element.readyState !== HTMLTrackElement.LOADED || video.seeking)) return;
    if (active !== selected) choose(active, true);
  });

  async function show(prefix, nextScope, nextGrant, nextReceiverPath = '') {
    if (source === prefix && scope === nextScope && grant === nextGrant && nextReceiverPath === receiverPath)
      return receiverPath || entries.get(selected)?.track.format === 'bitmap' ? selected : '';
    clear();
    receiverPath = nextReceiverPath;
    source = prefix;
    scope = nextScope;
    grant = nextGrant;
    const controller = request = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await read('');
      if (!response.ok) throw Error();
      const tracks = await response.json();
      if (request !== controller) return '';
      if (tracks.length && !playlistText()) placeholder = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
      for (const track of tracks) {
        const {id, label, language, kind} = track;
        select.add(new Option(label, id));
        // Receiver-side HLS supplies the chosen text track or captioned video itself.
        if (playlistText()) { entries.set(id, {track}); continue; }
        const element = document.createElement('track');
        element.kind = kind === 'captions' ? 'captions' : 'subtitles';
        element.label = label;
        if (language) element.srclang = language;
        element.src = placeholder;
        element.addEventListener('load', () => {
          if (selected === id && entries.get(id)?.element === element) element.track.mode = 'showing';
        });
        entries.set(id, { element, track });
        video.append(element);
      }
      control.hidden = !entries.size;
      const match = matchingCaption(tracks, preference, source);
      choose(match?.id || '');
      if (preference && !match) status.textContent = 'Your selected captions are unavailable for this title.';
      return match && (receiverPath || match.format === 'bitmap') ? match.id : '';
    } catch {
      if (request === controller) clear();
      return '';
    } finally { clearTimeout(timeout); }
  }
  return { show, clear, suspend() { suspended = true; }, resume() {
    const entry = entries.get(selected);
    if (playlistText()) {
      for (const track of video.textTracks) {
        if (track.kind === 'subtitles' || track.kind === 'captions')
          track.mode = entry && entry.track.format !== 'bitmap' ? 'showing' : 'disabled';
      }
    } else if (entry) entry.element.track.mode = 'showing';
    suspended = false;
  } };
}
