import { calculatePlatformTip } from '@dustwave/worker-core/platform-tip';
import { isPrice } from './prices.js';

export function tipFor(filmAmount, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 15 || !isPrice(filmAmount)) return null;
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
    // Withholding on a platform charge may belong to Dust Wave. Hold it for review
    // before allocating a fee to the filmmaker's transfer.
    if (order.taxPolicy === 'marketplace-v1' && fee.type === 'withheld_tax' && fee.amount) return null;
    if (fee.type === 'application_fee') application += fee.amount;
    else if (['stripe_fee','payment_method_passthrough_fee','tax','withheld_tax'].includes(fee.type) && !fee.application) processing += fee.amount;
    else return null;
  }
  return application === applicationFee && processing + application === tx.fee ? processing : null;
}
