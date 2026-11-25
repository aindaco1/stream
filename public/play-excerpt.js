// The native player is also the fallback when JavaScript is unavailable.
const video = document.querySelector('.home-excerpt video');
const play = document.querySelector('[data-play-excerpt]');
video.controls = false;
play.hidden = false;
play.addEventListener('click', () => {
  play.hidden = true;
  video.controls = true;
  video.focus();
  video.play().catch(() => { /* Native controls remain available for another attempt. */ });
});
