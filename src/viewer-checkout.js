import { normalizeCouponCode, validCouponCode } from '@dustwave/coupon-core';
import { mailbox } from './stream-email.js';
import { stripeMode, stripeSecretMode, publishableKeyMode, sessionMode } from './stripe-mode.js';
import { sha256Hex } from '@dustwave/worker-core/crypto';
import { verifyStripeSignature } from '@dustwave/worker-core/stripe';
import { connectedClient, paymentClient, platformAccount, verifyReadySeller } from './connected-test-rental.js';
import { rentalScope } from './rental.js';
import { programPresentation } from './program-delivery.js';
import { isPrice } from './prices.js';
import { adjustmentEvents, adjustmentReader, adjustmentReference } from './payment-adjustments.js';
import { orderTotal, processingFee, tipFor } from './checkout-tips.js';

import { MARKETPLACE_POLICY, isMarketplace, marketplaceEnabled, checkoutItems, manualCheckoutItems, matchesMarketplaceSession, verifiedTax,
  settleFilmmaker, transferGroup, checkoutCountries, liveSalesTerritory } from './marketplace-checkout.js';
import { resolveNewMexicoQuote, newMexicoTotals } from './new-mexico-grt.js';

const LEGACY_FLOW = 'stream-viewer-rental';
const FLOW = 'stream-viewer-checkout';
const sessionEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
export const viewerWebhookEvents = ['charge.updated', ...sessionEvents, ...adjustmentEvents];
const CHECKOUT_API = { stripeVersion: '2026-10-28.endive' };
const INTENT = /^pi_[a-zA-Z0-9]+$/;

function expiresAt(order) {
  return order.kind === 'rent' && order.paidAt ? order.paidAt + order.rentalHours * 3600 : null;
}

function localStatus(order) {
  if (order.revocationReason === 'dispute' && order.disputeStatus !== 'lost') return 'suspended';
  if (order.revocationReason) return 'revoked';
  const end = expiresAt(order);
  return end && end <= Math.floor(Date.now()/1000) ? 'expired' : order.status;
}

// Stop retrying before Stripe can discard the original creation idempotency key.
function abandoned(order) {
  return !order.sessionId && Date.now() - order.createdAt >= 23 * 3600_000;
}

export class ViewerCheckoutError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ViewerCheckoutError';
    this.statusCode = statusCode;
  }
}

function mismatch() {
  return new ViewerCheckoutError('The payment could not be verified for this film.', 409);
}

async function viewerHash(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new ViewerCheckoutError('The private viewer token is invalid.');
  }
  return sha256Hex(token);
}

function sameFilm(order, offer) {
  return order.filmId === offer.id && order.owner === offer.owner &&
    order.scope === offer.scope && order.revision === offer.revision;
}

function metadata(order) {
  const markers = { order: order.orderId, product: order.salesTerritory ? 'stream' : 'stream-rental-prototype',
    scope: rentalScope({ film: order.scope, revision: order.revision }) };
  return order.uiMode === 'hosted' ? { ...markers, flow: LEGACY_FLOW } :
    { ...markers, flow: FLOW, kind: order.kind, amount: String(orderTotal(order)),
      ...(isMarketplace(order) && { tax_policy:order.taxPolicy, filmmaker:order.account }),
      ...(order.nmQuote && { grt_policy:'nm-manual-v1', grt_location:JSON.parse(order.nmQuote).code }),
      ...(order.tipAmount > 0 && { film_amount:String(order.amount), tip_percent:String(order.tipPercent), tip_amount:String(order.tipAmount) }) };
}

function sameMetadata(data, order) {
  if (!isMarketplace(order) && data?.tax_policy != null) return false;
  if (!order.nmQuote && (data?.grt_policy != null || data?.grt_location != null)) return false;
  if (!order.tipAmount && (data?.tip_percent !== undefined || data?.tip_amount !== undefined || data?.film_amount !== undefined)) return false;
  if (order.uiMode === 'hosted' && (order.kind !== 'rent' || order.amount !== 99 || data?.kind || data?.amount)) return false;
  return Object.entries(metadata(order)).every(([k, v]) => data?.[k] === v);
}

function checkSession(session, order, live) {
  if (session?.object !== 'checkout.session' || sessionMode(session.id) !== (live ? 'live' : 'test') || (order.sessionId && session.id !== order.sessionId) ||
      session.livemode !== live || session.mode !== 'payment' || session.currency !== 'usd' ||
      (order.uiMode !== 'hosted' && session.ui_mode !== order.uiMode) ||
      (isMarketplace(order) ? !matchesMarketplaceSession(session,order) :
        session.amount_subtotal !== orderTotal(order) || session.amount_total !== orderTotal(order)) || session.client_reference_id !== order.orderId ||
      !sameMetadata(session.metadata, order)) throw mismatch();
}

