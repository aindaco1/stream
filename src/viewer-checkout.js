import { sha256Hex } from '@dustwave/worker-core/crypto';
import { verifyStripeSignature } from '@dustwave/worker-core/stripe';
import { connectedClient, platformAccount, verifyReadySeller } from './connected-test-rental.js';
import { rentalScope } from './rental.js';

const FLOW = 'stream-viewer-rental';
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
  return { flow: FLOW, order: order.orderId, product: 'stream-rental-prototype',
    scope: rentalScope({ film: order.scope, revision: order.revision }) };
}

function sameMetadata(data, order) {
  return Object.entries(metadata(order)).every(([k, v]) => data?.[k] === v);
}

function checkSession(session, order) {
  if (session?.object !== 'checkout.session' || !SESSION.test(session.id) || (order.sessionId && session.id !== order.sessionId) ||
      session.livemode !== false || session.mode !== 'payment' || session.currency !== 'usd' ||
      session.amount_subtotal !== 99 || session.amount_total !== 99 || session.client_reference_id !== order.orderId ||
      !sameMetadata(session.metadata, order)) throw mismatch();
}

function checkCharge(intent, order, intentId) {
  const charge = intent?.latest_charge;
  if (intent?.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== false ||
      intent.status !== 'succeeded' || intent.currency !== 'usd' || intent.amount !== 99 || intent.amount_received !== 99 ||
      !sameMetadata(intent.metadata, order) || intent.transfer_data || intent.application_fee_amount || intent.on_behalf_of ||
      charge?.object !== 'charge' || !/^ch_[a-zA-Z0-9]+$/.test(charge.id) || charge.payment_intent !== intentId ||
      charge.livemode !== false || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded' ||
      charge.amount !== 99 || charge.amount_captured !== 99 || charge.currency !== 'usd' || charge.transfer_data ||
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
  const configured = /^(sk|rk)_test_[a-zA-Z0-9]+$/.test(key) && env.STRIPE_CONNECT_LIVE !== '1';
  let platform;
  const creating = new Map();
  const checking = new Map();
  const checkingPlatform = () => {
    if (!configured) throw new ViewerCheckoutError('Sandbox checkout is unavailable.', 503);
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
    if (order.status === 'expired' || abandoned(order)) throw new ViewerCheckoutError('This rental has expired. Start a new rental.', 410);
    const stripe = await client(order);
    if (order.status === 'paid') return { url: order.origin + '/checkout/return' };
    let session;
    if (order.sessionId) {
      session = await stripe.checkout.sessions.retrieve(order.sessionId);
    } else {
      await verifyReadySeller({ store, env, fetchImpl, owner: order.owner, account: order.account });
      const markers = metadata(order);
      session = await stripe.checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'], adaptive_pricing: { enabled: false },
        client_reference_id: order.orderId, metadata: markers, payment_intent_data: { metadata: markers },
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 99,
          product_data: { name: order.title, description: '48-hour streaming rental, starting at purchase.' } } }],
        success_url: order.origin + '/checkout/return', cancel_url: order.origin + '/checkout/cancel'
      }, { idempotencyKey: 'stream-viewer-' + order.orderId });
      checkSession(session, order);
      store.bindViewerSession(order.orderId, session.id);
    }
    checkSession(session, order);
    if (session.status === 'expired') {
      store.expireViewerOrder(order.orderId);
      throw new ViewerCheckoutError('This checkout has expired. Start a new rental.', 410);
    }
    if (session.status === 'complete') return { url: order.origin + '/checkout/return' };
    if (session.status !== 'open' || typeof session.url !== 'string') throw mismatch();
    const url = new URL(session.url);
    if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) throw mismatch();
    return { url: url.href };
  }

  async function start({ offer, token, origin }) {
    const digest = await viewerHash(token);
    const base = landingOrigin(origin, env.STREAM_PUBLIC_ORIGIN);
    const id = await checkingPlatform();
    if (offer.account === id) throw mismatch();
    const order = store.reserveViewerOrder({ ...offer, tokenHash: digest, platform: id, origin: base });
    if (!matchingOffer(order, offer) || order.platform !== id || order.origin !== base) throw mismatch();
    return shared(creating, order.orderId, () => openSession(order));
  }

  async function reconcile(order) {
    return shared(checking, order.orderId, async () => {
      const stripe = await client(order);
      const session = await stripe.checkout.sessions.retrieve(order.sessionId);
      checkSession(session, order);
      if (session.status === 'expired') {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      if (session.payment_status === 'unpaid') return { status: 'pending' };
      if (session.status !== 'complete' || session.payment_status !== 'paid' || !INTENT.test(session.payment_intent)) throw mismatch();
      const intent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
      const charge = checkCharge(intent, order, session.payment_intent);
      if (charge.refunded || charge.amount_refunded > 0 || charge.disputed ||
          charge.created + RENTAL_SECONDS <= Math.floor(Date.now() / 1000)) {
        store.expireViewerOrder(order.orderId);
        return { status: 'expired' };
      }
      if (!store.fulfillViewerOrder(order.orderId, session.id, intent.id, charge.created)) {
        if (store.viewerOrderById(order.orderId)?.status === 'expired') return { status: 'expired' };
        throw mismatch();
      }
      return { status: 'paid', intent };
    });
  }

  async function status({ offer, token }) {
    const order = store.viewerOrderForToken(await viewerHash(token));
    if (!order || !matchingOffer(order, offer)) return { status: 'pending' };
    if (order.status === 'expired' || abandoned(order) || (order.paidAt && order.paidAt + RENTAL_SECONDS <= Math.floor(Date.now() / 1000))) return { status: 'expired' };
    if (!order.sessionId) return { status: 'pending' };
    if (order.status === 'pending' && !checking.has(order.orderId) && !store.checkPendingViewerOrder(order.orderId)) return { status: 'pending' };
    const result = await reconcile(order);
    if (result.status !== 'paid') return result;
    const receipt = await offer.authority.issueReceipt(result.intent, { film: offer.scope, revision: offer.revision });
    return { status: 'paid', receipt };
  }

  async function webhook(rawBody, signature) {
    if (!configured || !webhookSecret) throw new ViewerCheckoutError('Sandbox webhook is unavailable.', 503);
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) throw new ViewerCheckoutError('Invalid webhook payload.');
    if (Buffer.byteLength(rawBody) > 512 * 1024) throw new ViewerCheckoutError('Webhook payload is too large.', 413);
    const text = typeof rawBody === 'string' ? rawBody : new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const { valid } = await verifyStripeSignature(text, signature, webhookSecret);
    if (!valid) throw new ViewerCheckoutError('Invalid webhook signature.');
    let event;
    try { event = JSON.parse(text); } catch { throw new ViewerCheckoutError('Invalid webhook payload.'); }
    const object = event?.data?.object;
    if (event?.object !== 'event' || event.livemode !== false || !/^evt_[a-zA-Z0-9]+$/.test(event.id) ||
        !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) ||
        object?.metadata?.flow !== FLOW || !SESSION.test(object.id)) return { received: true };
    const order = store.viewerOrderById(object.metadata.order);
    if (!order || event.account !== order.account) return { received: true };
    if (!order.sessionId) throw new ViewerCheckoutError('Session registration is still pending.', 503);
    if (order.sessionId !== object.id) throw mismatch();
    await reconcile(order);
    store.noteViewerWebhook(order.orderId, event.id);
    return { received: true };
  }

  function guarded(fn) {
    return async (...args) => {
      try { return await fn(...args); }
      catch (error) {
        if (error instanceof ViewerCheckoutError) throw error;
        if (error.code === 'viewer_rate_limit') throw new ViewerCheckoutError('This film reached its sandbox checkout limit. Try again later.', 429);
        throw new ViewerCheckoutError('Checkout is temporarily unavailable. Try again.', 503);
      }
    };
  }

  return { configured, start: guarded(start), status: guarded(status), webhook: guarded(webhook) };
}
