export function attachVideoControls(video, status) {
  const stage = video.closest('.video-stage');
  const button = stage.querySelector('#picture-in-picture');
  const safari = typeof video.webkitShowPlaybackTargetPicker === 'function';
  if (safari) {
    stage.classList.add('safari-controls');
    const tools = stage.querySelector('.video-tools');
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
    // Touch controls use a speaker. Desktop WebKit expands its 135px slider
    // when both the picture and its native corner controls have room.
    function layout() {
      const { width, height } = video.getBoundingClientRect();
      const expanded = finePointer.matches && width >= 265 && height >= 136;
      const volumeSpace = expanded ? 200 : 60;
      stage.classList.toggle('compact-volume', !expanded);
      stage.classList.toggle('wrapped-tools', width < 92 + tools.offsetWidth + volumeSpace);
    }
    const observer = new ResizeObserver(layout);
    observer.observe(video);
    observer.observe(tools);
    finePointer.addEventListener('change', layout);
  }
  const standard = typeof video.requestPictureInPicture === 'function' && typeof document.exitPictureInPicture === 'function';
  const inPip = () => standard ? document.pictureInPictureElement === video : video.webkitPresentationMode === 'picture-in-picture';
  let hideTimer;

  function showTools() {
    clearTimeout(hideTimer);
    stage.classList.remove('tools-idle');
    if (!video.paused && !video.ended) hideTimer = setTimeout(() => stage.classList.add('tools-idle'), 2400);
  }

  function updatePip() {
    const active = inPip();
    const available = standard ? document.pictureInPictureEnabled :
      typeof video.webkitSetPresentationMode === 'function' && video.webkitSupportsPresentationMode?.('picture-in-picture');
    button.hidden = safari || !active && (!available || video.readyState < 1 || !video.videoWidth || video.ended);
    button.setAttribute('aria-pressed', String(active));
  }

  async function exitPictureInPicture() {
    if (!inPip()) return;
    try {
      if (standard) await document.exitPictureInPicture();
      else video.webkitSetPresentationMode('inline');
    } catch { /* The system may have already closed its picture-in-picture window. */ }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (inPip()) await exitPictureInPicture();
      else if (standard) await video.requestPictureInPicture();
      else video.webkitSetPresentationMode('picture-in-picture');
    } catch { status.textContent = 'Picture-in-picture could not open in this browser.'; }
    finally { button.disabled = false; updatePip(); }
  });
  for (const event of ['loadedmetadata','resize','emptied','ended','play','enterpictureinpicture','leavepictureinpicture','webkitpresentationmodechanged']) {
    video.addEventListener(event, updatePip);
  }
  for (const event of ['pointermove','pointerdown','focusin']) stage.addEventListener(event, showTools);
  for (const event of ['playing','pause','ended','emptied']) video.addEventListener(event, showTools);
  updatePip();
  return { exitPictureInPicture };
}
