import { sha256Hex } from '@dustwave/worker-core/crypto';
import { verifyStripeSignature } from '@dustwave/worker-core/stripe';
import { connectedClient, platformAccount, verifyReadySeller } from './connected-test-rental.js';
import { rentalScope } from './rental.js';
import { isPrice } from './prices.js';
import { adjustmentEvents, adjustmentReader, adjustmentReference } from './payment-adjustments.js';
import { orderTotal, processingFee, tipFor } from './checkout-tips.js';

const LEGACY_FLOW = 'stream-viewer-rental';
const FLOW = 'stream-viewer-checkout';
const CHECKOUT_API = { stripeVersion: '2026-10-28.endive' };
const SESSION = /^cs_test_[a-zA-Z0-9]+$/;
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
  const markers = { order: order.orderId, product: 'stream-rental-prototype',
    scope: rentalScope({ film: order.scope, revision: order.revision }) };
  return order.uiMode === 'hosted' ? { ...markers, flow: LEGACY_FLOW } :
    { ...markers, flow: FLOW, kind: order.kind, amount: String(orderTotal(order)),
      ...(order.tipAmount > 0 && { film_amount:String(order.amount), tip_percent:String(order.tipPercent), tip_amount:String(order.tipAmount) }) };
}

function sameMetadata(data, order) {
  if (!order.tipAmount && (data?.tip_percent !== undefined || data?.tip_amount !== undefined || data?.film_amount !== undefined)) return false;
  if (order.uiMode === 'hosted' && (order.kind !== 'rent' || order.amount !== 99 || data?.kind || data?.amount)) return false;
  return Object.entries(metadata(order)).every(([k, v]) => data?.[k] === v);
}

function checkSession(session, order) {
  if (session?.object !== 'checkout.session' || !SESSION.test(session.id) || (order.sessionId && session.id !== order.sessionId) ||
      session.livemode !== false || session.mode !== 'payment' || session.currency !== 'usd' ||
      (order.uiMode !== 'hosted' && session.ui_mode !== order.uiMode) ||
      session.amount_subtotal !== orderTotal(order) || session.amount_total !== orderTotal(order) || session.client_reference_id !== order.orderId ||
      !sameMetadata(session.metadata, order)) throw mismatch();
}

function checkIntent(intent, order, intentId) {
  if (intent?.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== false ||
      intent.currency !== 'usd' || intent.amount !== orderTotal(order) || !sameMetadata(intent.metadata, order) ||
      intent.transfer_data || (intent.application_fee_amount ?? 0) !== order.tipAmount || intent.on_behalf_of) throw mismatch();
}

