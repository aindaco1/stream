// The circled information button follows the field-label pattern in Pool and Store.
const fieldHelp = {
  rentPrice: 'What a viewer pays to stream for a limited time. Enter at least $0.50, or leave it blank to offer purchases only.',
  rentalHours: 'How long a rental lasts from the moment the viewer pays. Start with 48 hours for a weekend screening. You can choose 1 to 720 hours.',
  previewSeconds: 'How much viewers can watch for free before checkout. Try 10 seconds to start, or 0 to show the price right away. The limit is 180 seconds or one second less than the preview video, whichever is shorter.',
  screenerWatermark: 'Turn this on for a private screener to show a brief, anonymous rental code each minute. Leave it off for a clean picture.',
  synopsis: 'Give viewers a sense of the story. One or two sentences usually fit well beside the player.',
  byline: 'Enter the name or names to print after “A film by.” Leave this blank if the director is already listed in Credits.',
  curator: 'Enter the name or names to print after “Curated by” on the program poster. Each film keeps its own director credit.',
  poster: 'Choose Midnight Marquee for a dark theatrical poster or Festival Broadside for bold type on paper. The style applies to this embed.',
  message: 'Add a personal note that appears in italics. A short introduction or thank-you works well.',
  thumbnail: 'Choose the image viewers see before playback. A 1920 × 1080 landscape JPEG, PNG or WebP up to 8 MB works well.',
  x: 'Slide left or right to keep your subject in the frame. Start in the center.',
  y: 'Slide up or down to keep faces and titles in view. Start in the center.',
  zoom: 'Start at 100% to show as much of the image as possible. Increase the zoom for a tighter crop.',
  embedCode: 'Copy this code into an HTML or embed block on your website. It includes the display options you chose here.',
  objectKey: 'Choose a video already in your connected bucket. Stream uses that file directly, so you can skip uploading it again.',
  allFiles: 'Turn this on if your file is missing from the list. Stream usually shows filenames ending in .mp4, .mov or .mkv.',
  video: 'Choose the finished video from your device. For broad playback compatibility, use an MP4 with H.264 video and stereo AAC audio. The file can be up to 10 GB.',
  opening: 'Choose a video to play before the first film, such as a welcome from the director. Leave this at None to start with the first film.',
  closing: 'Choose a video to play after the last film, such as a Q&A or closing credits. Leave this at None to end with the last film.',
  openingTitle: 'The name viewers see for the opening video in this lineup. Keep its original title or give it a short name such as “Welcome.”',
  closingTitle: 'The name viewers see for the closing video in this lineup. Keep its original title or give it a short name such as “After the screening.”',
  member: 'Check to include this film in the program. Choose at least two films. Use the arrows or drag your selections into screening order.',
  previewFilmId: 'Choose the video viewers can sample before they pay. The default uses the first main film. The free preview starts at the beginning of the selected video.',
  bucketUrl: 'Open your private film bucket in the Cloudflare dashboard and copy the address from your browser. Stream uses it to fill in the account, bucket and jurisdiction.',
  accountId: 'Identifies the Cloudflare account that owns your bucket. Use “Copy account ID” in the Cloudflare dashboard to get the 32-character value.',
  bucket: 'Enter the exact name of your private R2 bucket. A dedicated bucket keeps the key’s access limited to files you use with Stream.',
  jurisdiction: 'Choose the jurisdiction set when you created the bucket. Leave Default selected unless you specifically chose another one.',
  tokenValue: 'Paste the token value Cloudflare shows after you create an R2 token. Choose Object Read & Write and limit it to your one private film bucket.',
  accessKeyId: 'Paste the Access Key ID from your R2 token’s access key pair. It identifies the key that goes with the secret in the next field.',
  secretAccessKey: 'Paste the matching Secret Access Key from Cloudflare. Store a copy in your password manager when Cloudflare displays it.',
  privateConfirmed: 'In Cloudflare, check that public access is off and the token is limited to this bucket. Select this box once you have checked both settings.',
  uploadConsent: 'Lets Stream save the encrypted key so you can upload films and manage thumbnails from the Dashboard on any device.'
};

function explanation(control) {
  const program = Boolean(control.closest('.program-editor, .film-sharing[data-program]'));
  switch (control.name) {
    case 'title': return program ? 'The name viewers see above the lineup and at checkout. Choose one title for the whole screening.' :
      'The title viewers see for this video. Use its screening title so people can recognize it in the player or lineup.';
    case 'buyPrice': return (program ? 'One payment lets a viewer watch the program and download the original videos together as a ZIP.' :
      'One payment lets a viewer watch the film and download the original file.') + ' Enter at least $0.50, or leave it blank to offer rentals only.';
    case 'rightsAccepted': return program ? 'Confirm you have permission to offer every video in this lineup under the prices and viewing options you chose.' :
      'Confirm you own the video or have permission to distribute it before you upload or choose the file.';
    case 'include': {
      if (control.value === 'byline') return program ? 'Show the program curator and each film’s director when a name has been entered.' : 'Show the director credit above the film title.';
      const content = {synopsis:'synopsis', credits:'credits', message:'personal note'}[control.value];
      return 'Include ' + (program ? 'each film’s ' : 'the film’s ') + content + ' in this embed wherever that text has been saved. Each embed can use different choices.';
    }
  }
  if (control.name.startsWith('main-')) return fieldHelp.member;
  if (control.matches('[data-video]')) return fieldHelp.video;
  if (control.matches('[data-all-files]')) return fieldHelp.allFiles;
  if (control.matches('.thumbnail-editor [type=file]')) return fieldHelp.thumbnail;
  if (control.matches('.embed-code')) return fieldHelp.embedCode;
  return fieldHelp[control.name];
}

