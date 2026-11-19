import { setTimeout as delay } from 'node:timers/promises';
import { sha256Hex } from '@dustwave/worker-core/crypto';
import { readBoundedJson } from '@dustwave/worker-core/response-body';
import { createStripeClient, DEFAULT_STRIPE_API_VERSION } from '@dustwave/worker-core/stripe';
import { createRentalAuthority, rentalScope, savedFilmScope } from './rental.js';
import { createStripeSetup, stripeSetupStateForMode } from './setup-stripe.js';
import { createR2Source } from './source.js';
import { revisionFor } from './media.js';

const API = 'https://api.stripe.com';
const intentIdPattern = /^pi_[a-zA-Z0-9]+$/;
const accountIdPattern = /^acct_[a-zA-Z0-9]+$/;
const directFeeTypes = new Set(['stripe_fee', 'payment_method_passthrough_fee', 'tax', 'withheld_tax']);

export async function platformAccount(key, fetchImpl) {
  const response = await fetchImpl(API + '/v1/account', { method: 'GET',
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': DEFAULT_STRIPE_API_VERSION },
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Stripe could not identify the platform sandbox.');
  }
  const account = await readBoundedJson(response, 256 * 1024);
  if (account?.object !== 'account' || !accountIdPattern.test(account.id) || account.livemode === true) {
    throw new Error('Unexpected platform account.');
  }
  return account.id;
}

export function connectedClient(key, account, platform, fetchImpl) {
  if (!accountIdPattern.test(account) || account === platform) throw new Error('A distinct connected account is required.');
  return createStripeClient(key, { fetchImplementation: (href, init) => {
    const url = new URL(href);
    const endpoint = (init.method === 'POST' && (['/v1/payment_intents', '/v1/checkout/sessions'].includes(url.pathname) ||
      /^\/v1\/checkout\/sessions\/cs_test_[a-zA-Z0-9]+\/expire$/.test(url.pathname))) ||
      (init.method === 'GET' && /^\/v1\/(?:payment_intents\/pi_[a-zA-Z0-9]+|checkout\/sessions\/cs_test_[a-zA-Z0-9]+)$/.test(url.pathname));
    if (url.origin !== API || !endpoint) throw new Error('Unexpected payment endpoint.');
    const headers = new Headers(init.headers);
    headers.set('Stripe-Account', account);
    return fetchImpl(url.href, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } });
}

export async function verifyReadySeller({ store, env, fetchImpl, owner, account }) {
  const maker = store.maker(owner);
  const state = maker && stripeSetupStateForMode(maker.stripe, 'test');
  if (state?.creatorId !== owner || state.accountId !== account || !store.ownsTestAccount(owner, account)) {
    throw new Error('This filmmaker needs a verified sandbox connection.');
  }
  // Refresh a private snapshot. Never overwrite setup changes from another process.
  const connect = createStripeSetup({ env, origin: 'http://127.0.0.1', fetchImpl });
  const refreshed = await connect.refresh({
    creatorId: owner, state, save: () => {}, claimAccount: id => store.ownsTestAccount(owner, id)
  });
  if (refreshed.status !== 'ready' || !state.chargesEnabled || !state.payoutsEnabled) {
    throw new Error('The connected sandbox account must be ready for both charges and payouts.');
  }
}

async function createTestIntent(stripe, scope, order, sleep) {
  const data = {
    amount: 99, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_visa',
    capture_method: 'automatic', confirm: true, metadata: { product: 'stream-rental-prototype', scope, order: order.orderId }
  };
  const options = { idempotencyKey: 'stream-connected-test-' + order.orderId };
  for (const pause of [0, 500, 1500]) {
    if (pause) await sleep(pause);
    if (Date.now() - order.createdAt >= 23 * 3600_000) throw new Error('Reconcile the pending connected payment before retrying this order.');
    try {
      return await stripe.paymentIntents.create(data, options);
    } catch (error) {
      if (!error.retryable || pause === 1500) throw error;
    }
  }
}

function reconcile(intent, order, scope) {
  const charge = intent?.latest_charge;
  const ledger = charge?.balance_transaction;
  if (intent?.id !== order.intentId || intent.metadata?.order !== order.orderId || intent.metadata?.scope !== scope ||
      intent.application_fee_amount || intent.transfer_data || intent.on_behalf_of ||
      !/^ch_[a-zA-Z0-9]+$/.test(charge?.id) || charge.amount !== 99 || charge.amount_captured !== 99 ||
      charge.currency !== 'usd' || charge.application_fee || charge.application_fee_amount || charge.transfer_data ||
      ledger?.object !== 'balance_transaction' || !/^txn_[a-zA-Z0-9]+$/.test(ledger.id) || ledger.type !== 'charge' ||
      ledger.source !== charge.id || ledger.currency !== 'usd' || ledger.amount !== 99 ||
      !Number.isSafeInteger(ledger.fee) || ledger.fee < 0 || !Number.isSafeInteger(ledger.net) ||
      ledger.net !== ledger.amount - ledger.fee || !['available', 'pending'].includes(ledger.status)) {
    throw new Error('Stripe’s connected-account ledger did not reconcile with the test order.');
  }
  const fees = ledger.fee_details;
  const feeBreakdown = {};
  if (!Array.isArray(fees)) throw new Error('Stripe did not return itemized fee details.');
  for (const row of fees) {
    if (row?.currency !== 'usd' || !directFeeTypes.has(row.type) || row.application || !Number.isSafeInteger(row.amount)) {
      throw new Error('Unexpected fee on the connected test charge.');
    }
    feeBreakdown[row.type] = (feeBreakdown[row.type] ?? 0) + row.amount;
  }
  if (Object.values(feeBreakdown).reduce((sum, amount) => sum + amount, 0) !== ledger.fee) {
    throw new Error('The Stripe fee details did not reconcile with the connected balance.');
  }
  return { currency: 'usd', gross: ledger.amount, totalFees: ledger.fee, feeBreakdown,
    stripeFees: feeBreakdown.stripe_fee ?? 0, platformFee: 0,
    net: ledger.net, balanceStatus: ledger.status };
}

// One immutable operator test order per saved film. The setup DB supplies the
// recipient and original; client input supplies only the creator and saved film ID.
export async function connectedTestRental({ owner, filmId, store, env, signingKey, fetchImpl = fetch,
  sourceFor = createR2Source, sleep = delay }) {
  const key = env.STRIPE_CONNECT_SECRET_KEY || '';
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key) || env.STRIPE_CONNECT_LIVE === '1') {
    throw new Error('Connected rental tests require a Stripe Connect sandbox key and test mode.');
  }
  if (!/^f-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(filmId)) throw new Error('Choose a saved film ID.');
  const saved = store.film(owner, filmId);
  const maker = store.maker(owner);
  if (!maker || saved?.id !== filmId || !saved.rights?.version || !saved.rights?.statement ||
      !Number.isFinite(Date.parse(saved.rights.acceptedAt)) || !saved.revision) {
    throw new Error('Choose a verified film owned by this filmmaker with recorded distribution rights.');
  }
  const state = stripeSetupStateForMode(maker.stripe, 'test');
  const account = state.accountId;
  if (state.creatorId !== owner || state.mode !== 'test' || !accountIdPattern.test(account) ||
      !store.ownsTestAccount(owner, account)) throw new Error('This filmmaker needs a verified sandbox connection.');
  const authority = createRentalAuthority(signingKey);
  const source = sourceFor({ ...store.credentials(owner, saved.bucket), objectKey: saved.objectKey });
  async function verifySource() {
    if (revisionFor(await source.head()) !== saved.revision) throw new Error('The private film changed since verification.');
  }
  await verifySource();
  const platform = await platformAccount(key, fetchImpl);
  const stripe = connectedClient(key, account, platform, fetchImpl);
  await verifyReadySeller({ store, env, fetchImpl, owner, account });

  const film = { film: savedFilmScope(owner, filmId), revision: saved.revision };
  const scope = rentalScope(film);
  const sourceRef = await sha256Hex(JSON.stringify([saved.bucket.accountId, saved.bucket.jurisdiction, saved.bucket.bucket, saved.objectKey]));
  const binding = { owner, filmId, account, platform, revision: film.revision, source: sourceRef };
  const order = store.reserveTestOrder(binding);
  if (!order.intentId) {
    const created = await createTestIntent(stripe, scope, order, sleep);
    if (created?.livemode !== false || !intentIdPattern.test(created.id)) throw new Error('Unexpected sandbox payment response.');
    store.recordTestIntent(order.orderId, created.id);
    order.intentId = created.id;
  }
  let intent;
  for (const ms of [0, 500, 1000, 2000, 4000, 8000]) {
    if (ms) await sleep(ms);
    intent = await stripe.paymentIntents.retrieve(order.intentId, { expand: ['latest_charge.balance_transaction'] });
    if (intent?.status !== 'succeeded' || intent.latest_charge?.balance_transaction != null) break;
  }
  if (intent?.status === 'succeeded' && intent.latest_charge?.balance_transaction == null) {
    throw new Error('The connected balance transaction is pending. Rerun the same order to retrieve it.');
  }
  const totals = reconcile(intent, order, scope);
  await verifySource();
  const current = store.reserveTestOrder(binding);
  if (current.intentId !== order.intentId) throw new Error('Payment binding changed.');
  const receipt = await authority.issueReceipt(intent, film);
  const session = await authority.exchange(receipt, film);
  await authority.verifyGrant(session.grant, film);
  return { receipt, evidence: {
    sandbox: true, connectedDirectCharge: true, providerStatus: intent.status, originalVerified: true,
    chargesEnabled: true, payoutsEnabled: true, matchingLedgerSource: true, ...totals,
    paidAt: new Date(intent.latest_charge.created * 1000).toISOString(),
    rentalExpiresAt: new Date(session.rentalExpiresAt * 1000).toISOString(), filmReceiptVerified: true
  } };
}
