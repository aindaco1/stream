// Stripe's USD minimum is 50 cents; charge amounts support up to eight digits.
export function isPrice(cents) {
  return Number.isSafeInteger(cents) && cents >= 50 && cents <= 99999999;
}

export function rentalHours(value = 48) {
  return Number.isInteger(value) && value >= 1 && value <= 720 ? value : null;
}

const MAX_PREVIEW_SECONDS = 180;

export function maxPreviewSeconds(duration) {
  if (duration === undefined) return MAX_PREVIEW_SECONDS;
  return Number.isFinite(duration) ? Math.max(0, Math.min(MAX_PREVIEW_SECONDS, Math.floor(duration) - 1)) : 0;
}

export function previewSeconds(value = 10) {
  return Number.isInteger(value) && value >= 0 && value <= maxPreviewSeconds() ? value : null;
}

// Older offers could leave less than a full second at the end of a fractional runtime.
export function savedPreviewSeconds(value, duration) {
  const seconds = previewSeconds(value);
  return seconds === null ? null : Math.min(seconds, maxPreviewSeconds(duration));
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
