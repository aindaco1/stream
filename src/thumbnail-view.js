import { escapeHtml } from './film-embed.js';
import { centerFrame } from './thumbnail-frame.js';

export function thumbnailEditor(film, csrf) {
  const id = encodeURIComponent(film.id);
  const url = '/setup/thumbnail/' + id;
  const version = escapeHtml(film.thumbnail || '');
  const poster = `<img class="thumbnail-poster" width="224" height="126" alt="Saved thumbnail for ${escapeHtml(film.title)}"
    ${version ? `src="${url}/poster.jpg" loading="lazy"` : 'hidden'}>`;
  const controls = [['x', 'Horizontal position', 0, 100], ['y', 'Vertical position', 0, 100], ['zoom', 'Zoom', 100, 200]]
    .map(([name, label, min, max]) => `<label>${label}<input type="range" name="${name}" min="${min}" max="${max}" value="${centerFrame[name]}"></label>`).join('');
  return `<section class="film-thumbnail" id="thumbnail-${id}"><h4>Thumbnail</h4>${poster}
    ${film.uploads ? `<form class="thumbnail-editor" aria-label="Thumbnail for ${escapeHtml(film.title)}"
      data-version="${version}" data-csrf="${escapeHtml(csrf)}" data-url="${url}">
      <noscript>Enable JavaScript to preview and save a thumbnail.</noscript>
      <label>Thumbnail image<input type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="thumbnail-help-${id}"></label>
      <p class="hint" id="thumbnail-help-${id}">Choose a JPEG, PNG or WebP up to 8 MB. Recommended size is 1920 × 1080 pixels.</p>
      <button type="button" class="secondary" data-reframe${version ? '' : ' hidden'}>Adjust saved framing</button>
      <fieldset class="thumbnail-framing" hidden><legend>Preview and framing</legend>
        <canvas width="640" height="360" aria-label="Thumbnail preview in the player’s 16:9 frame"></canvas>
        <div class="thumbnail-sliders">${controls}</div></fieldset>
      <div class="film-actions"><button type="submit" disabled>Save thumbnail</button>
        <button type="button" class="secondary" data-delete${version ? '' : ' hidden'}>Delete thumbnail</button></div>
      <p role="status"></p></form>` : `<a href="/setup/r2/uploads/${id}">Enable uploads for this bucket</a>`}
    </section>`;
}
