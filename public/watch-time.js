// Report a cumulative clock so late or repeated requests can be merged safely.
export function trackWatchTime(video, now = () => performance.now()) {
  let report, previous, elapsed = 0, lastSent = -1;
  function mark() {
    previous = {time:now(), position:video.currentTime, rate:video.playbackRate};
  }
  function sample() {
    if (!report || !previous || video.seeking) return;
    const start = previous;
    mark();
    // A seek must never add the skipped footage. At 2×, two film seconds
    // represent one second spent watching. A stationary playhead adds nothing.
    const played = (previous.position - start.position) / start.rate;
    if (Number.isFinite(played)) elapsed += Math.max(0, Math.min(played, (previous.time - start.time) / 1000));
  }
  function flush() {
    const seconds = Math.min(86400, Math.floor(elapsed));
    if (report && seconds > lastSent) {
      lastSent = seconds;
      report(seconds);
    }
  }
  function suspend() {
    sample();
    previous = undefined;
    flush();
  }
  video.addEventListener('playing', () => { if (report) mark(); });
  video.addEventListener('timeupdate', () => {
    sample();
    if (elapsed - lastSent >= 30) flush();
  });
  for (const event of ['pause', 'ended', 'waiting']) video.addEventListener(event, suspend);
  video.addEventListener('ratechange', sample);
  for (const event of ['seeking','emptied']) {
    video.addEventListener(event, () => { previous = undefined; flush(); });
  }
  return {
    start(send) {
      report = send;
      elapsed = 0;
      lastSent = -1;
      mark();
      flush();
    },
    flush() { sample(); flush(); },
    stop() { suspend(); report = undefined; }
  };
}
