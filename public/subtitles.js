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
  let placeholder;
  const entries = new Map();

  function clear() {
    request?.abort();
    request = undefined;
    suspended = true;
    for (const { element, url } of entries.values()) {
      element.remove();
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

  function read(path) {
    return fetch(source + '/' + scope + '/subtitles' + path, {
      headers: grant ? { Authorization: 'Bearer ' + grant } : {}, signal: request.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
    });
  }

  async function choose(id, fromViewer = false) {
    const entry = entries.get(id);
    if (fromViewer) preference = entry && { ...entry.track, source };
    selected = id;
    select.value = id;
    status.textContent = '';
    for (const [key, { element }] of entries) {
      element.default = key === id;
      element.track.mode = key === id ? 'showing' : 'disabled';
    }
    if (fromViewer) setRendition(entry?.track.format === 'bitmap' ? id : '');
    if (!entry || entry.track.format === 'bitmap' || entry.url || entry.loading) return;
    entry.loading = true;
    try {
      const response = await read('/' + encodeURIComponent(id) + '.vtt');
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
    if (!entries.size || suspended || video.readyState < 2) return;
    const active = [...entries].find(([, entry]) => entry.element.track.mode === 'showing')?.[0] || '';
    const current = entries.get(selected);
    if (!active && current && (current.loading || current.element.readyState !== HTMLTrackElement.LOADED || video.seeking)) return;
    if (active !== selected) choose(active, true);
  });

  async function show(prefix, nextScope, nextGrant) {
    if (source === prefix && scope === nextScope && grant === nextGrant)
      return entries.get(selected)?.track.format === 'bitmap' ? selected : '';
    clear();
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
      if (tracks.length) placeholder = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
      for (const track of tracks) {
        const {id, label, language, kind} = track;
        const element = document.createElement('track');
        element.kind = kind === 'captions' ? 'captions' : 'subtitles';
        element.label = label;
        if (language) element.srclang = language;
        element.src = placeholder;
        element.addEventListener('load', () => {
          if (selected === id && entries.get(id)?.element === element) element.track.mode = 'showing';
        });
        entries.set(id, { element, track });
        select.add(new Option(label, id));
        video.append(element);
      }
      control.hidden = !entries.size;
      const match = matchingCaption(tracks, preference, source);
      choose(match?.id || '');
      if (preference && !match) status.textContent = 'Your selected captions are unavailable for this title.';
      return match?.format === 'bitmap' ? match.id : '';
    } catch {
      if (request === controller) clear();
      return '';
    } finally { clearTimeout(timeout); }
  }
  return { show, clear, suspend() { suspended = true; }, resume() {
    const entry = entries.get(selected);
    if (entry) entry.element.track.mode = 'showing';
    suspended = false;
  } };
}
