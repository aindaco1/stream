import { createHash, createHmac } from 'node:crypto';
import { isPrice, rentalHours } from './prices.js';
import { hmacSha256, randomToken } from '@dustwave/worker-core/crypto';
import { signExpiringToken, verifyExpiringToken } from '@dustwave/worker-core/session-security';

const SESSION_SECONDS = 10 * 60;
const PURCHASE_RECEIPT_SECONDS = 3600;
const validOrder = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

// Match receipts already issued by the connected-account rehearsal.
export function savedFilmScope(owner, id) {
  return 'saved/' + createHash('sha256').update(JSON.stringify([owner, id])).digest('hex');
}

export function rentalScope({ film, revision }) {
  if (typeof film !== 'string' || !film || film.length > 128 ||
      typeof revision !== 'string' || !revision || revision.length > 512) {
    throw new TypeError('A film and a source revision are required.');
  }
  return createHash('sha256').update(JSON.stringify([film, revision])).digest('base64url');
}

function denied() {
  return new Error('Rental access unavailable.');
}

export function createRentalAuthority(secret, { now = Date.now, live = false } = {}) {
  const rawKey = Buffer.isBuffer(secret) ? secret.toString('base64url') : secret;
  if (typeof rawKey !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(rawKey) ||
      Buffer.from(rawKey, 'base64url').toString('base64url') !== rawKey) {
    throw new TypeError('A 32-byte rental signing key is required.');
  }

  // Distinct key material prevents cross-mode grants even when an operator
  // accidentally supplies the same secret to a rehearsal and the live service.
  const signingKey = live ? createHmac('sha256', Buffer.from(rawKey, 'base64url')).update('stream-live-grants-v1').digest('base64url') : rawKey;

  async function read(token, types, film) {
    const time = now();
    const claims = await verifyExpiringToken(token, signingKey, {
      now: time,
      requiredClaims: ['type', 'scope']
    });
    if (!claims || !types.includes(claims.type) || claims.scope !== rentalScope(film) ||
        claims.exp <= Math.floor(time / 1000)) throw denied();
    return claims;
  }

  async function verifyGrant(grant, film) {
    const claims = await read(grant, ['playback-v1', 'purchase-playback-v1'], film);
    const purchased = claims.type === 'purchase-playback-v1';
    const end = purchased ? claims.receiptEnd : claims.rentalEnd;
    if (!Number.isSafeInteger(end) || claims.exp > end || !claims.session || typeof claims.session !== 'string' ||
        ((purchased || claims.order !== undefined) && !validOrder(claims.order))) throw denied();
    return { film: film.film, revision: film.revision, expiresAt: claims.exp, rentalExpiresAt: purchased ? null : end,
      ...(claims.order ? { access: purchased ? 'buy' : 'rent', orderId: claims.order } : {}) };
  }

  // The caller retrieves the PaymentIntent and expanded charge server-to-server.
  function confirmedCharge(intent, film, amount, kind, paymentState, agreedSubtotal) {
    const scope = rentalScope(film);
    const charge = intent?.latest_charge;
    const meta = intent?.metadata;
    const legacy = !live && meta?.kind === undefined && meta?.amount === undefined && kind === 'rent' && amount === 99;
    const subtotal = agreedSubtotal ?? amount;
    if (!isPrice(subtotal) || (subtotal !== amount && (meta?.tax_policy !== 'marketplace-v1' || subtotal > amount)) ||
        !isPrice(amount) || intent?.object !== 'payment_intent' || !intent.id?.startsWith('pi_') ||
        intent.status !== 'succeeded' || intent.livemode !== live || intent.amount !== amount ||
        intent.amount_received !== amount || intent.currency !== 'usd' || meta?.product !== (live ? 'stream' : 'stream-rental-prototype') ||
        meta.scope !== scope || (!legacy && (meta.kind !== kind || meta.amount !== String(subtotal))) ||
        charge?.object !== 'charge' || charge.livemode !== live || charge.status !== 'succeeded' ||
        charge.payment_intent !== intent.id || charge.captured !== true || charge.paid !== true ||
        !Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.created > Math.floor(now() / 1000)) throw denied();
    if (paymentState === undefined) {
      if (charge.refunded !== false || charge.amount_refunded !== 0 || charge.disputed !== false) throw denied();
    } else if (paymentState.chargeId !== charge.id || paymentState.revocationReason ||
        !Number.isSafeInteger(paymentState.refundedAmount) || paymentState.refundedAmount < 0 || paymentState.refundedAmount >= amount) throw denied();
    if (!legacy && (charge.amount !== amount || charge.amount_captured !== amount || charge.currency !== 'usd')) throw denied();
    return { scope, created: charge.created };
  }

  function signRental(scope, orderId, start, hours) {
    const current = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(start) || start <= 0 || start > current ||
        !Number.isInteger(hours) || rentalHours(hours) !== hours || start + hours * 3600 <= current) throw denied();
    const duration = hours * 3600;
    return signExpiringToken({ type: 'rental-v1', scope, ...(orderId && { order: orderId }) }, signingKey, {
      now: start * 1000, ttlSeconds: duration, maxTtlSeconds: duration
    });
  }

  function signPurchase(scope, orderId) {
    return signExpiringToken({ type: 'purchase-v1', scope, order: orderId }, signingKey, {
      now: now(), ttlSeconds: PURCHASE_RECEIPT_SECONDS, maxTtlSeconds: PURCHASE_RECEIPT_SECONDS
    });
  }

  return {
    async issueReceipt(intent, film, { amount = 99, paidAt, orderId, rentalHours: hours = 48, paymentState, agreedSubtotal } = {}) {
      const { scope, created } = confirmedCharge(intent, film, amount, 'rent', paymentState, agreedSubtotal);
      if ((live && !validOrder(orderId)) || (paidAt !== undefined && paidAt < created) ||
          (orderId !== undefined && (!validOrder(orderId) || intent.metadata.order !== orderId))) throw denied();
      return signRental(scope,orderId,paidAt === undefined ? created : paidAt,hours);
    },

    async issuePurchaseReceipt(intent, film, { amount, orderId, paymentState, agreedSubtotal } = {}) {
      const { scope } = confirmedCharge(intent, film, amount, 'buy', paymentState, agreedSubtotal);
      if (!validOrder(orderId) || intent.metadata.order !== orderId) throw denied();
      return signPurchase(scope,orderId);
    },

    async issueCouponReceipt(order, film) {
      if (order.status !== 'paid' || !order.couponId || !order.sessionId || !validOrder(order.orderId) ||
          order.amount !== 0 || order.chargedTotalCents !== 0 || order.intentId || order.revocationReason ||
          order.scope !== film.film || order.revision !== film.revision || !['rent','buy'].includes(order.kind)) throw denied();
      const scope = rentalScope(film);
      return order.kind === 'buy' ? signPurchase(scope,order.orderId) : signRental(scope,order.orderId,order.paidAt,order.rentalHours);
    },

    async exchange(receipt, film) {
      const claims = await read(receipt, ['rental-v1', 'purchase-v1'], film);
      const purchased = claims.type === 'purchase-v1';
      if ((purchased || claims.order !== undefined) && !validOrder(claims.order)) throw denied();
      const time = now();
      const current = Math.floor(time / 1000);
      const expiresAt = Math.min(current + SESSION_SECONDS, claims.exp);
      if (expiresAt <= current) throw denied();
      const purpose = purchased ? { type: 'purchase-playback-v1', order: claims.order, receiptEnd: claims.exp } :
        { type: 'playback-v1', rentalEnd: claims.exp, ...(claims.order && { order: claims.order }) };
      const grant = await signExpiringToken({ ...purpose, scope: claims.scope, session: randomToken(16) },
        signingKey, { now: time, ttlSeconds: expiresAt - current, maxTtlSeconds: SESSION_SECONDS });
      return { grant, expiresAt, rentalExpiresAt: purchased ? null : claims.exp,
        ...(claims.order ? { access: purchased ? 'buy' : 'rent', orderId: claims.order } : {}) };
    },

    verifyGrant,

    async verifyDownloadGrant(grant, film) {
      const access = await verifyGrant(grant, film);
      if (access.access !== 'buy') throw denied();
      return { orderId: access.orderId, expiresAt: access.expiresAt };
    },

    async keyForGrant(grant, film, memberId) {
      await verifyGrant(grant, film);
      // Each title restarts the HLS sequence, so give it a separate AES key.
      const context = memberId ? 'stream-program-title:' + memberId + ':' : 'hls-aes128-v1:';
      const material = await hmacSha256(context + grant, signingKey);
      return Buffer.from(material, 'base64url').subarray(0, 16);
    }
  };
}
