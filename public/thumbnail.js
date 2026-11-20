import { centerFrame, cropRect } from './thumbnail-frame.js';
import { thumbnailGrant } from './thumbnail-grant.js';

const form = document.querySelector('.thumbnail-editor');
const { url, version, csrf } = form.dataset;
const file = form.querySelector('[type=file]');
const canvas = form.querySelector('canvas');
const framing = form.querySelector('fieldset');
const save = form.querySelector('[type=submit]');
const remove = form.querySelector('[data-delete]');
const auth = form.querySelector('.thumbnail-auth');
const keyId = form.querySelector('[data-key-id]'), secret = form.querySelector('[data-key-secret]');
const status = form.querySelector('[role=status]');
const slot = 'stream.thumbnail.' + form.dataset.key;
let grant, image, sequence = 0, saving = false;
try { grant = JSON.parse(sessionStorage.getItem(slot)); } catch {}
if (grant?.expires > Date.now() / 1000) auth.open = false;

function frame() { return Object.fromEntries(Object.keys(centerFrame).map(name => [name, Number(form.elements[name].value)])); }
function draw() {
  if (!image) return;
  const rect = cropRect(image.naturalWidth, image.naturalHeight, frame());
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#181818';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
}
async function load(fileImage) {
  const id = ++sequence;
  save.disabled = true;
  image = null;
  framing.hidden = true;
  if (!fileImage && !version) return;
  const src = fileImage ? URL.createObjectURL(fileImage) : url + '/source.jpg';
  try {
    if (fileImage && (fileImage.size > 8 * 1024 ** 2 || !['image/jpeg', 'image/png', 'image/webp'].includes(fileImage.type))) {
      throw new Error('Choose a JPEG, PNG or WebP up to 8 MB.');
    }
    const next = new Image();
    next.src = src;
    await next.decode();
    if (id !== sequence) return;
    if (fileImage && next.naturalWidth * next.naturalHeight > 48_000_000) throw new Error('Choose an image up to 48 megapixels.');
    for (const [name, initial] of Object.entries(centerFrame)) form.elements[name].value = fileImage ? initial : form.elements[name].defaultValue;
    image = next;
    draw();
    framing.hidden = false;
    save.disabled = false;
    status.textContent = '';
  } catch (error) {
    if (id === sequence) status.textContent = error instanceof DOMException ? 'This image could not be opened. Choose another image.' : error.message;
  } finally { if (fileImage) URL.revokeObjectURL(src); }
}
async function change(deleting) {
  if (saving) return;
  saving = true;
  save.disabled = true;
  if (remove) remove.disabled = true;
  try {
    if (keyId.value || secret.value || !(grant?.expires > Date.now() / 1000)) {
      auth.open = true;
      if (!keyId.value || !secret.value) { (keyId.value ? secret : keyId).focus(); throw new Error('Enter the Cloudflare key pair to authorize this thumbnail.'); }
      grant = await thumbnailGrant(form.dataset, keyId.value.trim(), secret.value.trim());
      keyId.value = secret.value = '';
    }
    status.textContent = deleting ? 'Deleting thumbnail…' : 'Saving thumbnail…';
    const response = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/octet-stream', 'X-Stream-CSRF': csrf, 'X-Thumbnail-Version': version,
      'X-Thumbnail-Grant': grant.jwt, 'X-Thumbnail-Action': deleting ? 'delete' : 'save', 'X-Thumbnail-Frame': JSON.stringify(frame())
    }, body: deleting ? null : file.files[0] || null });
    if (!response.ok) {
      if (response.status === 403) {
        grant = null;
        try { sessionStorage.removeItem(slot); } catch {}
        auth.open = true;
      }
      throw new Error(await response.text());
    }
    try { sessionStorage.setItem(slot, JSON.stringify(grant)); } catch {}
    location.assign('/setup/dashboard#thumbnail-' + url.split('/').pop());
  } catch (error) { status.textContent = error.message; }
  finally { saving = false; save.disabled = !image; if (remove) remove.disabled = false; }
}
file.addEventListener('change', () => load(file.files[0]));
framing.addEventListener('input', draw);
form.addEventListener('submit', event => { event.preventDefault(); if (image) change(false); });
remove?.addEventListener('click', () => { if (window.confirm('Delete this thumbnail from the film’s R2 bucket?')) change(true); });
if (file.files[0] || version) load(file.files[0]);
