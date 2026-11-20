import { centerFrame, cropRect } from './thumbnail-frame.js';

function setupEditor(form) {
  const { url, csrf } = form.dataset;
  const file = form.querySelector('[type=file]');
  const canvas = form.querySelector('canvas');
  const framing = form.querySelector('fieldset');
  const save = form.querySelector('[type=submit]');
  const remove = form.querySelector('[data-delete]');
  const reframe = form.querySelector('[data-reframe]');
  const status = form.querySelector('[role=status]');
  const poster = form.closest('.film-thumbnail').querySelector('.thumbnail-poster');
  let { version } = form.dataset;
  let image, sequence = 0, busy = false;

  function frame() {
    return Object.fromEntries(Object.keys(centerFrame).map(name => [name, Number(form.elements[name].value)]));
  }

  function draw() {
    if (!image) return;
    const rect = cropRect(image.naturalWidth, image.naturalHeight, frame());
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  }

  function updateControls() {
    framing.hidden = !image;
    canvas.hidden = !image;
    poster.hidden = !version || Boolean(image);
    save.disabled = busy || !image;
    remove.hidden = !version;
    remove.disabled = reframe.disabled = file.disabled = busy;
    reframe.hidden = !version || Boolean(image);
    framing.disabled = busy;
  }

  async function savedSettings() {
    const response = await fetch(url + '/settings');
    if (!response.ok) throw new Error('The saved framing could not be loaded. Reload the dashboard and try again.');
    return response.json();
  }

  async function load(selected) {
    const id = ++sequence;
    let objectUrl;
    image = null;
    updateControls();
    status.textContent = 'Loading thumbnail preview…';
    try {
      let values = centerFrame;
      if (selected) {
        const supported = selected.type ? ['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) : /\.(?:jpe?g|png|webp)$/i.test(selected.name);
        if (!supported || selected.size > 8 * 1024 ** 2) throw new Error('Choose a JPEG, PNG or WebP up to 8 MB.');
      }
      if (!selected || version === 'pending') {
        const settings = await savedSettings();
        if (id !== sequence) return;
        version = settings.version || '';
        if (!selected) {
          if (!version) {
            poster.removeAttribute('src');
            throw new Error('The thumbnail was removed. Choose an image to replace it.');
          }
          values = settings.frame;
        }
      }
      const next = new Image();
      next.src = selected ? (objectUrl = URL.createObjectURL(selected)) : url + '/source.jpg?v=' + encodeURIComponent(version);
      await next.decode();
      if (id !== sequence) return;
      if (next.naturalWidth * next.naturalHeight > 48_000_000) throw new Error('Choose an image up to 48 megapixels.');
      for (const name of Object.keys(centerFrame)) form.elements[name].value = values[name];
      image = next;
      draw();
      status.textContent = '';
    } catch (error) {
      if (id === sequence) status.textContent = error instanceof DOMException ? 'This image could not be opened. Choose another image.' : error.message;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (id === sequence) updateControls();
    }
  }

  async function change(deleting) {
    if (busy) return;
    busy = true;
    sequence++;
    updateControls();
    status.textContent = deleting ? 'Deleting thumbnail…' : 'Saving thumbnail…';
    try {
      if (version === 'pending') version = (await savedSettings()).version || '';
      const response = await fetch(url, { method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', 'X-Stream-CSRF': csrf, 'X-Thumbnail-Version': version,
        'X-Thumbnail-Action': deleting ? 'delete' : 'save', 'X-Thumbnail-Frame': JSON.stringify(frame())
      }, body: deleting ? null : file.files[0] || null });
      if (!response.ok) throw new Error(await response.text());
      version = (await response.json()).version || '';
      file.value = '';
      image = null;
      if (version) poster.src = url + '/poster.jpg?v=' + encodeURIComponent(version);
      else poster.removeAttribute('src');
      const embedded = form.closest('.dashboard-film')?.querySelector('.film-sharing iframe');
      if (embedded) embedded.src = embedded.src;
      status.textContent = deleting ? 'Thumbnail deleted.' : 'Thumbnail saved.';
    } catch (error) {
      status.textContent = error instanceof TypeError ? 'The change could not be confirmed. Check your connection and try again.' : error.message;
    } finally {
      busy = false;
      updateControls();
    }
  }

  file.addEventListener('change', () => {
    if (file.files[0]) return load(file.files[0]);
    sequence++;
    image = null;
    status.textContent = '';
    updateControls();
  });
  reframe.addEventListener('click', () => { file.value = ''; load(); });
  framing.addEventListener('input', draw);
  form.addEventListener('submit', event => { event.preventDefault(); if (image) change(false); });
  remove.addEventListener('click', () => { if (window.confirm('Delete this thumbnail from the film’s R2 bucket?')) change(true); });
  if (file.files[0]) load(file.files[0]);
}

document.querySelectorAll('.thumbnail-editor').forEach(setupEditor);
