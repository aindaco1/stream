import { readBoundedJson } from '@dustwave/worker-core/response-body';

// Freeze product classifications per order. Changing this schedule needs a new policy version.
export const MARKETPLACE_POLICY = 'marketplace-v1';
export const isMarketplace = order => order.taxPolicy === MARKETPLACE_POLICY;
export function marketplaceEnabled(env) {
  const mode = env.STREAM_STRIPE_TAX_MODE ?? (env.STRIPE_PLATFORM_WEBHOOK_SECRET ? 'marketplace' : 'off');
  if (!['marketplace','off'].includes(mode)) throw Error('Invalid STREAM_STRIPE_TAX_MODE.');
  return mode === 'marketplace';
}

const taxCodes = { rent: 'txcd_10402000', buy: 'txcd_10804003', tip: 'txcd_20030000' };
const cents = value => Number.isSafeInteger(value) && value >= 0;
export const transferGroup = order => 'stream-' + order.orderId;

export function checkoutItems(order) {
  function item(kind, amount, name, description) {
    const product = { name, ...(description && { description }) };
    const price = { currency: 'usd', unit_amount: amount, product_data: product };
    if (isMarketplace(order)) {
      price.tax_behavior = kind === 'tip' ? 'inclusive' : 'exclusive';
      product.tax_code = taxCodes[kind];
    }
    return { quantity: 1, price_data: price };
  }
  const film = item(order.kind, order.amount, order.title, order.kind === 'rent' ?
    order.rentalHours + '-hour streaming rental, starting at purchase.' : 'One-time purchase with original file download.');
  return order.tipAmount ? [film, item('tip', order.tipAmount, 'Optional tip to Dust Wave')] : [film];
}

export function matchesMarketplaceSession(session, order) {
  const base = order.amount + order.tipAmount;
  const tax = session.automatic_tax;
  if (!tax?.enabled || tax.liability?.type !== 'self' || session.total_details?.amount_discount !== 0 ||
      (session.total_details?.amount_shipping ?? 0) !== 0) return false;
  // Until the billing address is complete, Checkout can return provisional amounts.
  if (tax.status !== 'complete') return session.payment_status === 'unpaid';
  const taxCents = session.total_details.amount_tax;
  if (!cents(session.amount_total) || !cents(taxCents) || !cents(session.amount_subtotal)) return false;
  const included = base + taxCents - session.amount_total;
  return cents(included) && included <= Math.min(order.tipAmount, taxCents) &&
    (session.amount_subtotal === base || session.amount_subtotal === base - included);
}

// A platform-scoped API call is authenticated by the configured sandbox key. Never pass a seller header.
async function platformRequest(key, path, fetchImpl, form, idempotencyKey, version = 'v1') {
  const response = await fetchImpl('https://api.stripe.com/' + version + '/' + path, {
    method: form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': '2026-10-28.endive',
      ...(form && { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey }) },
    ...(form && { body: new URLSearchParams(form) })
  });
  if (!response.ok) {
    const problem = await readBoundedJson(response, 16384).catch(() => null);
    const error = Error('Stripe marketplace reconciliation unavailable.');
    error.recipientRejected = response.status === 400 && problem?.error?.code === 'insufficient_capabilities_for_transfer';
    throw error;
  }
  return readBoundedJson(response, 256 * 1024);
}

// Verify both prices and both tax behaviors against this order before issuing access or transferring funds.
export async function verifiedTax(key, order, session, fetchImpl) {
  const data = await platformRequest(key, 'checkout/sessions/' + session.id + '/line_items?limit=3&expand[]=data.price.product', fetchImpl);
  const expected = checkoutItems(order);
  if (data.object !== 'list' || data.has_more !== false || data.data?.length !== expected.length) throw Error('Unexpected checkout items.');
  let taxCents = 0, tipTaxCents = 0, chargedTotalCents = 0;
  const seen = new Set();
  for (const line of data.data) {
    const spec = expected.find(item => item.price_data.product_data.tax_code === line.price?.product?.tax_code)?.price_data;
    if (!spec || seen.has(spec) || line.quantity !== 1 || line.currency !== 'usd' || line.price.currency !== 'usd' ||
        line.price.unit_amount !== spec.unit_amount || line.price.tax_behavior !== spec.tax_behavior ||
        line.amount_discount !== 0 || !cents(line.amount_tax) || !cents(line.amount_total)) throw Error('Checkout line does not match the offer.');
    seen.add(spec);
    const included = spec.tax_behavior === 'inclusive';
    if (line.amount_total !== spec.unit_amount + (included ? 0 : line.amount_tax) ||
        (included && line.amount_tax > spec.unit_amount)) throw Error('Unexpected checkout tax.');
    if (included) tipTaxCents = line.amount_tax;
    taxCents += line.amount_tax;
    chargedTotalCents += line.amount_total;
  }
  if (session.automatic_tax?.status !== 'complete' || session.total_details?.amount_tax !== taxCents || session.amount_total !== chargedTotalCents) {
    throw Error('Checkout tax total did not reconcile.');
  }
  return { chargedTotalCents, taxCents, tipTaxCents };
}

export async function settleFilmmaker(key, order, store, fetchImpl) {
  if (!isMarketplace(order) || order.transferId || !order.paidAt || order.refundedAmount || order.revocationReason || order.stripeFeeCents == null) return;
  const amount = Math.max(0, order.amount - order.stripeFeeCents);
  if (!amount) { store.setViewerTransfer(order.orderId, 'no_proceeds'); return; }
  const group = transferGroup(order);
  // A lost response can outlive Stripe's 24-hour idempotency cache. Reuse the transfer tied to this source charge.
  const list = await platformRequest(key, 'transfers?' + new URLSearchParams({ transfer_group: group, limit: '2' }), fetchImpl);
  if (list.object !== 'list' || !Array.isArray(list.data) || list.has_more || list.data.length > 1) throw Error('Unexpected transfer history.');
  let transfer = list.data[0];
  if (!transfer) {
    const attemptKey = group + '-transfer' + (order.transferAttempt ? '-' + order.transferAttempt : '');
    try {
      transfer = await platformRequest(key, 'transfers', fetchImpl, {
        amount: String(amount), currency: 'usd', destination: order.account, source_transaction: order.chargeId,
        transfer_group: group, 'metadata[order]': order.orderId
      }, attemptKey);
    } catch (error) {
      // Stripe caches a definitive capability denial under the original key. Only
      // advance after that exact denial and a fresh active-recipient verification.
      if (error.recipientRejected) {
        const account = await platformRequest(key,'core/accounts/' + order.account + '?include[0]=configuration.recipient',
          fetchImpl, undefined, undefined, 'v2');
        if (account.object === 'v2.core.account' && account.id === order.account && account.livemode === false &&
            account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === 'active') {
          store.advanceRejectedTransfer(order);
        }
      }
      throw error;
    }
  }
  if (transfer.object !== 'transfer' || !/^tr_[A-Za-z0-9]+$/.test(transfer.id) || transfer.livemode !== false ||
      transfer.amount !== amount || transfer.currency !== 'usd' || transfer.destination !== order.account ||
      transfer.source_transaction !== order.chargeId || transfer.transfer_group !== group || transfer.metadata?.order !== order.orderId ||
      !store.setViewerTransfer(order.orderId, transfer.id)) throw Error('Filmmaker transfer could not be verified.');
}
