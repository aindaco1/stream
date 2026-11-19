import { sha256Hex } from '@dustwave/worker-core/crypto';
import { verifyStripeSignature } from '@dustwave/worker-core/stripe';
import { connectedClient, platformAccount, verifyReadySeller } from './connected-test-rental.js';
import { rentalScope } from './rental.js';
import { isPrice } from './prices.js';

const LEGACY_FLOW = 'stream-viewer-rental';
const FLOW = 'stream-viewer-checkout';
const EMBEDDED_API = { stripeVersion: '2026-10-28.endive' };
const SESSION = /^cs_test_[a-zA-Z0-9]+$/;
const INTENT = /^pi_[a-zA-Z0-9]+$/;
const RENTAL_SECONDS = 48 * 3600;

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

function matchingOffer(order, offer) {
  return order.filmId === offer.id && order.owner === offer.owner && order.account === offer.account &&
    order.scope === offer.scope && order.revision === offer.revision;
}

function metadata(order) {
  const markers = { order: order.orderId, product: 'stream-rental-prototype',
    scope: rentalScope({ film: order.scope, revision: order.revision }) };
  return order.uiMode === 'hosted' ? { ...markers, flow: LEGACY_FLOW } :
    { ...markers, flow: FLOW, kind: order.kind, amount: String(order.amount) };
}

function sameMetadata(data, order) {
  if (order.uiMode === 'hosted' && (order.kind !== 'rent' || order.amount !== 99 || data?.kind || data?.amount)) return false;
  return Object.entries(metadata(order)).every(([k, v]) => data?.[k] === v);
}

function checkSession(session, order) {
  if (session?.object !== 'checkout.session' || !SESSION.test(session.id) || (order.sessionId && session.id !== order.sessionId) ||
      session.livemode !== false || session.mode !== 'payment' || session.currency !== 'usd' ||
      (order.uiMode === 'embedded_page' && session.ui_mode !== 'embedded_page') ||
      session.amount_subtotal !== order.amount || session.amount_total !== order.amount || session.client_reference_id !== order.orderId ||
      !sameMetadata(session.metadata, order)) throw mismatch();
}

function checkIntent(intent, order, intentId) {
  if (intent?.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== false ||
      intent.currency !== 'usd' || intent.amount !== order.amount || !sameMetadata(intent.metadata, order) ||
      intent.transfer_data || intent.application_fee_amount || intent.on_behalf_of) throw mismatch();
}

