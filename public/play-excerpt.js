import { currency, displayOfferPrices, offerAmounts, rentalLength } from './offer-display.js';

const byId = id => document.getElementById(id);
const video = document.querySelector('video');
const preview = byId('play');
const stage = byId('start-video');
const offers = byId('purchase');
const payment = byId('payment');
const seeOffers = byId('example-offers');
const hours = Number(document.body.dataset.rentalHours);
const kinds = ['rent', 'buy'];
let selected;
// The example ends at an order summary, before any payment details.
document.querySelector('.payment-action').hidden = true;

function showOffers() {
  seeOffers.hidden = true;
  offers.hidden = false;
  displayOfferPrices(kinds, false, false);
  byId('terms').textContent = 'Rent for ' + rentalLength(hours) + ' from payment. Buy to watch and download.';
}

function playPreview() {
  video.controls = true;
  stage.hidden = true;
  video.play().catch(() => { byId('status').textContent = 'Select Play to try the preview again.'; });
}
video.controls = false;
stage.hidden = false;
stage.addEventListener('click', playPreview);
preview.addEventListener('click', playPreview);
video.addEventListener('play', () => { preview.hidden = true; byId('status').textContent = ''; });
video.addEventListener('ended', () => {
  preview.textContent = 'Replay preview';
  preview.hidden = false;
  byId('status').textContent = 'Preview complete.';
  showOffers();
});
seeOffers.hidden = false;
seeOffers.addEventListener('click', event => {
  showOffers();
  byId('rent').focus({ preventScroll: event.detail > 0 });
});
byId('tip-percent').addEventListener('input', () => displayOfferPrices(kinds, false, false));
for (const kind of kinds) byId(kind).addEventListener('click', () => {
  selected = kind;
  video.pause();
  const { price, tip, total } = offerAmounts(kind);
  const money = cents => currency.format(cents / 100);
  byId('order-terms').textContent = kind === 'rent' ? 'Example rental · ' + rentalLength(hours) : 'Example purchase · Watch and download';
  byId('order-price').textContent = money(total);
  byId('order-tip').hidden = false;
  byId('order-tip').textContent = 'Film ' + money(price) + ' + optional tip to Stream ' + money(tip) + '. Before any applicable tax.';
  byId('payment-feedback').textContent = kind === 'rent'
    ? 'This is a demonstration. In a published player, paying here starts the rental and unlocks the full film.'
    : 'This is a demonstration. In a published player, paying here unlocks the full film and its download.';
  byId('status').textContent = '';
  payment.hidden = false;
  document.body.classList.add('paying');
  byId('checkout-heading').focus({preventScroll: true});
});
byId('close-checkout').addEventListener('click', () => {
  document.body.classList.remove('paying');
  payment.hidden = true;
  byId(selected).focus({preventScroll: true});
});

// This first-party example can fit its host page as offers appear. Published
// embeds on other sites keep the filmmaker's chosen dimensions.
const frame = window.frameElement;
if (frame) {
  const main = document.querySelector('main');
  const figure = frame.closest('.home-excerpt');
  const lead = figure?.closest('.home-lead');
  let lastWidth;
  let sectionHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(main.getBoundingClientRect().height) + 2;
    frame.height = String(height);
    if (!lead) return;
    // Keep document scrolling stable on desktop while the iframe fits each view.
    const box = figure.getBoundingClientRect();
    const openingPoster = !stage.hidden && !seeOffers.hidden;
    sectionHeight = openingPoster || box.width !== lastWidth ? box.height : Math.max(sectionHeight, box.height);
    lastWidth = box.width;
    lead.style.setProperty('--demo-section-height', sectionHeight + 'px');
    // Only the opening poster sets the adjacent introduction's position.
    if (openingPoster) {
      const inset = frame.getBoundingClientRect().top - box.top;
      lead.style.setProperty('--opening-poster-inset', inset + 'px');
      lead.style.setProperty('--opening-poster-height', height + 'px');
    }
  }).observe(main);
}