function checkIntent(intent, order, intentId, total, applicationFee, live) {
  if (intent?.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== live ||
      intent.currency !== 'usd' || intent.amount !== total || !sameMetadata(intent.metadata, order) ||
      (isMarketplace(order) && intent.transfer_group !== transferGroup(order)) || intent.transfer_data || (intent.application_fee_amount ?? 0) !== applicationFee || intent.on_behalf_of) throw mismatch();
}

function checkCharge(intent, order, total, applicationFee, live) {
  const charge = intent.latest_charge;
  if (intent.status !== 'succeeded' || intent.amount_received !== total ||
      charge?.object !== 'charge' || !/^ch_[a-zA-Z0-9]+$/.test(charge.id) || charge.payment_intent !== intent.id ||
      charge.livemode !== live || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded' ||
      charge.amount !== total || charge.amount_captured !== total || charge.currency !== 'usd' || charge.transfer_data ||
      (charge.application_fee_amount ?? 0) !== applicationFee || charge.on_behalf_of ||
      (charge.application_fee != null && (!applicationFee || !/^fee_[a-zA-Z0-9]+$/.test(charge.application_fee))) ||
      !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || typeof charge.refunded !== 'boolean' ||
      typeof charge.disputed !== 'boolean' || !Number.isSafeInteger(charge.created) || charge.created <= 0 ||
      charge.created > Math.floor(Date.now() / 1000)) throw mismatch();
  return charge;
}

function landingOrigin(value, expected) {
  const u = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.origin !== value || (expected && value !== expected) || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) {
    throw new ViewerCheckoutError('Invalid checkout return address.');
  }
  return u.origin;
}

