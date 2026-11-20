const form = document.querySelector('[data-film-form]');
if (form?.querySelector('[data-video]')) mountUpload(form);

function mountUpload(form) {
  const fileInput = form.querySelector('[data-video]');
  const status = form.querySelector('[data-upload-status]');
  const meter = form.querySelector('[data-upload-progress]');
  const cancel = form.querySelector('[data-cancel-upload]');
  const submitters = [...form.querySelectorAll('button[type=submit]')];
  let selected, fileId, current, busy = false, stop = false;

  async function request(action, extra = {}, body) {
    const response = await fetch('/setup/upload/' + action, { method: 'POST', headers: {
      'X-Stream-CSRF': form.elements.csrf.value, 'X-Draft-Id': form.elements.draftId.value,
      ...(current ? { 'X-Upload-Id': current.uploadId } : {}), ...extra
    }, body });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  function controls(working) {
    busy = working;
    fileInput.disabled = working;
    for (const button of submitters) button.disabled = working;
    cancel.disabled = stop;
    cancel.hidden = !current || current.complete;
  }
  function report() {
    if (!current || current.complete) return;
    cancel.hidden = false;
    status.textContent = 'An upload is unfinished. Retry with the selected video, or discard the unfinished upload.';
  }
  const initial = request('status').then(saved => { current = saved; report(); }).catch(e => { status.textContent = e.message; });
  cancel.addEventListener('click', async () => {
    if (!current) return;
    if (busy) { stop = true; cancel.disabled = true; status.textContent = 'Stopping after the current part…'; return; }
    controls(true);
    try {
      await request('cancel');
      current = null;
      meter.hidden = true;
      status.textContent = 'Unfinished upload discarded.';
    } catch (e) { status.textContent = e.message; }
    finally { controls(false); }
  });
  form.addEventListener('submit', async event => {
    const file = fileInput.files[0];
    if (!file || busy) { if (busy) event.preventDefault(); return; }
    event.preventDefault();
    const submitter = event.submitter;
    if (file.size < 1 || file.size > 1024 ** 3 || !/\.mp4$/i.test(file.name)) {
      status.textContent = 'Choose an MP4 up to 1 GiB.'; return;
    }
    if (selected !== file) { selected = file; fileId = crypto.randomUUID(); }
    controls(true);
    stop = false;
    let finished = false;
    try {
      await initial;
      status.textContent = 'Starting video upload…';
      current = await request('start', {}, new URLSearchParams({ fileId, size: String(file.size) }));
      controls(true);
      meter.hidden = false;
      meter.max = file.size;
      meter.value = Math.min(file.size, (current.nextPart - 1) * current.partSize);
      while (!stop && !current.complete && meter.value < file.size) {
        const n = current.nextPart;
        const start = (n - 1) * current.partSize;
        status.textContent = 'Uploading video · ' + Math.floor(100 * start / file.size) + '%';
        const part = file.slice(start, start + current.partSize);
        current = await request('part', { 'Content-Type': 'application/octet-stream', 'X-Part-Number': String(n) }, part);
        meter.value = Math.min(file.size, start + part.size);
      }
      if (stop && !current.complete) {
        await request('cancel');
        current = null;
        meter.hidden = true;
        status.textContent = 'Unfinished upload discarded.';
        return;
      }
      cancel.disabled = true;
      if (!current.complete) current = await request('complete');
      form.elements.objectKey.value = current.objectKey;
      fileInput.value = '';
      status.textContent = 'Video uploaded. Checking the film…';
      finished = true;
    } catch (e) {
      const message = e.message;
      try { current = await request('status'); } catch {}
      status.textContent = message + ' You can retry from this form.';
    } finally { stop = false; controls(false); }
    if (finished) form.requestSubmit(submitter || undefined);
  });
}