let sequence = 0;
function helpButton(name, text, control, id = 'field-help-' + ++sequence) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-button';
  button.setAttribute('aria-describedby', id);
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4m0-4v.01"/></svg>';
  const caption = document.createElement('span');
  caption.className = 'info-caption';
  caption.textContent = 'Help for ' + name;
  button.append(caption);
  const tip = document.createElement('span');
  tip.id = id;
  tip.className = 'info-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  tip.hidden = true;
  document.body.append(tip);
  if (control) {
    const existing = control.getAttribute('aria-describedby');
    control.setAttribute('aria-describedby', [existing, id].filter(Boolean).join(' '));
  }
  return button;
}

for (const metric of document.querySelectorAll('[data-field-help]')) {
  const label = metric.textContent.trim();
  const lastSpace = label.lastIndexOf(' ') + 1;
  const end = document.createElement('span');
  end.className = 'metric-label-end';
  end.append(label.slice(lastSpace), helpButton(label, metric.dataset.fieldHelp, null, metric.dataset.helpId));
  metric.replaceChildren(label.slice(0,lastSpace), end);
}
for (const control of document.querySelectorAll('main input:not([type=hidden]), main select, main textarea')) {
  const text = explanation(control);
  const label = control.labels?.[0];
  if (!text || !label) continue;
  const heading = document.createElement('div');
  heading.className = 'help-heading';
  label.before(heading);
  if (label.contains(control) && control.type !== 'checkbox') {
    // Preserve the actual control, its listeners, and any trailing help. Keep the
    // info button outside the label so it never activates the field or file picker.
    const field = document.createElement('div');
    field.className = 'help-field';
    heading.replaceWith(field);
    field.append(heading);
    while (control.nextSibling) field.append(control.nextSibling);
    heading.after(control);
    if (!control.id) control.id = 'help-input-' + (sequence + 1);
    label.htmlFor = control.id;
  }
  heading.append(label);
  heading.append(helpButton(label.textContent.trim(), text, control));
}

let active, bubble, pinned, closeTimer;
function close() {
  clearTimeout(closeTimer);
  if (!active) return;
  active.setAttribute('aria-expanded', 'false');
  bubble.hidden = true;
  active = bubble = null;
  pinned = false;
}
function position() {
  if (!active) return;
  const anchor = active.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = window.innerHeight;
  if (!anchor.width || anchor.bottom < 0 || anchor.top > height) return close();
  const box = bubble.getBoundingClientRect();
  bubble.style.left = Math.max(8, Math.min(anchor.left, width - box.width - 8)) + 'px';
  const below = height - anchor.bottom;
  const top = below >= box.height + 8 || below >= anchor.top ? anchor.bottom + 2 : anchor.top - box.height - 2;
  bubble.style.top = Math.max(4, Math.min(top, height - box.height - 4)) + 'px';
}
function open(button) {
  clearTimeout(closeTimer);
  if (active === button) return;
  close();
  active = button;
  bubble = document.getElementById(button.getAttribute('aria-describedby'));
  bubble.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  position();
}
const trigger = target => target.closest?.('.info-button');
document.addEventListener('pointerover', event => {
  if (event.pointerType === 'touch') return;
  if (bubble?.contains(event.target)) clearTimeout(closeTimer);
  const button = trigger(event.target);
  if (button && !pinned) open(button);
});
document.addEventListener('pointerout', event => {
  if (!active || pinned || event.pointerType === 'touch' || active.matches(':focus-visible')) return;
  if (active.contains(event.target) || bubble.contains(event.target)) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 150);
  }
});
document.addEventListener('focusin', event => {
  const button = trigger(event.target);
  if (button?.matches(':focus-visible')) open(button);
  else if (active !== button) close();
});
document.addEventListener('focusout', event => {
  if (active && active === event.target && !bubble.contains(event.relatedTarget)) close();
});
document.addEventListener('click', event => {
  const button = trigger(event.target);
  if (button && active === button && pinned) close();
  else if (button) { open(button); pinned = true; }
  else if (!bubble?.contains(event.target)) close();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
window.addEventListener('resize', position);
document.addEventListener('scroll', position, {capture:true, passive:true});
