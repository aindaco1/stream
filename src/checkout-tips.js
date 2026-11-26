import { calculatePlatformTip } from '@dustwave/worker-core/platform-tip';
import { isPrice } from './prices.js';

export function tipFor(filmAmount, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 15) return null;
  if (filmAmount === 0) return 0;
  if (!isPrice(filmAmount)) return null;
  const cents = calculatePlatformTip(filmAmount, percent);
  return isPrice(filmAmount + cents) ? cents : null;
}

export function orderTotal(order) {
  return order.amount + order.tipAmount;
}

// Direct-charge fees are itemized on the connected account's charge balance
// transaction. A delayed transaction or foreign settlement currency has no
// verified USD processing-fee figure yet.
export function processingFee(order, charge, total = orderTotal(order), applicationFee = order.tipAmount) {
  const tx = charge.balance_transaction;
  if (!tx || typeof tx === 'string' || tx.currency !== 'usd') return null;
  if (tx.object !== 'balance_transaction' || !/^txn_[a-zA-Z0-9]+$/.test(tx.id) ||
      !['charge','payment'].includes(tx.type) || tx.source !== charge.id || tx.amount !== total ||
      !Number.isSafeInteger(tx.fee) || tx.fee < 0 || tx.net !== tx.amount - tx.fee ||
      !['available','pending'].includes(tx.status)) throw new Error('The Stripe balance transaction did not match its charge.');
  if (!Array.isArray(tx.fee_details)) return null;
  let application = 0, processing = 0;
  for (const fee of tx.fee_details) {
    if (fee.currency !== 'usd' || !Number.isSafeInteger(fee.amount) || fee.amount < 0) return null;
    // Withholding on a platform charge may belong to Stream’s operator. Hold it for review
    // before allocating a fee to the filmmaker's transfer.
    if (order.taxPolicy === 'marketplace-v1' && fee.type === 'withheld_tax' && fee.amount) return null;
    if (fee.type === 'application_fee') application += fee.amount;
    else if (['stripe_fee','payment_method_passthrough_fee','tax','withheld_tax'].includes(fee.type) && !fee.application) processing += fee.amount;
    else return null;
  }
  return application === applicationFee && processing + application === tx.fee ? processing : null;
}

// The tip already includes its tax. The rest of the viewer's charge belongs to
// the film line. Round the film share once and leave the remainder on the tip.
export function filmTaxFeeShare(fee, charged, tip) {
  if (![fee, charged, tip].every(n => Number.isSafeInteger(n) && n >= 0) ||
      charged === 0 || tip > charged || fee > charged) throw new RangeError('Invalid tax fee allocation.');
  const denominator = BigInt(charged);
  return Number((2n * BigInt(fee) * BigInt(charged - tip) + denominator) / (2n * denominator));
}
