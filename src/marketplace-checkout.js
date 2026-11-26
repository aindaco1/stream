import { stripeSecretMode } from './stripe-mode.js';
import { readBoundedJson } from '@dustwave/worker-core/response-body';
import { newMexicoTotals } from './new-mexico-grt.js';

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
  return order.tipAmount ? [film, item('tip', order.tipAmount, 'Optional tip to Stream')] : [film];
}

// The state-limited pilot verifies a New Mexico viewing address before creating
// a manual-tax Session. For whole countries Stripe enforces the allowed list
// in its own address element at confirmation, independently of the embed UI.
export function liveSalesTerritory(value) {
  if (!value?.trim() || value.trim().toLowerCase() === 'closed') return 'closed';
  if (value.trim().toLowerCase() === 'worldwide') return 'worldwide';
  const territories = [...new Set(value.split(',').map(code => code.trim().toUpperCase()))].sort();
  if (territories.length === 1 && territories[0] === 'US-NM') return 'US-NM';
  if (territories.length > 100 || !territories.every(code => /^[A-Z]{2}$/.test(code))) {
    throw Error('Set STREAM_SALES_TERRITORIES to worldwide, US-NM or a list of approved country codes.');
  }
  return territories.join(',');
}

export function checkoutCountries(order) {
  if (order.nmQuote) return;
  if (order.viewingAddressTag) return ['US'];
  if (order.salesTerritory && !['US-NM','worldwide'].includes(order.salesTerritory)) return order.salesTerritory.split(',');
}

export function matchesMarketplaceSession(session, order) {
  const base = order.amount + order.tipAmount;
  const tax = session.automatic_tax;
  if (session.total_details?.amount_discount !== 0 ||
      (session.total_details?.amount_shipping ?? 0) !== 0) return false;
  if (order.nmQuote) {
    const totals = newMexicoTotals(order, JSON.parse(order.nmQuote));
    return tax?.enabled === false && session.amount_total === totals.chargedTotalCents &&
      session.total_details.amount_tax === totals.taxCents &&
      [base,base - totals.tipTaxCents].includes(session.amount_subtotal);
  }
  if (!tax?.enabled || tax.liability?.type !== 'self') return false;
  const expected = checkoutCountries(order);
  if (expected) {
    const countries = session.shipping_address_collection?.allowed_countries;
    if (!Array.isArray(countries) || countries.length !== expected.length || !expected.every(code => countries.includes(code))) return false;
    if (order.salesTerritory && session.status === 'complete' && ['paid','no_payment_required'].includes(session.payment_status) &&
        !expected.includes(session.collected_information?.shipping_details?.address?.country)) return false;
  }
  // Until the billing address is complete, Checkout can return provisional amounts.
  if (tax.status !== 'complete') return session.payment_status === 'unpaid' || (order.couponId && order.amount===0 && ['open','expired'].includes(session.status));
  const taxCents = session.total_details.amount_tax;
  if (!cents(session.amount_total) || !cents(taxCents) || !cents(session.amount_subtotal)) return false;
  const included = base + taxCents - session.amount_total;
  return cents(included) && included <= Math.min(order.tipAmount, taxCents) &&
    (session.amount_subtotal === base || session.amount_subtotal === base - included);
}

// A platform-scoped API call is authenticated by the configured Stripe key. Never pass a seller header.
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