function checkCharge(intent, order) {
  const charge = intent.latest_charge;
  const total = orderTotal(order);
  if (intent.status !== 'succeeded' || intent.amount_received !== total ||
      charge?.object !== 'charge' || !/^ch_[a-zA-Z0-9]+$/.test(charge.id) || charge.payment_intent !== intent.id ||
      charge.livemode !== false || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded' ||
      charge.amount !== total || charge.amount_captured !== total || charge.currency !== 'usd' || charge.transfer_data ||
      (charge.application_fee_amount ?? 0) !== order.tipAmount || charge.on_behalf_of ||
      (charge.application_fee != null && (!order.tipAmount || !/^fee_[a-zA-Z0-9]+$/.test(charge.application_fee))) ||
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
  const serverConfigured = /^(sk|rk)_test_[a-zA-Z0-9]+$/.test(key) && env.STRIPE_CONNECT_LIVE !== '1';
  const configured = serverConfigured && /^pk_test_[a-zA-Z0-9]+$/.test(publishableKey);
  let platform;
  const creating = new Map();
  const checking = new Map();
  const withdrawing = new Map();
  const checkingPlatform = () => {
    if (!serverConfigured) throw new ViewerCheckoutError('Sandbox checkout is unavailable.', 503);
    platform ??= platformAccount(key, fetchImpl).catch(error => { platform = undefined; throw error; });
    return platform;
  };
  async function client(order) {
    const id = await checkingPlatform();
    if (id !== order.platform) throw mismatch();
    return connectedClient(key, order.account, id, fetchImpl);
  }

  function existingOrderMatches(order, offer) {
    return sameFilm(order, offer) && (order.account === offer.account ||
      (offer.account === null && store.ownsTestAccount(order.owner, order.account)));
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
        if (!store.ownsTestAccount(order.owner,order.account) || !SESSION.test(order.sessionId)) throw mismatch();
        const stripe = await client(order);
        const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
        const read = () => stripe.checkout.sessions.retrieve(order.sessionId, options);
        let session = await read();
        checkSession(session, order);
        if (session.status === 'open' && session.payment_status === 'unpaid') {
          try {
            session = await stripe.checkout.sessions.expire(session.id,options);
          } catch {
            // Confirmation, another expiration, or a lost network response
            // can win the race. Only Stripe's current status decides the result.
            session = await read();
          }
          checkSession(session,order);
        }
        if (session.status === 'expired') store.expireViewerOrder(order.orderId);
        else if (session.status === 'complete') await reconcile(order,session);
        else throw new ViewerCheckoutError('The unfinished checkout still needs to close.',503);
      }
      store.finishWithdrawal(order.orderId,order.sessionId);
    });
  }

  async function closeWithdrawnSessions(owner,filmId) {
    const orders = store.requestedWithdrawals(owner,filmId);
    for (let i=0; i<orders.length; i+=4) {
      await Promise.all(orders.slice(i,i+4).map(async order => {
        try { await closeWithdrawnSession(order); }
        catch { store.retryWithdrawal(order.orderId); }
      }));
    }
    return owner ? store.pendingWithdrawals(owner,filmId) : undefined;
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
      await verifyReadySeller({ store, env, fetchImpl, owner: order.owner, account: order.account });
      if (store.viewerOrderById(order.orderId).withdrawalState) throw expired();
      const markers = metadata(order);
      // Retried creates must send the parameters from the order's original UI.
      const redirect = order.uiMode === 'elements' ?
        { return_url: order.origin + '/embed/' + encodeURIComponent(order.filmId) + '?order=' + order.orderId } :
        { redirect_on_completion: 'never' };
      const lineItems = [{ quantity: 1, price_data: { currency: 'usd', unit_amount: order.amount,
        product_data: { name: order.title, description: order.kind === 'rent' ?
          order.rentalHours + '-hour streaming rental, starting at purchase.' : 'One-time purchase with original file download.' } } }];
      if (order.tipAmount) lineItems.push({ quantity:1, price_data:{currency:'usd',unit_amount:order.tipAmount,
        product_data:{name:'Optional tip to Dust Wave'}} });
      session = await stripe.checkout.sessions.create({
        mode: 'payment', ui_mode: order.uiMode, ...redirect, adaptive_pricing: { enabled: false },
        ...(order.cardOnly ? { allowed_payment_method_types: ['card'] } : {}),
        client_reference_id: order.orderId, metadata: markers, payment_intent_data: {
          metadata: markers, ...(order.tipAmount > 0 && { application_fee_amount:order.tipAmount })
        }, line_items:lineItems
      }, { ...options, idempotencyKey: 'stream-viewer-' + order.orderId });
      checkSession(session, order);
      store.bindViewerSession(order.orderId, session.id);
    }
    checkSession(session, order);
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
    return { clientSecret: session.client_secret, publishableKey, account: order.account,
      uiMode: order.uiMode, orderId: order.orderId, title: order.title, kind: order.kind, amount: orderTotal(order),
      filmAmount:order.amount, tipPercent:order.tipPercent, tipAmount:order.tipAmount, currency: session.currency,
      ...(order.kind === 'rent' && {rentalHours:order.rentalHours}) };
  }

  async function start({ offer, token, origin, kind = 'rent', tipPercent = 0 }) {
    if (!configured) throw new ViewerCheckoutError('Sandbox checkout is unavailable.', 503);
    if (!offer.account) throw mismatch();
    if (kind !== 'rent' && kind !== 'buy') throw new ViewerCheckoutError('Choose a rental or a purchase.');
    const digest = await viewerHash(token);
    const base = landingOrigin(origin, env.STREAM_PUBLIC_ORIGIN);
    const previous = store.viewerOrderForToken(digest);
    const amount = previous?.amount ?? offer.prices?.[kind];
    if (!isPrice(amount)) throw new ViewerCheckoutError('This option is unavailable for this film.', 409);
    if (tipFor(amount,tipPercent) === null) throw new ViewerCheckoutError('Choose an available tip amount.');
    const id = await checkingPlatform();
    if (offer.account === id) throw mismatch();
    const order = previous ?? store.reserveViewerOrder({ ...offer, tokenHash: digest, platform: id, origin: base, kind, amount, tipPercent });
    if (!sameFilm(order, offer) || order.kind !== kind || order.tipPercent !== tipPercent || order.platform !== id || order.origin !== base) throw mismatch();
    if (order.account !== offer.account) {
      // openSession can only reconcile a paid/withdrawn order here. Never
      // disclose an old open form or create a charge on a former recipient.
      if (!(order.withdrawalState || order.status === 'paid') || !store.ownsTestAccount(order.owner, order.account) ||
          !store.ownsTestAccount(offer.owner, offer.account)) throw mismatch();
    }
    return shared(creating, order.orderId, () => openSession(order));
  }

  async function reconcileOnce(order, retrievedSession, paidEvent, adjustment) {
    const stripe = await client(order);
    const options = order.uiMode === 'hosted' ? undefined : CHECKOUT_API;
    const session = retrievedSession ?? await stripe.checkout.sessions.retrieve(order.sessionId, options);
    checkSession(session, order);
    if (session.status === 'expired') {
      store.expireViewerOrder(order.orderId);
      return { status: 'expired' };
    }
    if (session.status === 'open' && session.payment_status === 'unpaid') return { status: 'pending' };
    if (session.status !== 'complete' || !['unpaid','paid'].includes(session.payment_status) || !INTENT.test(session.payment_intent)) throw mismatch();
    const intent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge.balance_transaction'] }, options);
    checkIntent(intent, order, session.payment_intent);
    if (session.payment_status === 'unpaid') {
      if (['canceled','requires_payment_method'].includes(intent.status)) {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }
    const charge = checkCharge(intent, order);
    if ((adjustment && (charge.id !== adjustment.chargeId || (adjustment.intentId && intent.id !== adjustment.intentId))) ||
        (order.intentId && order.intentId !== intent.id) || (order.chargeId && order.chargeId !== charge.id)) throw mismatch();
    const paymentState = await adjustmentReader(key,order.account,fetchImpl).state(order,charge,adjustment);
    const now = Math.floor(Date.now() / 1000);
    const useConfirmation = order.uiMode !== 'hosted' && order.kind === 'rent' && charge.payment_method_details?.type !== 'card';
    // A bank debit can create its Charge days before it succeeds. Stripe's
    // paid event dates that success; a missed webhook uses first verified payment.
    const datedEvent = paidEvent?.intent === intent.id && Number.isSafeInteger(paidEvent.created) &&
      paidEvent.created >= charge.created && paidEvent.created <= now;
    const confirmed = datedEvent ? paidEvent.created : now;
    const paidAt = order.paidAt ?? (useConfirmation ? confirmed : charge.created);
    if (paidAt < charge.created || paidAt > now || (!useConfirmation && paidAt !== charge.created)) throw mismatch();
    const saved = store.reconcileViewerPayment(order,{intentId:intent.id,paidAt,stripeFeeCents:processingFee(order,charge),...paymentState});
    if (!saved) return;
    const status = localStatus(saved);
    if (status === 'paid') store.rememberViewerEmail(order.orderId, session.customer_details?.email || charge.billing_details?.email);
    return status === 'paid' ? {status,intent,paidAt:saved.paidAt,paymentState} : {status};
  }

  async function reconcile(order, retrievedSession, paidEvent, adjustment) {
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

  async function status({ offer, token }) {
    const order = store.viewerOrderForAccess(await viewerHash(token));
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
    const options = { amount:orderTotal(order), orderId:order.orderId, paymentState:result.paymentState };
    const receipt = order.kind === 'buy' ? await offer.authority.issuePurchaseReceipt(result.intent,film,options) :
      await offer.authority.issueReceipt(result.intent,film,{...options,paidAt:result.paidAt,rentalHours:order.rentalHours});
    return { status:'paid',kind:order.kind,receipt,title:order.title,position:order.position || 0,
      expiresAt:expiresAt({...order,paidAt:result.paidAt}),...(order.kind === 'rent' && {rentalHours:order.rentalHours}) };
  }

  function accessAllowed({offer,orderId,kind,rentalExpiresAt}) {
    if (!orderId) return kind === 'rent' && Number.isSafeInteger(rentalExpiresAt) && rentalExpiresAt > Date.now()/1000 &&
      store.accessForLegacyRental(offer,rentalExpiresAt);
    const order = store.viewerAccessById(orderId);
    return Boolean(order && existingOrderMatches(order,offer) && order.kind === kind && order.intentId && localStatus(order) === 'paid');
  }

  async function verifyPlayback(request) {
    if (!accessAllowed(request)) return false;
    const order = request.orderId ? store.viewerOrderById(request.orderId) :
      store.legacyOrderForRenewal(request.offer, request.rentalExpiresAt);
    if (!order) return false;
    if (order.verifiedAt > Date.now() / 1000 - 300) return true;
    return (await reconcile(order)).status === 'paid';
  }

  async function position({offer,token,seconds}) {
    const order = store.viewerOrderForAccess(await viewerHash(token));
    if (!order || !Number.isSafeInteger(seconds) || seconds < 0 ||
        !accessAllowed({offer,orderId:order.orderId,kind:order.kind})) throw new ViewerCheckoutError('Playback unavailable.',403);
    store.setViewerPosition(order.orderId, seconds >= offer.duration ? 0 : seconds);
    return {saved:true};
  }

  async function verifyPurchase({ offer, orderId }) {
    if (typeof orderId !== 'string' || orderId.length > 64) return false;
    const order = store.viewerOrderById(orderId);
    if (order?.kind !== 'buy' || !order.intentId || !existingOrderMatches(order, offer)) return false;
    return (await reconcile(order)).status === 'paid';
  }

  async function abandon({ offer, token }) {
    const order = store.viewerOrderForToken(await viewerHash(token));
    if (!order || !existingOrderMatches(order,offer)) return {status:'pending'};
    store.withdrawViewerOrder(order.orderId);
    await closeWithdrawnSession(order);
    const fresh = store.viewerOrderById(order.orderId);
    if (fresh.paidAt) return {status:'paid'};
    return {status:fresh.status === 'expired' || (!fresh.sessionId && fresh.withdrawalState) ? 'expired' : 'pending'};
  }

  async function adjustmentWebhook(event) {
    const hint = adjustmentReference(event);
    if (!hint || !store.hasViewerSellerAccount(event.account) || store.paymentEventSeen(event.account,event.id)) return;
    let order = store.viewerOrderByPayment(event.account,hint.intentId,hint.chargeId);
    if (!order) {
      // A refund can arrive before the paid Session event has bound the intent.
      const platformId = await checkingPlatform();
      if (platformId === event.account) return;
      const intentId = hint.intentId ?? await adjustmentReader(key,event.account,fetchImpl).chargeIntent(hint.chargeId);
      if (!INTENT.test(intentId)) return;
      const intent = await connectedClient(key,event.account,platformId,fetchImpl).paymentIntents.retrieve(intentId,{expand:['latest_charge']},CHECKOUT_API);
      if (![FLOW,LEGACY_FLOW].includes(intent.metadata?.flow) || intent.latest_charge?.id !== hint.chargeId) return;
      order = store.viewerOrderById(intent.metadata.order);
      if (!order || order.account !== event.account || !sameMetadata(intent.metadata,order)) return;
    }
    if (!order.sessionId) throw new ViewerCheckoutError('Session registration is still pending.',503);
    const result = await reconcile(order,undefined,undefined,hint);
    if (result.status === 'pending') throw new ViewerCheckoutError('Payment confirmation is pending.',503);
    store.notePaymentEvent(event.account,event.id,order.orderId);
  }

  async function webhook(rawBody, signature) {
    if (!serverConfigured || !webhookSecret) throw new ViewerCheckoutError('Sandbox webhook is unavailable.', 503);
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) throw new ViewerCheckoutError('Invalid webhook payload.');
    if (Buffer.byteLength(rawBody) > 512 * 1024) throw new ViewerCheckoutError('Webhook payload is too large.', 413);
    const text = typeof rawBody === 'string' ? rawBody : new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const { valid } = await verifyStripeSignature(text, signature, webhookSecret);
    if (!valid) throw new ViewerCheckoutError('Invalid webhook signature.');
    let event;
    try { event = JSON.parse(text); } catch { throw new ViewerCheckoutError('Invalid webhook payload.'); }
    const object = event?.data?.object;
    if (event?.object !== 'event' || event.livemode !== false || !/^evt_[a-zA-Z0-9]+$/.test(event.id) ||
        !/^acct_[a-zA-Z0-9]+$/.test(event.account)) return {received:true};
    if (adjustmentEvents.has(event.type)) { await adjustmentWebhook(event); return {received:true}; }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type) ||
        ![FLOW, LEGACY_FLOW].includes(object?.metadata?.flow) || !SESSION.test(object.id)) return { received: true };
    const order = store.viewerOrderById(object.metadata.order);
    if (!order || event.account !== order.account) return { received: true };
    if (!order.sessionId) throw new ViewerCheckoutError('Session registration is still pending.', 503);
    if (order.sessionId !== object.id) throw mismatch();
    const confirmsPayment = event.type !== 'checkout.session.async_payment_failed' && object.status === 'complete' && object.payment_status === 'paid';
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

  function guarded(fn) {
    return async (...args) => {
      try { return await fn(...args); }
      catch (error) {
        if (error instanceof ViewerCheckoutError) throw error;
        if (error.code === 'viewer_offer_changed') throw new ViewerCheckoutError('The film offer changed. Reload the player.', 409);
        if (error.code === 'viewer_rate_limit') throw new ViewerCheckoutError('This film reached its sandbox checkout limit. Try again later.', 429);
        throw new ViewerCheckoutError('Checkout is temporarily unavailable. Try again.', 503);
      }
    };
  }

  return { configured, indexPreviousOrders, closeWithdrawnSessions, start: guarded(start), abandon: guarded(abandon), status: guarded(status), position:guarded(position), verifyPlayback:guarded(verifyPlayback), accessAllowed,
    verifyPurchase: guarded(verifyPurchase), webhook: guarded(webhook) };
}
