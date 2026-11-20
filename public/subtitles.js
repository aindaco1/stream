// The browser renders WebVTT and its native fullscreen captions menu. Paid
// requests use an Authorization header; track elements see only local blob URLs.
export function attachSubtitles(video, prefix, setRendition) {
  const control = document.getElementById('subtitle-control');
  const select = document.getElementById('subtitles');
  const status = document.getElementById('subtitle-status');
  let scope, grant, selected = '', request, suspended = false;
  let placeholder;
  const entries = new Map();

  function clear() {
    request?.abort();
    request = undefined;
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
    scope = grant = undefined;
  }

  function read(path) {
    return fetch(prefix + '/' + scope + '/subtitles' + path, {
      headers: grant ? { Authorization: 'Bearer ' + grant } : {}, signal: request.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
    });
  }

  async function choose(id) {
    selected = id;
    select.value = id;
    status.textContent = '';
    for (const [key, { element }] of entries) {
      element.default = key === id;
      element.track.mode = key === id ? 'showing' : 'disabled';
    }
    const entry = entries.get(id);
    setRendition(entry?.format === 'bitmap' ? id : '');
    if (!entry || entry.format === 'bitmap' || entry.url || entry.loading) return;
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

  select.addEventListener('change', () => choose(select.value));
  video.textTracks.addEventListener('change', () => {
    if (!entries.size || suspended || video.readyState < 2) return;
    const active = [...entries].find(([, entry]) => entry.element.track.mode === 'showing')?.[0] || '';
    // Safari temporarily disables a track while its URL changes or its media
    // rendition attaches. An explicit selection must survive that transition.
    const current = entries.get(selected);
    if (!active && current && (current.loading || current.element.readyState !== HTMLTrackElement.LOADED || video.seeking)) return;
    if (active !== selected) choose(active);
  });

  async function show(nextScope, nextGrant) {
    if (scope === nextScope && grant === nextGrant) return;
    clear();
    scope = nextScope;
    grant = nextGrant;
    const controller = request = new AbortController();
    try {
      const response = await read('');
      if (!response.ok) throw Error();
      const tracks = await response.json();
      if (request !== controller) return;
      if (tracks.length) placeholder = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
      for (const { id, label, language, kind, format } of tracks) {
        const element = document.createElement('track');
        element.kind = kind === 'captions' ? 'captions' : 'subtitles';
        element.label = label;
        if (language) element.srclang = language;
        // A native caption-menu entry also lets fullscreen viewers select a
        // picture track. Its actual images arrive in the alternate video.
        element.src = placeholder;
        element.addEventListener('load', () => {
          if (selected === id && entries.get(id)?.element === element) element.track.mode = 'showing';
        });
        entries.set(id, { element, format });
        select.add(new Option(label, id));
        video.append(element);
      }
      control.hidden = !entries.size;
      choose(entries.has(selected) ? selected : '');
      suspended = false;
    } catch {
      if (request === controller) clear();
    }
  }
  return { show, clear, suspend() { suspended = true; }, resume() { choose(selected); suspended = false; } };
}