export function createViewerCheckout({ store, env = process.env, fetchImpl = fetch, webhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET }) {
  const key = env.STRIPE_CONNECT_SECRET_KEY || '';
  const publishableKey = env.STRIPE_CONNECT_PUBLISHABLE_KEY || '';
  const mode = stripeMode(env);
  const live = mode === 'live';
  const marketplace = marketplaceEnabled(env);
  const serverConfigured = store.paymentMode === mode && stripeSecretMode(key) === mode;
  const liveWebhooks = webhookSecret?.startsWith('whsec_') && env.STRIPE_PLATFORM_WEBHOOK_SECRET?.startsWith('whsec_') &&
    env.STRIPE_PLATFORM_WEBHOOK_SECRET !== webhookSecret;
  const configured = serverConfigured && publishableKeyMode(publishableKey) === mode && (!live || (marketplace && liveWebhooks));
  const salesTerritory = live ? liveSalesTerritory(env.STREAM_SALES_TERRITORIES) : '';
  const includesNewMexico = !live || ['worldwide','US-NM'].includes(salesTerritory) || salesTerritory.split(',').includes('US');
  const manualNmEnabled = marketplace && includesNewMexico && env.STREAM_NM_MANUAL_TAX !== '0';
  if (live && salesTerritory === 'US-NM' && !manualNmEnabled) throw Error('US-NM checkout requires manual New Mexico tax.');
  let platform;
  const creating = new Map();
  const checking = new Map();
  const withdrawing = new Map();
  const checkingPlatform = () => {
    if (!serverConfigured) throw new ViewerCheckoutError('Checkout is unavailable.', 503);
    platform ??= platformAccount(key, fetchImpl).catch(error => { platform = undefined; throw error; });
    return platform;
  };
  async function client(order) {
    const id = await checkingPlatform();
    if (id !== order.platform) throw mismatch();
    return isMarketplace(order) ? paymentClient(key, null, fetchImpl) : connectedClient(key, order.account, id, fetchImpl);
  }

  function existingOrderMatches(order, offer) {
    return sameFilm(order, offer) && (order.account === offer.account ||
      (offer.account === null && store.ownsAccount(order.owner, order.account)));
  }

  function shared(map, id, action) {
    if (!map.has(id)) map.set(id, action().finally(() => map.delete(id)));
    return map.get(id);
  }

  async function closeWithdrawnSession(order) {
    return shared(withdrawing, order.orderId, async () => {
      // Re-read the durable request before changing anything at Stripe. The
      // checked Session metadata also binds the account, order, film and cut.
      order = store.viewerOrderById(order.orderId);
      if (order?.withdrawalState !== 'requested' || !order.sessionId) return;
      if (!order.paidAt) {
        if (!store.ownsAccount(order.owner,order.account) || sessionMode(order.sessionId) !== mode) throw mismatch();
        const stripe = await client(order);
        const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
        const read = () => stripe.checkout.sessions.retrieve(order.sessionId, options);
        let session = await read();
        checkSession(session, order, live);
        if (session.status === 'open' && (session.payment_status === 'unpaid' || order.amount===0)) {
          try {
            session = await stripe.checkout.sessions.expire(session.id,options);
          } catch {
            // Confirmation, another expiration, or a lost network response
            // can win the race. Only Stripe's current status decides the result.
            session = await read();
          }
          checkSession(session,order,live);
        }
        if (session.status === 'expired') store.expireViewerOrder(order.orderId);
        else if (session.status === 'complete') await reconcile(order,session);
        else throw new ViewerCheckoutError('The unfinished checkout still needs to close.',503);
      }
      store.finishWithdrawal(order.orderId,order.sessionId);
    });
  }

  async function closeWithdrawnSessions(owner,filmId) {
    const orders = store.requestedWithdrawals(owner,filmId,!owner);
    let interrupted = false;
    for (let i=0; i<orders.length; i+=4) {
      await Promise.all(orders.slice(i,i+4).map(async order => {
        try { await closeWithdrawnSession(order); }
        catch { interrupted = true; store.retryWithdrawal(order.orderId); }
      }));
    }
    return owner ? store.pendingWithdrawals(owner,filmId) : !interrupted;
  }

  async function openSession(order) {
    const expired = () => new ViewerCheckoutError('This order has expired. Start a new checkout.', 410);
    if (order.status === 'expired' || abandoned(order)) throw expired();
    if (order.status === 'paid') {
      if ((await reconcile(order)).status === 'paid') return { status: 'paid' };
      throw expired();
    }
    if (order.withdrawalState) {
      await closeWithdrawnSession(order);
      const current = store.viewerOrderById(order.orderId);
      if (localStatus(current) === 'paid') return { status:'paid' };
      if (current.sessionId && current.status === 'pending' && current.withdrawalState === 'closed') {
        throw new ViewerCheckoutError('Your payment is still processing.',409);
      }
      throw expired();
    }
    const stripe = await client(order);
    const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
    let session;
    if (order.sessionId) {
      session = await stripe.checkout.sessions.retrieve(order.sessionId, options);
    } else {
      if (order.uiMode === 'hosted') throw new ViewerCheckoutError('Start a new checkout for this film.', 410);
      if (order.uiMode !== 'embedded_page' && order.uiMode !== 'elements') throw mismatch();
      await verifyReadySeller({ store, env, fetchImpl, owner: order.owner, account: order.account, requireTransfers:isMarketplace(order) });
      if (store.viewerOrderById(order.orderId).withdrawalState) throw expired();
      const markers = metadata(order);
      // Retried creates must send the parameters from the order's original UI.
      const redirect = order.uiMode === 'elements' ?
        { return_url: order.origin + '/embed/' + encodeURIComponent(order.filmId) + '?order=' + order.orderId } :
        { redirect_on_completion: 'never' };
      const marketplace = isMarketplace(order);
      const countries = checkoutCountries(order);
      const items = order.nmQuote ? await manualCheckoutItems(key,order,store,fetchImpl) : checkoutItems(order);
      session = await stripe.checkout.sessions.create({
        mode: 'payment', ui_mode: order.uiMode, ...redirect, adaptive_pricing: { enabled: false },
        ...(order.cardOnly ? { allowed_payment_method_types: ['card'] } : {}),
        ...((order.nmQuote || order.couponId) && {expires_at:Math.floor(order.createdAt/1000) + 24*3600 - 60}),
        ...(marketplace && (order.nmQuote
          ? { automatic_tax:{enabled:false} }
          : { automatic_tax:{enabled:true, liability:{type:'self'}},
              ...(countries ? { shipping_address_collection:{allowed_countries:countries} } : { billing_address_collection:'required' }) })),
        client_reference_id: order.orderId, metadata: markers, ...(order.amount > 0 && {payment_intent_data: {
          metadata: markers, ...(marketplace ? { transfer_group:transferGroup(order) } : order.tipAmount > 0 && { application_fee_amount:order.tipAmount })
        }}), line_items:items
      }, { ...options, idempotencyKey: 'stream-viewer-' + order.orderId });
      checkSession(session, order, live);
      store.bindViewerSession(order.orderId, session.id);
    }
    checkSession(session, order, live);
    if (session.status === 'open' && store.viewerOrderById(order.orderId).withdrawalState) {
      // A different process may have unpublished this film while create/get
      // was outstanding. Never return a withdrawn Session's client secret.
      await closeWithdrawnSession(order);
      if (localStatus(store.viewerOrderById(order.orderId)) === 'paid') return {status:'paid'};
      throw expired();
    }
    if (session.status === 'expired') {
      store.expireViewerOrder(order.orderId);
      throw expired();
    }
    if (session.status === 'complete') {
      const result = await reconcile({ ...order, sessionId: session.id }, session);
      if (result.status === 'paid') return { status: 'paid' };
      if (result.status === 'expired') throw expired();
      throw new ViewerCheckoutError('Your payment is still processing.', 409);
    }
    if (order.uiMode === 'hosted') throw new ViewerCheckoutError('Finish the earlier checkout in its original tab.', 409);
    const allowedMethods = session.allowed_payment_method_types ?? session.payment_method_types;
    if (order.cardOnly && (!Array.isArray(allowedMethods) || allowedMethods.length !== 1 || allowedMethods[0] !== 'card')) throw mismatch();
    if (session.status !== 'open' || typeof session.client_secret !== 'string' ||
        !session.client_secret.startsWith(session.id + '_secret_') || session.client_secret.length > 1024) throw mismatch();
    return { clientSecret: session.client_secret, publishableKey, account: isMarketplace(order) ? null : order.account,
      ...(isMarketplace(order) && {taxPolicy:order.taxPolicy}),
      ...(order.nmQuote && {manualTax:true,...newMexicoTotals(order,JSON.parse(order.nmQuote))}),
      ...(isMarketplace(order) && checkoutCountries(order) && {useViewingAddress:true}),
      ...(order.couponId && {couponCode:order.couponCode,listAmount:order.listAmount}),
      uiMode: order.uiMode, orderId: order.orderId, title: order.title, kind: order.kind, amount: orderTotal(order),
      filmAmount:order.amount, tipPercent:order.tipPercent, tipAmount:order.tipAmount, currency: session.currency,
      ...(order.kind === 'rent' && {rentalHours:order.rentalHours}) };
  }

  async function start({ offer, token, origin, couponCode = '', kind = 'rent', tipPercent = 0, viewingAddress }) {
    if (!configured) throw new ViewerCheckoutError('Checkout is unavailable.', 503);
    if (!offer.account) throw mismatch();
    if (kind !== 'rent' && kind !== 'buy') throw new ViewerCheckoutError('Choose a rental or a purchase.');
    const digest = await viewerHash(token);
    const base = landingOrigin(origin, env.STREAM_PUBLIC_ORIGIN);
    if (live && (!base.startsWith('https://') || base !== env.STREAM_PUBLIC_ORIGIN)) throw mismatch();
    const previous = store.viewerOrderForToken(digest);
    if (live && !previous?.paidAt && salesTerritory === 'closed') throw new ViewerCheckoutError('Viewer payments have not opened yet.', 403);
    if (live && viewingAddress && !includesNewMexico) throw new ViewerCheckoutError('This viewing location is outside the pilot.', 403);
    if (live && previous && !previous.paidAt && previous.salesTerritory !== salesTerritory) {
      store.withdrawViewerOrder(previous.orderId);
      await closeWithdrawnSession(previous);
      throw new ViewerCheckoutError('The available viewing locations changed. Start a new checkout.', 410);
    }
    couponCode = normalizeCouponCode(couponCode);
    if (couponCode && !validCouponCode(couponCode)) throw Object.assign(new ViewerCheckoutError('Enter a valid coupon code.',422),{code:'coupon_invalid'});
    if (previous && (previous.couponCode || '') !== couponCode) throw mismatch();
    const amount = previous?.listAmount ?? previous?.amount ?? offer.prices?.[kind];
    if (!isPrice(amount)) throw new ViewerCheckoutError('This option is unavailable for this film.', 409);
    if (tipFor(couponCode ? previous?.amount ?? 0 : amount,tipPercent) === null) throw new ViewerCheckoutError('Choose an available tip amount.');
    const viewingAddressTag = viewingAddress ? store.viewingAddressTag(viewingAddress) : null;
    const nmQuote = !previous && manualNmEnabled && viewingAddress
      ? await resolveNewMexicoQuote(viewingAddress,{fetchImpl}) : null;
    if (!previous && salesTerritory === 'US-NM' && !nmQuote) {
      throw new ViewerCheckoutError('This pilot is available in New Mexico. Enter a New Mexico viewing address whose tax district we can verify.', 422);
    }
    const id = await checkingPlatform();
    if (offer.account === id) throw mismatch();
    const order = previous ?? store.reserveViewerOrder({ ...offer, couponCode, tokenHash: digest, platform: id, origin: base, kind, amount, tipPercent,
      taxPolicy: marketplace ? MARKETPLACE_POLICY : 'none', nmQuote, viewingAddressTag, salesTerritory:live ? salesTerritory : null });
    if (viewingAddressTag && order.viewingAddressTag !== viewingAddressTag) {
      throw new ViewerCheckoutError('Start a new checkout to change your viewing location.',409);
    }
    if ((order.couponCode || '') !== couponCode || !sameFilm(order, offer) || order.kind !== kind || order.tipPercent !== tipPercent || order.platform !== id || order.origin !== base) throw mismatch();
    if (order.account !== offer.account) {
      // openSession can only reconcile a paid/withdrawn order here. Never
      // disclose an old open form or create a charge on a former recipient.
      if (!(order.withdrawalState || order.status === 'paid') || !store.ownsAccount(order.owner, order.account) ||
          !store.ownsAccount(offer.owner, offer.account)) throw mismatch();
    }
    return shared(creating, order.orderId, () => openSession(order));
  }

  async function reconcileOnce(order, retrievedSession, paidEvent, adjustment) {
    const stripe = await client(order);
    const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
    const session = retrievedSession ?? await stripe.checkout.sessions.retrieve(order.sessionId, options);
    checkSession(session, order, live);
    if (session.status === 'expired') {
      store.expireViewerOrder(order.orderId);
      return { status: 'expired' };
    }
    if (session.status === 'open' && (session.payment_status === 'unpaid' || order.amount===0)) return { status: 'pending' };
    if (order.couponId && order.amount === 0) {
      if (session.status !== 'complete' || !['no_payment_required','paid'].includes(session.payment_status) ||
          session.payment_intent != null || session.amount_total !== 0 || session.amount_subtotal !== 0 || order.tipAmount !== 0) throw mismatch();
      const now = Math.floor(Date.now()/1000);
      const confirmed = paidEvent?.created;
      // A delayed first status lookup must not restart an old free rental.
      const latest = Math.min(now,Math.floor(order.createdAt/1000) + 24*3600);
      const paidAt = order.paidAt ?? (Number.isSafeInteger(confirmed) && confirmed >= Math.floor(order.createdAt/1000) && confirmed <= latest ? confirmed : latest);
      const saved = store.settleFreeCoupon(order,paidAt,session.customer_details?.email);
      if (!saved) return;
      const status = localStatus(saved);
      return status === 'paid' ? {status,freeOrder:saved,paidAt:saved.paidAt} : {status};
    }
    if (session.status !== 'complete' || !['unpaid','paid'].includes(session.payment_status) || !INTENT.test(session.payment_intent)) throw mismatch();
    const intent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge.balance_transaction'] }, options);
    const marketplace = isMarketplace(order);
    const applicationFee = marketplace ? 0 : order.tipAmount;
    checkIntent(intent, order, session.payment_intent, session.amount_total, applicationFee, live);
    if (session.payment_status === 'unpaid') {
      if (['canceled','requires_payment_method'].includes(intent.status)) {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }
    const charge = checkCharge(intent, order, session.amount_total, applicationFee, live);
    const totals = marketplace ? await verifiedTax(key,order,session,fetchImpl,store) : {};
    if ((adjustment && (charge.id !== adjustment.chargeId || (adjustment.intentId && intent.id !== adjustment.intentId))) ||
        (order.intentId && order.intentId !== intent.id) || (order.chargeId && order.chargeId !== charge.id)) throw mismatch();
    const paymentState = await adjustmentReader(key,marketplace ? null : order.account,fetchImpl).state(order,charge,adjustment);
    const now = Math.floor(Date.now() / 1000);
    const useConfirmation = order.uiMode !== 'hosted' && order.kind === 'rent' && charge.payment_method_details?.type !== 'card';
    // A bank debit can create its Charge days before it succeeds. Stripe's
    // paid event dates that success; a missed webhook uses first verified payment.
    const datedEvent = paidEvent?.intent === intent.id && Number.isSafeInteger(paidEvent.created) &&
      paidEvent.created >= charge.created && paidEvent.created <= now;
    const confirmed = datedEvent ? paidEvent.created : now;
    const paidAt = order.paidAt ?? (useConfirmation ? confirmed : charge.created);
    if (paidAt < charge.created || paidAt > now || (!useConfirmation && paidAt !== charge.created)) throw mismatch();
    const stripeFeeCents = processingFee(order,charge,session.amount_total,applicationFee);
    const saved = store.reconcileViewerPayment(order,{intentId:intent.id,paidAt,stripeFeeCents,
      chargeBalanceId: stripeFeeCents === null ? null : charge.balance_transaction.id, ...totals,...paymentState});
    if (!saved) return;
    if (marketplace && !saved.transferId && !saved.revocationReason && !saved.refundedAmount) {
      try { await settleFilmmaker(key,saved,store,fetchImpl); }
      catch { console.error('Filmmaker transfer is awaiting reconciliation.'); }
      if (!store.viewerOrderById(saved.orderId).transferId) store.retryViewerTransfer(saved.orderId);
    }
    const status = localStatus(saved);
    if (status === 'paid') store.rememberViewerEmail(order.orderId, session.customer_details?.email || charge.billing_details?.email);
    return status === 'paid' ? {status,intent,paidAt:saved.paidAt,paymentState} : {status};
  }

  async function reconcile(order, retrievedSession, paidEvent, adjustment) {
    // A completed zero-total order has no charge to refund or dispute.
    if (order.couponId && order.amount === 0 && order.paidAt) {
      const status = localStatus(order);
      return status === 'paid' ? {status,freeOrder:order,paidAt:order.paidAt} : {status};
    }
    async function fresh() {
      // Start each Stripe read from the current ledger revision. A racing write
      // discards this read and reconciles again against Stripe under the seller.
      for (let i = 0; i < 3; i++) {
        const current = store.viewerOrderById(order.orderId);
        const result = await reconcileOnce(current,i === 0 ? retrievedSession : undefined,paidEvent,adjustment);
        if (result) return result;
      }
      throw new ViewerCheckoutError('Payment is being updated. Try again.',503);
    }
    // A new adjustment must fetch its own current snapshot, even during viewer polling.
    return adjustment ? fresh() : shared(checking,order.orderId,fresh);
  }

  function orderedOffer(offer, order, resolveEdition) {
    if (offer.type !== 'program' || !resolveEdition || !order || order.filmId !== offer.id || order.owner !== offer.owner) return offer;
    return resolveEdition(order.revision) || offer;
  }

  async function status({ offer, token, resolveEdition }) {
    const order = store.viewerOrderForAccess(await viewerHash(token));
    offer = orderedOffer(offer, order, resolveEdition);
    if (!order || !existingOrderMatches(order, offer)) return { status: 'pending' };
    // Older versions marked partial refunds expired without recording a reason.
    // Recheck a settled, still-current order under the current refund policy.
    const end = expiresAt(order);
    if ((end && end <= Math.floor(Date.now()/1000)) || (order.status === 'expired' && !order.intentId) || abandoned(order)) return {status:'expired'};
    if (!order.sessionId) return { status: order.withdrawalState ? 'expired' : 'pending' };
    if (order.status === 'pending' && !checking.has(order.orderId) && !store.checkPendingViewerOrder(order.orderId)) return { status: 'pending' };
    const result = await reconcile(order);
    if (result.status !== 'paid') return result;
    const film = { film: offer.scope, revision: offer.revision };
    const options = { amount:result.intent?.amount, agreedSubtotal:orderTotal(order), orderId:order.orderId, paymentState:result.paymentState };
    const receipt = result.freeOrder ? await offer.authority.issueCouponReceipt(result.freeOrder,film) : order.kind === 'buy' ? await offer.authority.issuePurchaseReceipt(result.intent,film,options) :
      await offer.authority.issueReceipt(result.intent,film,{...options,paidAt:result.paidAt,rentalHours:order.rentalHours});
    return { status:'paid',kind:order.kind,receipt,title:order.title,position:order.position || 0,
      ...(offer.type === 'program' && {program:programPresentation(offer),revision:offer.revision,memberId:order.positionMember || offer.lineup[0].id}),
      expiresAt:expiresAt({...order,paidAt:result.paidAt}),...(order.kind === 'rent' && {rentalHours:order.rentalHours}) };
  }

  function accessAllowed({offer,orderId,kind,rentalExpiresAt}) {
    if (!serverConfigured) return false;
    if (!orderId) return !live && kind === 'rent' && Number.isSafeInteger(rentalExpiresAt) && rentalExpiresAt > Date.now()/1000 &&
      store.accessForLegacyRental(offer,rentalExpiresAt);
    const order = store.viewerAccessById(orderId);
    return Boolean(order && existingOrderMatches(order,offer) && order.kind === kind && (order.intentId || (order.couponId && order.amount===0 && order.paidAt)) && localStatus(order) === 'paid');
  }

  async function verifyPlayback(request) {
    if (!accessAllowed(request)) return false;
    const order = request.orderId ? store.viewerOrderById(request.orderId) :
      store.legacyOrderForRenewal(request.offer, request.rentalExpiresAt);
    if (!order) return false;
    if (order.verifiedAt > Date.now() / 1000 - 300) return true;
    return (await reconcile(order)).status === 'paid';
  }

  async function position({offer,token,seconds,memberId}) {
    const order = store.viewerOrderForAccess(await viewerHash(token));
    if (!order || !Number.isSafeInteger(seconds) || seconds < 0 ||
        !accessAllowed({offer,orderId:order.orderId,kind:order.kind})) throw new ViewerCheckoutError('Playback unavailable.',403);
    if (offer.type === 'program') {
      const member = offer.lineup.find(item => item.id === memberId);
      if (!member || !store.setProgramPosition(order.orderId, memberId, seconds >= member.duration ? 0 : seconds)) {
        throw new ViewerCheckoutError('Title unavailable.',403);
      }
    } else store.setViewerPosition(order.orderId, seconds >= offer.duration ? 0 : seconds);
    return {saved:true};
  }

  async function verifyPurchase({ offer, orderId }) {
    if (typeof orderId !== 'string' || orderId.length > 64) return false;
    const order = store.viewerOrderById(orderId);
    if (order?.kind !== 'buy' || !(order.intentId || (order.couponId && order.amount===0 && order.paidAt)) || !existingOrderMatches(order, offer)) return false;
    return (await reconcile(order)).status === 'paid';
  }

  async function abandon({ offer, token, resolveEdition }) {
    const order = store.viewerOrderForToken(await viewerHash(token));
    offer = orderedOffer(offer, order, resolveEdition);
    if (!order || !existingOrderMatches(order,offer)) return {status:'pending'};
    store.withdrawViewerOrder(order.orderId);
    await closeWithdrawnSession(order);
    const fresh = store.viewerOrderById(order.orderId);
    if (fresh.paidAt) return {status:'paid'};
    return {status:fresh.status === 'expired' || (!fresh.sessionId && fresh.withdrawalState) ? 'expired' : 'pending'};
  }

  async function adjustmentWebhook(event, platformEvent, eventAccount) {
    const hint = adjustmentReference(event);
    if (!hint || (!platformEvent && !store.hasViewerSellerAccount(eventAccount)) || store.paymentEventSeen(eventAccount,event.id)) return;
    let order = platformEvent ? store.viewerOrderByPlatformPayment(eventAccount,hint.intentId,hint.chargeId) :
      store.viewerOrderByPayment(eventAccount,hint.intentId,hint.chargeId);
    if (!order) {
      // A refund can arrive before the paid Session event has bound the intent.
      const platformId = await checkingPlatform();
      if (!platformEvent && platformId === eventAccount) return;
      const account = platformEvent ? null : eventAccount;
      const intentId = hint.intentId ?? await adjustmentReader(key,account,fetchImpl).chargeIntent(hint.chargeId);
      if (!INTENT.test(intentId)) return;
      const stripe = platformEvent ? paymentClient(key,null,fetchImpl) : connectedClient(key,account,platformId,fetchImpl);
      const intent = await stripe.paymentIntents.retrieve(intentId,{expand:['latest_charge']},CHECKOUT_API);
      if (intent.livemode !== live || ![FLOW,LEGACY_FLOW].includes(intent.metadata?.flow) || intent.latest_charge?.id !== hint.chargeId) return;
      order = store.viewerOrderById(intent.metadata.order);
      if (!order || !sameMetadata(intent.metadata,order)) return;
    }
    if (isMarketplace(order) !== platformEvent || (platformEvent ? order.platform : order.account) !== eventAccount) return;
    if (!order.sessionId) throw new ViewerCheckoutError('Session registration is still pending.',503);
    const result = await reconcile(order,undefined,undefined,hint);
    if (result.status === 'pending') throw new ViewerCheckoutError('Payment confirmation is pending.',503);
    store.notePaymentEvent(eventAccount,event.id,order.orderId);
  }

  async function refreshProcessingFee(order) {
    const stripe = await client(order);
    const intent = await stripe.paymentIntents.retrieve(order.intentId, {expand:['latest_charge.balance_transaction']},
      order.uiMode === 'hosted' ? undefined : CHECKOUT_API);
    const total = order.chargedTotalCents ?? (isMarketplace(order) ? null : orderTotal(order));
    const applicationFee = isMarketplace(order) ? 0 : order.tipAmount;
    checkIntent(intent, order, order.intentId, total, applicationFee, live);
    const charge = checkCharge(intent, order, total, applicationFee, live);
    if (order.chargeId && charge.id !== order.chargeId) throw mismatch();
    const fee = processingFee(order, charge, total, applicationFee);
    if (fee !== null) store.recordProcessingFee(order, charge.id, charge.balance_transaction.id, fee);
  }

  async function retryProcessingFees() {
    const orders = store.claimProcessingFeeChecks(await checkingPlatform());
    const results = await Promise.allSettled(orders.map(refreshProcessingFee));
    return results.every(result => result.status === 'fulfilled');
  }

  async function webhook(rawBody, signature, platformEvent = false) {
    const secret = platformEvent ? env.STRIPE_PLATFORM_WEBHOOK_SECRET : webhookSecret;
    if (!serverConfigured || !secret || (live && !liveWebhooks)) throw new ViewerCheckoutError('Payment updates are unavailable.', 503);
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) throw new ViewerCheckoutError('Invalid webhook payload.');
    if (Buffer.byteLength(rawBody) > 512 * 1024) throw new ViewerCheckoutError('Webhook payload is too large.', 413);
    const text = typeof rawBody === 'string' ? rawBody : new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const { valid } = await verifyStripeSignature(text, signature, secret);
    if (!valid) throw new ViewerCheckoutError('Invalid webhook signature.');
    let event;
    try { event = JSON.parse(text); } catch { throw new ViewerCheckoutError('Invalid webhook payload.'); }
    const object = event?.data?.object;
    if (event?.object !== 'event' || event.livemode !== live || (object?.livemode !== undefined && object.livemode !== live) || !/^evt_[a-zA-Z0-9]+$/.test(event.id) ||
        (platformEvent ? event.account != null : !/^acct_[a-zA-Z0-9]+$/.test(event.account))) return {received:true};
    const eventAccount = platformEvent ? await checkingPlatform() : event.account;
    if (event.type === 'charge.updated') {
      if (object?.object === 'charge' && object.livemode === live && /^ch_[a-zA-Z0-9]+$/.test(object.id) && INTENT.test(object.payment_intent)) {
        const order = platformEvent ? store.viewerOrderByPlatformPayment(eventAccount,object.payment_intent,object.id) :
          store.viewerOrderByPayment(eventAccount,object.payment_intent,object.id);
        if (order?.paidAt && order.stripeFeeCents === null && order.intentId === object.payment_intent && (!order.chargeId || order.chargeId === object.id)) {
          await refreshProcessingFee(order);
        }
      }
      return {received:true};
    }
    if (adjustmentEvents.has(event.type)) { await adjustmentWebhook(event,platformEvent,eventAccount); return {received:true}; }
    if (!sessionEvents.has(event.type) ||
        ![FLOW, LEGACY_FLOW].includes(object?.metadata?.flow) || sessionMode(object.id) !== mode) return { received: true };
    const order = store.viewerOrderById(object.metadata.order);
    if (!order || platformEvent !== isMarketplace(order) || eventAccount !== (platformEvent ? order.platform : order.account)) return { received: true };
    if (!order.sessionId) throw new ViewerCheckoutError('Session registration is still pending.', 503);
    if (order.sessionId !== object.id) throw mismatch();
    const confirmsPayment = event.type !== 'checkout.session.async_payment_failed' && object.status === 'complete' && ['paid','no_payment_required'].includes(object.payment_status);
    const paidEvent = confirmsPayment ? { intent: object.payment_intent, created: event.created } : undefined;
    const result = await reconcile(order, undefined, paidEvent);
    if (confirmsPayment && result.status === 'pending') throw new ViewerCheckoutError('Payment confirmation is still pending.', 503);
    store.noteViewerWebhook(order.orderId, event.id);
    return { received: true };
  }

  // Populate address fingerprints for older, still-valid orders without mailing viewers.
  async function indexPreviousOrders() {
    let cursor = 0;
    for (;;) {
      const rows = store.previousRecoveryOrders(cursor);
      if (!rows.length) return;
      for (const order of rows) {
        cursor = order.cursor;
        try { await reconcile(order); }
        catch { console.error('A previous Stream payment could not be indexed for email recovery.'); }
      }
    }
  }

  async function retryFilmmakerTransfers() {
    let interrupted = false;
    for (const order of store.pendingViewerTransfers()) {
      try { await reconcile(order); }
      catch { interrupted = true; store.retryViewerTransfer(order.orderId); }
    }
    return !interrupted;
  }

  async function rentalCustomer(orderId) {
    const order = store.viewerOrderById(orderId);
    if (!order?.paidAt || order.kind !== 'rent') throw mismatch();
    const stripe = await client(order);
    const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
    const session = await stripe.checkout.sessions.retrieve(order.sessionId, options);
    checkSession(session, order, live);
    const free = order.couponId && order.amount === 0;
    if (session.status !== 'complete' || (session.payment_status !== 'paid' && !(free && session.payment_status === 'no_payment_required')) || (!free && !order.intentId) || (session.payment_intent ?? null) !== order.intentId) throw mismatch();
    const email = mailbox(session.customer_details?.email);
    if (email || !order.intentId) return email ?? null;
    const intent = await stripe.paymentIntents.retrieve(order.intentId, {expand:['latest_charge']}, options);
    const charge = intent.latest_charge;
    if (intent.id !== order.intentId || intent.livemode !== live || !/^ch_[a-zA-Z0-9]+$/.test(charge?.id) ||
        (order.chargeId && charge.id !== order.chargeId) ||
        charge.payment_intent !== order.intentId || charge.livemode !== live) throw mismatch();
    return mailbox(charge.billing_details?.email) ?? null;
  }

  function guarded(fn) {
    return async (...args) => {
      try { return await fn(...args); }
      catch (error) {
        if (error instanceof ViewerCheckoutError) throw error;
        if (error.code === 'viewer_tip_invalid') throw new ViewerCheckoutError(error.message);
        if (error.code === 'coupon_invalid') throw Object.assign(new ViewerCheckoutError(error.message,422),{code:error.code});
        if (error.code === 'viewer_offer_changed') throw new ViewerCheckoutError('The film offer changed. Reload the player.', 409);
        if (error.code === 'viewer_rate_limit') throw new ViewerCheckoutError('This film reached its checkout limit. Try again later.', 429);
        throw new ViewerCheckoutError('Checkout is temporarily unavailable. Try again.', 503);
      }
    };
  }

  return { configured, rentalCustomer:guarded(rentalCustomer), platformId:checkingPlatform, salesTerritory, manualNmEnabled, indexPreviousOrders, retryProcessingFees, retryFilmmakerTransfers, closeWithdrawnSessions, start: guarded(start), abandon: guarded(abandon), status: guarded(status), position:guarded(position), verifyPlayback:guarded(verifyPlayback), accessAllowed,
    verifyPurchase: guarded(verifyPurchase), webhook: guarded(webhook) };
}
