export function attachVideoControls(video, status) {
  const stage = video.closest('.video-stage');
  const button = stage.querySelector('#picture-in-picture');
  // WebKit expands its native volume slider across the upper part of the picture.
  const docked = typeof video.webkitShowPlaybackTargetPicker === 'function';
  stage.classList.toggle('docked-tools', docked);
  const standard = typeof video.requestPictureInPicture === 'function' && typeof document.exitPictureInPicture === 'function';
  const inPip = () => standard ? document.pictureInPictureElement === video : video.webkitPresentationMode === 'picture-in-picture';
  let hideTimer;

  function showTools() {
    clearTimeout(hideTimer);
    stage.classList.remove('tools-idle');
    if (!docked && !video.paused && !video.ended) hideTimer = setTimeout(() => stage.classList.add('tools-idle'), 2400);
  }

  function updatePip() {
    const active = inPip();
    const available = standard ? document.pictureInPictureEnabled :
      typeof video.webkitSetPresentationMode === 'function' && video.webkitSupportsPresentationMode?.('picture-in-picture');
    button.hidden = !active && (!available || video.readyState < 1 || !video.videoWidth || video.ended);
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
