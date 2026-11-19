import { execFileSync } from 'node:child_process';

// Read the clock overlay on a *presented* frame. A displayed playhead alone
// cannot detect incorrect segment decoding after a discontinuous seek.
export const sampleFrame = function (goal) {
  const video = document.querySelector('video');
  window.streamSample = null;
  const take = (_, frame) => {
    if (frame.mediaTime < goal - 0.1 || frame.mediaTime > goal + 7) {
      video.requestVideoFrameCallback(take);
      return;
    }
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const bytes = ctx.getImageData(92, 60, 196, 60).data;
    let mask = '';
    for (let y = 0; y < 60; y += 2)
      for (let x = 0; x < 196; x += 2) {
        const i = (y * 196 + x) * 4;
        mask += bytes[i] > 180 && bytes[i + 1] > 180 && bytes[i + 2] > 180 ? '1' : '0';
      }
    window.streamSample = { mediaTime: frame.mediaTime, presentedFrames: frame.presentedFrames, mask };
  };
  video.requestVideoFrameCallback(take);
  video.currentTime = goal;
  video.play().catch(() => {});
};
export function referenceMismatch(file, sample, fps) {
  // Check adjacent source frames to allow WebKit's compositor to advance one
  // frame between rVFC and canvas readback.
  const t = Math.max(0, (Math.round(sample.mediaTime * fps) - 1) / fps - 0.0001);
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      t.toFixed(5),
      '-i',
      file,
      '-an',
      '-frames:v',
      '3',
      '-vf',
      'crop=196:60:92:60',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 160_000 },
  );
  const size = 196 * 60 * 3;
  let min = 1;
  for (let start = 0; start + size <= bytes.length; start += size) {
    let p = 0,
      mismatches = 0;
    for (let y = 0; y < 60; y += 2)
      for (let x = 0; x < 196; x += 2) {
        const i = start + (y * 196 + x) * 3;
        const bit = bytes[i] > 180 && bytes[i + 1] > 180 && bytes[i + 2] > 180 ? '1' : '0';
        if (bit !== sample.mask[p++]) mismatches++;
      }
    min = Math.min(min, mismatches / p);
  }
  return min;
}
