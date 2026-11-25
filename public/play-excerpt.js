import { stripeScript } from './stripe-script.js';
import { currency, displayOfferPrices, offerAmounts, rentalLength } from './offer-display.js';

const byId = id => document.getElementById(id);
const video = document.querySelector('video');
const preview = byId('play');
const stage = byId('start-video');
const offers = byId('purchase');
const payment = byId('payment');
const seeOffers = byId('example-offers');
const frame = window.frameElement;
const figure = frame?.closest('.home-excerpt');
const hours = Number(document.body.dataset.rentalHours);
const kinds = ['rent', 'buy'];
let selected;
let generation = 0;
let card;
let unlocked = false;
const feedback = byId('payment-feedback');
const originalPreview = video.getAttribute('src');
feedback.setAttribute('role', 'status');

function showOffers() {
  document.body.setAttribute('data-interacting', '');
  figure?.setAttribute('data-interacting', '');
  seeOffers.hidden = true;
  offers.hidden = false;
  displayOfferPrices(kinds, false, false);
  byId('terms').textContent = 'Rent for ' + rentalLength(hours) + ' from payment. Buy to watch and download.';
}

function playFilm() {
  video.controls = true;
  stage.hidden = true;
  video.play().catch(() => { byId('status').textContent = 'Select Play to try again.'; });
}
video.controls = false;
stage.hidden = false;
stage.addEventListener('click', playFilm);
preview.addEventListener('click', playFilm);
video.addEventListener('play', () => { preview.hidden = true; byId('status').textContent = ''; });
video.addEventListener('ended', () => {
  preview.textContent = unlocked ? 'Replay the film' : 'Replay preview';
  preview.hidden = false;
  if (unlocked) return;
  byId('status').textContent = 'Preview complete.';
  showOffers();
});
seeOffers.addEventListener('click', event => {
  if (unlocked) {
    unlocked = false;
    video.src = originalPreview;
    video.controls = false;
    stage.hidden = false;
    preview.textContent = 'Play 10-second preview';
    preview.hidden = false;
    byId('ownership').hidden = true;
    byId('status').textContent = '';
  }
  showOffers();
  byId('rent').focus({ preventScroll: event.detail > 0 });
});
seeOffers.disabled = false;
byId('tip-percent').addEventListener('input', () => displayOfferPrices(kinds, false, false));
function closePayment() {
  generation++;
  card?.destroy();
  card = undefined;
  document.body.classList.remove('paying');
  payment.hidden = true;
}

function finishOrder(kind) {
  closePayment();
  unlocked = true;
  offers.hidden = true;
  video.src = location.pathname + '/film.mp4';
  video.controls = true;
  stage.hidden = false;
  preview.textContent = 'Watch the full film';
  preview.hidden = false;
  seeOffers.textContent = 'Try another test checkout';
  seeOffers.hidden = false;
  byId('ownership').hidden = kind !== 'buy';
  byId('status').textContent = kind === 'buy'
    ? 'Test purchase complete. You can watch or download the film.'
    : 'Test rental complete. A viewer’s 48 hours start at payment. You can now watch the full film.';
  preview.focus({preventScroll: true});
}

async function startCheckout(kind) {
  const run = ++generation;
  selected = kind;
  video.pause();
  const { price, tip, total } = offerAmounts(kind);
  const money = cents => currency.format(cents / 100);
  byId('order-terms').textContent = kind === 'rent' ? 'Example rental · ' + rentalLength(hours) : 'Example purchase · Watch and download';
  byId('order-price').textContent = money(total);
  byId('order-tip').hidden = false;
  byId('order-tip').textContent = 'Film ' + money(price) + ' + optional tip to Stream ' + money(tip) + '.';
  feedback.textContent = 'Opening Stripe test checkout…';
  byId('status').textContent = '';
  payment.hidden = false;
  document.body.classList.add('paying');
  byId('checkout-heading').focus({preventScroll: true});
  try {
    const params = new URLSearchParams({offer: kind, tip: byId('tip-percent').value});
    const response = await fetch(location.pathname + '/checkout?' + params, {
      method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (response.status === 429) {
      if (run === generation) feedback.textContent = 'Several test checkouts just opened. Go back and try again in a minute.';
      return;
    }
    if (!response.ok) throw Error();
    const order = await response.json();
    if (run !== generation) return;
    if (!order.publishableKey?.startsWith('pk_test_') || !order.clientSecret?.startsWith('cs_test_') || order.amount !== total) throw Error();
    const [, { createCardForm }] = await Promise.all([stripeScript(), import('./payment.js')]);
    if (run !== generation) return;
    feedback.innerHTML = '<p><strong>Try a test payment.</strong> Use only the test card <strong>4242 4242 4242 4242</strong>. Enter <strong>12/34</strong> for expiry, <strong>123</strong> for CVC and <strong>10001</strong> if asked for a ZIP.</p>';
    const stripe = window.Stripe(order.publishableKey);
    card = createCardForm(stripe, { ...order, demo: true }, () => {}, () => finishOrder(kind), undefined,
      () => { feedback.textContent = 'Confirmation was interrupted. Go back to the film and try another test checkout.'; });
    await card.mount();
  } catch {
    if (run !== generation) return;
    card?.destroy();
    card = undefined;
    feedback.textContent = 'The Stripe test fields could not load. Go back to the film and open the offer to try again.';
  }
}

document.querySelector('.payment-credit').textContent = 'Stripe test mode · No money moves';
for (const kind of kinds) byId(kind).addEventListener('click', () => startCheckout(kind));
byId('close-checkout').addEventListener('click', () => {
  closePayment();
  byId(selected).focus({preventScroll: true});
});

// This first-party example can fit its host page as offers appear. Published
// embeds on other sites keep the filmmaker's chosen dimensions.
if (frame) {
  const main = document.querySelector('main');
  const lead = figure?.closest('.home-lead');
  let lastWidth;
  let sectionHeight = 0;
  new ResizeObserver(() => {
    if (figure?.hasAttribute('data-interacting')) frame.height = String(Math.ceil(main.getBoundingClientRect().height) + 2);
    if (!lead) return;
    // After interaction, reserve space outside the player while its offers change height.
    const box = figure.getBoundingClientRect();
    sectionHeight = !figure.hasAttribute('data-interacting') || box.width !== lastWidth ? box.height : Math.max(sectionHeight, box.height);
    lastWidth = box.width;
    lead.style.setProperty('--demo-section-height', sectionHeight + 'px');
  }).observe(main);
}
