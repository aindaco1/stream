// Stripe's USD minimum is 50 cents; charge amounts support up to eight digits.
export function isPrice(cents) {
  return Number.isSafeInteger(cents) && cents >= 50 && cents <= 99999999;
}

export function filmPrices(value) {
  if (value === undefined) return Object.freeze({ rent: 99, buy: null });
  if (!value || ![value.rent, value.buy].every(price => price === null || isPrice(price))) return null;
  return Object.freeze({ rent: value.rent, buy: value.buy });
}

export function usdInput(cents) {
  return isPrice(cents) ? (cents / 100).toFixed(2) : '';
}

export function priceFromInput(value) {
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (!input) return null;
  const decimal = /^(\d{0,6})(?:\.(\d{1,2}))?$/.exec(input);
  if (!decimal) return undefined;
  const cents = Number(decimal[1]) * 100 + Number((decimal[2] ?? '').padEnd(2, '0'));
  return isPrice(cents) ? cents : undefined;
}
