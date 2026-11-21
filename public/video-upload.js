const form = document.querySelector('[data-film-form]');
if (form?.querySelector('[data-video]')) mountUpload(form);

if (form?.querySelector('[data-bucket-picker]')) mountFilePicker(form);

function mountFilePicker(form) {
  const picker = form.querySelector('[data-bucket-picker]');
  const select = form.elements.objectKey;
  const status = picker.querySelector('[data-file-status]');
  const allFiles = picker.querySelector('[data-all-files]');
  const more = picker.querySelector('[data-more-files]');
  const preview = picker.querySelector('[data-preview-file]');
  const video = picker.querySelector('[data-file-preview]');
  const local = form.querySelector('[data-video]');
  let cursor = '', loaded = false, listing = false, previewRequest, clip;
  async function request(action, fields, signal) {
    const response = await fetch('/setup/bucket/' + action, { method:'POST', signal, headers:{
      'X-Stream-CSRF':form.elements.csrf.value, 'X-Draft-Id':form.elements.draftId.value,
      'X-Active-Bucket':form.elements.activeBucket.value
    }, body:new URLSearchParams(fields) });
    if (!response.ok) throw new Error(await response.text());
    return response;
  }
  async function list() {
    if (listing) return;
    listing = true;
    status.textContent = 'Loading files…';
    allFiles.disabled = more.disabled = true;
    try {
      const result = await (await request('files', {cursor, all:allFiles.checked ? 'yes' : 'no'})).json();
      const options = new Map([...select.options].map(option => [option.value, option]));
      for (const { key, title, bytes, other } of result.files) {
        const mb = (bytes / 1000000).toLocaleString(undefined, {maximumFractionDigits:1});
        const name = title ? title + ' · ' + key : key;
        const label = name + ' (' + mb + ' MB)';
        const existing = options.get(key);
        const option = existing || new Option(label, key);
        option.textContent = label;
        if (other) option.dataset.other = 'true';
        if (!existing) select.add(option);
      }
      loaded = true;
      cursor = result.next;
      more.hidden = !cursor;
      more.textContent = 'Load more files';
      status.textContent = '';
      if (select.options.length === 1) {
        const empty = allFiles.checked ? 'No files up to 10 GB found in this bucket.' :
          'No MP4, MOV or MKV files found. Choose Show all files to see other names.';
        status.textContent = cursor ? 'More files are available to check.' : empty;
      }
    } catch (e) {
      more.hidden = false;
      more.textContent = 'Retry file list';
      status.textContent = e.message;
    } finally { listing = false; allFiles.disabled = more.disabled = false; }
  }
  function clearPreview() {
    previewRequest?.abort();
    previewRequest = undefined;
    preview.disabled = false;
    video.hidden = true;
    if (clip) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(clip);
      clip = undefined;
    }
  }
  select.addEventListener('change', () => {
    clearPreview();
    status.textContent = '';
    preview.hidden = !select.value;
    if (local && select.value) local.value = '';
  });
  local?.addEventListener('change', () => {
    if (local.files.length) { select.value = ''; clearPreview(); preview.hidden = true; }
  });
  preview.addEventListener('click', async () => {
    clearPreview();
    const controller = new AbortController();
    previewRequest = controller;
    preview.disabled = true;
    status.textContent = 'Preparing a short preview…';
    try {
      const response = await request('preview', {key:select.value}, controller.signal);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      clip = URL.createObjectURL(blob);
      video.src = clip;
      video.hidden = false;
      status.textContent = '';
      await video.play().catch(() => {}); // Native controls remain available when autoplay requires another tap.
    } catch (e) { if (!controller.signal.aborted) status.textContent = e.message; }
    finally { if (previewRequest === controller) preview.disabled = false; }
  });
  allFiles.addEventListener('change', () => {
    const selection = select.selectedOptions[0];
    const keep = selection?.value && (allFiles.checked || !selection.dataset.other);
    select.replaceChildren(select.options[0], ...(keep ? [selection] : []));
    if (keep) select.value = selection.value;
    else select.dispatchEvent(new Event('change'));
    loaded = false;
    cursor = '';
    list();
  });
  more.addEventListener('click', list);
  picker.addEventListener('toggle', () => { if (picker.open && !loaded) list(); });
  if (picker.open) list();
}

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
    fileInput.disabled = form.elements.objectKey.disabled = working;
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
    const extension = /\.(mp4|mov|mkv)$/i.exec(file.name)?.[1].toLowerCase();
    if (file.size < 1 || file.size > 10_000_000_000 || !extension) {
      status.textContent = 'Choose an MP4, MOV or MKV up to 10 GB.'; return;
    }
    if (selected !== file) { selected = file; fileId = crypto.randomUUID(); }
    controls(true);
    stop = false;
    let finished = false;
    try {
      await initial;
      status.textContent = 'Starting video upload…';
      current = await request('start', {}, new URLSearchParams({ fileId, size: String(file.size), extension }));
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
      const select = form.elements.objectKey;
      if (![...select.options].some(option => option.value === current.objectKey)) select.add(new Option(file.name, current.objectKey));
      select.value = current.objectKey;
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