function checkCharge(intent, order) {
  const charge = intent.latest_charge;
  if (intent.status !== 'succeeded' || intent.amount_received !== order.amount ||
      charge?.object !== 'charge' || !/^ch_[a-zA-Z0-9]+$/.test(charge.id) || charge.payment_intent !== intent.id ||
      charge.livemode !== false || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded' ||
      charge.amount !== order.amount || charge.amount_captured !== order.amount || charge.currency !== 'usd' || charge.transfer_data ||
      charge.application_fee || charge.application_fee_amount || charge.on_behalf_of ||
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

  function shared(map, id, action) {
    if (!map.has(id)) map.set(id, action().finally(() => map.delete(id)));
    return map.get(id);
  }

  async function openSession(order) {
    const expired = () => new ViewerCheckoutError('This order has expired. Start a new checkout.', 410);
    if (order.status === 'expired' || abandoned(order)) throw expired();
    if (order.status === 'paid') {
      if ((await reconcile(order)).status === 'paid') return { status: 'paid' };
      throw expired();
    }
    const stripe = await client(order);
    const options = order.uiMode === 'hosted' ? undefined : EMBEDDED_API;
    let session;
    if (order.sessionId) {
      session = await stripe.checkout.sessions.retrieve(order.sessionId, options);
    } else {
      if (order.uiMode === 'hosted') throw new ViewerCheckoutError('Start a new checkout for this film.', 410);
      await verifyReadySeller({ store, env, fetchImpl, owner: order.owner, account: order.account });
      const markers = metadata(order);
      session = await stripe.checkout.sessions.create({
        mode: 'payment', ui_mode: 'embedded_page', redirect_on_completion: 'never', adaptive_pricing: { enabled: false },
        client_reference_id: order.orderId, metadata: markers, payment_intent_data: { metadata: markers },
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: order.amount,
          product_data: { name: order.title, description: order.kind === 'rent' ?
            '48-hour streaming rental, starting at purchase.' : 'One-time purchase with original file download.' } } }]
      }, { ...options, idempotencyKey: 'stream-viewer-' + order.orderId });
      checkSession(session, order);
      store.bindViewerSession(order.orderId, session.id);
    }
    checkSession(session, order);
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
    if (session.status !== 'open' || typeof session.client_secret !== 'string' ||
        !session.client_secret.startsWith(session.id + '_secret_') || session.client_secret.length > 1024) throw mismatch();
    return { clientSecret: session.client_secret, publishableKey, account: order.account };
  }

  async function start({ offer, token, origin, kind = 'rent' }) {
    if (!configured) throw new ViewerCheckoutError('Sandbox checkout is unavailable.', 503);
    if (kind !== 'rent' && kind !== 'buy') throw new ViewerCheckoutError('Choose a rental or a purchase.');
    const digest = await viewerHash(token);
    const base = landingOrigin(origin, env.STREAM_PUBLIC_ORIGIN);
    const previous = store.viewerOrderForToken(digest);
    const amount = previous?.amount ?? offer.prices?.[kind];
    if (!isPrice(amount)) throw new ViewerCheckoutError('This option is unavailable for this film.', 409);
    const id = await checkingPlatform();
    if (offer.account === id) throw mismatch();
    const order = previous ?? store.reserveViewerOrder({ ...offer, tokenHash: digest, platform: id, origin: base, kind, amount });
    if (!matchingOffer(order, offer) || order.kind !== kind || order.platform !== id || order.origin !== base) throw mismatch();
    return shared(creating, order.orderId, () => openSession(order));
  }

  async function reconcile(order, retrievedSession, paidEvent) {
    return shared(checking, order.orderId, async () => {
      const stripe = await client(order);
      const options = order.uiMode === 'hosted' ? undefined : EMBEDDED_API;
      const session = retrievedSession ?? await stripe.checkout.sessions.retrieve(order.sessionId, options);
      checkSession(session, order);
      if (session.status === 'expired') {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      if (session.status === 'open' && session.payment_status === 'unpaid') return { status: 'pending' };
      if (session.status !== 'complete' || !['unpaid','paid'].includes(session.payment_status) || !INTENT.test(session.payment_intent)) throw mismatch();
      const intent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] }, options);
      checkIntent(intent, order, session.payment_intent);
      if (session.payment_status === 'unpaid') {
        if (['canceled','requires_payment_method'].includes(intent.status)) {
          store.expireViewerOrder(order.orderId);
          return { status: 'expired' };
        }
        return { status: 'pending' };
      }
      const charge = checkCharge(intent, order);
      if (charge.refunded || charge.amount_refunded > 0 || charge.disputed) {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      const now = Math.floor(Date.now() / 1000);
      const useConfirmation = order.uiMode === 'embedded_page' && order.kind === 'rent' && charge.payment_method_details?.type !== 'card';
      // A bank debit can create its Charge days before it succeeds. Stripe's
      // paid event dates that success; a missed webhook uses first verified payment.
      const datedEvent = paidEvent?.intent === intent.id && Number.isSafeInteger(paidEvent.created) &&
        paidEvent.created >= charge.created && paidEvent.created <= now;
      const confirmed = datedEvent ? paidEvent.created : now;
      const paidAt = store.fulfillViewerOrder(order.orderId, session.id, intent.id, useConfirmation ? confirmed : charge.created);
      if (paidAt === undefined) {
        if (store.viewerOrderById(order.orderId)?.status === 'expired') return { status: 'expired' };
        throw mismatch();
      }
      if (paidAt < charge.created || paidAt > now || (!useConfirmation && paidAt !== charge.created)) throw mismatch();
      if (order.kind === 'rent' && paidAt + RENTAL_SECONDS <= now) {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      return { status: 'paid', intent, paidAt };
    });
  }

  async function status({ offer, token }) {
    const order = store.viewerOrderForToken(await viewerHash(token));
    if (!order || !matchingOffer(order, offer)) return { status: 'pending' };
    if (order.status === 'expired' || abandoned(order) ||
        (order.kind === 'rent' && order.paidAt && order.paidAt + RENTAL_SECONDS <= Math.floor(Date.now() / 1000))) return { status: 'expired' };
    if (!order.sessionId) return { status: 'pending' };
    if (order.status === 'pending' && !checking.has(order.orderId) && !store.checkPendingViewerOrder(order.orderId)) return { status: 'pending' };
    const result = await reconcile(order);
    if (result.status !== 'paid') return result;
    const film = { film: offer.scope, revision: offer.revision };
    const receipt = order.kind === 'buy' ?
      await offer.authority.issuePurchaseReceipt(result.intent, film, { amount: order.amount, orderId: order.orderId }) :
      await offer.authority.issueReceipt(result.intent, film, { amount: order.amount, paidAt: result.paidAt });
    return { status: 'paid', kind: order.kind, receipt };
  }

  async function verifyPurchase({ offer, orderId }) {
    if (typeof orderId !== 'string' || orderId.length > 64) return false;
    const order = store.viewerOrderById(orderId);
    if (order?.kind !== 'buy' || order.status !== 'paid' || !order.intentId || !matchingOffer(order, offer)) return false;
    return (await reconcile(order)).status === 'paid';
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
        !['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type) ||
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

  return { configured, start: guarded(start), status: guarded(status), verifyPurchase: guarded(verifyPurchase), webhook: guarded(webhook) };
}
