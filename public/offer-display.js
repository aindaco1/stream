import { calculatePlatformTip } from './platform-tip.js';

export const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const rentalLength = hours => hours + (hours === 1 ? ' hour' : ' hours');

export function offerAmounts(kind) {
  const price = Number(document.body.dataset[kind]);
  const tip = calculatePlatformTip(price, Number(document.getElementById('tip-percent').value));
  return { price, tip, total: price + tip };
}

export function displayOfferPrices(available, program, disabled) {
  const tip = document.getElementById('tip-percent');
  document.getElementById('tip-value').textContent = tip.value + '%';
  tip.setAttribute('aria-valuetext', tip.value + ' percent');
  for (const kind of ['rent', 'buy']) {
    const button = document.getElementById(kind);
    button.hidden = !available.includes(kind);
    if (button.hidden) continue;
    const action = kind === 'buy' ? 'Buy' : 'Rent';
    button.textContent = action + (program ? ' program' : '') + ' · ' + currency.format(offerAmounts(kind).total / 100);
    button.disabled = disabled;
  }
}