// Stripe stores the location-specific manual rates and displays them on its receipt.
// Cache identifiers by platform so retrying a Checkout creation uses identical parameters.
export async function manualCheckoutItems(key, order, store, fetchImpl) {
  const quote = JSON.parse(order.nmQuote);
  return Promise.all(checkoutItems(order).map(async item => {
    const inclusive = item.price_data.tax_behavior === 'inclusive';
    let id = store.nmRateId(order.platform, quote, inclusive);
    if (!id) {
      const rate = await platformRequest(key, 'tax_rates', fetchImpl, {
        display_name:'NM gross receipts tax', jurisdiction:'NM ' + quote.code, country:'US', state:'NM',
        percentage:(quote.ratePartsPerMillion / 10000).toFixed(4), inclusive:String(inclusive)
      }, ['stream-nm-grt-v1',order.platform,quote.code,quote.ratePartsPerMillion,inclusive].join('-'));
      if (rate.object !== 'tax_rate' || rate.livemode !== (stripeSecretMode(key) === 'live') || !/^txr_[A-Za-z0-9]+$/.test(rate.id) ||
          !rate.active || rate.inclusive !== inclusive || rate.jurisdiction !== 'NM ' + quote.code ||
          rate.country !== 'US' || rate.state !== 'NM' || Math.round(rate.percentage * 10000) !== quote.ratePartsPerMillion) {
        throw Error('Stripe did not confirm the New Mexico tax rate.');
      }
      id = store.rememberNmRate(order.platform, quote, inclusive, rate.id);
    }
    return { ...item, tax_rates:[id] };
  }));
}

// Verify both prices and both tax behaviors against this order before issuing access or transferring funds.
export async function verifiedTax(key, order, session, fetchImpl, store) {
  const quote = order.nmQuote && JSON.parse(order.nmQuote);
  const data = await platformRequest(key, 'checkout/sessions/' + session.id + '/line_items?limit=3&expand[]=data.price.product' +
    (quote ? '&expand[]=data.taxes' : ''), fetchImpl);
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
    if (quote) {
      const taxes = line.taxes;
      const rate = taxes?.[0]?.rate;
      const expectedRate = store.nmRateId(order.platform,quote,included);
      if (!expectedRate || taxes?.length !== 1 || taxes[0].amount !== line.amount_tax ||
          (rate?.id ?? rate) !== expectedRate) throw Error('Unexpected New Mexico reporting rate.');
    }
    if (line.amount_total !== spec.unit_amount + (included ? 0 : line.amount_tax) ||
        (included && line.amount_tax > spec.unit_amount)) throw Error('Unexpected checkout tax.');
    if (included) tipTaxCents = line.amount_tax;
    taxCents += line.amount_tax;
    chargedTotalCents += line.amount_total;
  }
  if (quote) {
    const expectedTotals = newMexicoTotals(order,quote);
    if (session.automatic_tax?.enabled !== false || expectedTotals.taxCents !== taxCents ||
        expectedTotals.tipTaxCents !== tipTaxCents || expectedTotals.chargedTotalCents !== chargedTotalCents) {
      throw Error('Checkout tax differs from the held New Mexico quote.');
    }
  } else if (session.automatic_tax?.status !== 'complete') throw Error('Checkout tax is incomplete.');
  if (session.total_details?.amount_tax !== taxCents || session.amount_total !== chargedTotalCents) {
    throw Error('Checkout tax total did not reconcile.');
  }
  return { chargedTotalCents, taxCents, tipTaxCents };
}

export async function settleFilmmaker(key, order, store, fetchImpl) {
  if (!isMarketplace(order) || order.transferId || !order.paidAt || order.refundedAmount || order.revocationReason || order.cardProcessingCents == null || order.taxBasicFeeCents == null) return;
  const amount = Math.max(0, order.amount - order.cardProcessingCents - order.filmTaxFeeCents);
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
        if (account.object === 'v2.core.account' && account.id === order.account && account.livemode === (stripeSecretMode(key) === 'live') &&
            account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === 'active') {
          store.advanceRejectedTransfer(order);
        }
      }
      throw error;
    }
  }
  if (transfer.object !== 'transfer' || !/^tr_[A-Za-z0-9]+$/.test(transfer.id) || transfer.livemode !== (stripeSecretMode(key) === 'live') ||
      transfer.amount !== amount || transfer.currency !== 'usd' || transfer.destination !== order.account ||
      transfer.source_transaction !== order.chargeId || transfer.transfer_group !== group || transfer.metadata?.order !== order.orderId ||
      !store.setViewerTransfer(order.orderId, transfer.id)) throw Error('Filmmaker transfer could not be verified.');
}
