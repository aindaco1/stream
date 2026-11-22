// U.S. platform, full Stripe accounts, separate charges and transfers.
// Iceland is in the EEA, but Stripe rejects Stream's merchant configuration there.
// https://docs.stripe.com/connect/connect-cross-border-payouts
export const stripeBusinessCountries = Object.freeze(
  'AT BE BG CA CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IT LI LT LU LV MT NL NO PL PT RO SE SI SK US'.split(' ')
);

const names = new Intl.DisplayNames(['en'], { type: 'region' });
export const payoutCountryOptions = stripeBusinessCountries
  .map(code => ({ code, label: names.of(code) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'));
