import { escapeHtml } from './film-embed.js';
import { centerFrame } from './thumbnail-frame.js';
import { thumbnailScope } from './thumbnails.js';

export function thumbnailEditor(film, saved, csrf) {
  const { bucket, accountId, host, key } = thumbnailScope(film);
  const url = '/setup/thumbnail/' + film.id;
  const frame = saved?.frame || centerFrame;
  const controls = [['x', 'Horizontal position', 0, 100], ['y', 'Vertical position', 0, 100], ['zoom', 'Zoom', 100, 200]]
    .map(([name, label, min, max]) => `<label>${label}<input type="range" name="${name}" min="${min}" max="${max}" value="${frame[name]}"></label>`).join('');
  return `<h1>Film thumbnail</h1><p>${escapeHtml(film.title)}</p>
    <form class="thumbnail-editor" data-account="${accountId}" data-bucket="${escapeHtml(bucket)}" data-host="${host}" data-key="${key}"
      data-version="${saved?.version || ''}" data-csrf="${csrf}" data-url="${url}">
      <noscript>Enable JavaScript to preview and save a thumbnail.</noscript>
      <label>${saved ? 'Replace image' : 'Choose an image'}<input type="file" accept="image/jpeg,image/png,image/webp"></label>
      <p class="hint">JPEG, PNG or WebP, up to 8 MB. Adjust the 16:9 frame that viewers see before playback.</p>
      <fieldset class="thumbnail-framing"${saved ? '' : ' hidden'}><legend>Framing</legend>
        <canvas width="640" height="360" aria-label="Thumbnail crop preview"></canvas><div class="thumbnail-sliders">${controls}</div></fieldset>
      <details class="thumbnail-auth" open><summary>Authorize thumbnail changes</summary>
        <p>In <a href="https://dash.cloudflare.com/${accountId}/r2/api-tokens" target="_blank" rel="noopener">Cloudflare R2 API tokens</a>, create or reuse an <strong>Object Read &amp; Write</strong> token limited to <strong>${escapeHtml(bucket)}</strong>. Enter its key pair below.</p>
        <p class="hint">Your browser uses the key to authorize this film’s thumbnail for one hour in this tab.</p>
        <label>Access Key ID<input type="password" data-key-id autocomplete="off" maxlength="32"></label>
        <label>Secret Access Key<input type="password" data-key-secret autocomplete="off" maxlength="64"></label>
      </details>
      <div class="film-actions"><button type="submit" disabled>Save thumbnail</button>
      ${saved ? '<button type="button" class="secondary" data-delete>Delete thumbnail</button>' : ''}
      <a href="/setup/dashboard#${film.id}">Back to film</a></div><p role="status" aria-live="polite"></p>
    </form><script type="module" src="/setup/thumbnail.js"></script>`;
}
