import { createHash } from 'node:crypto';
import { isPrice } from './prices.js';
import { hmacSha256, randomToken } from '@dustwave/worker-core/crypto';
import { signExpiringToken, verifyExpiringToken } from '@dustwave/worker-core/session-security';

const RENTAL_SECONDS = 48 * 60 * 60;
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

export function createRentalAuthority(secret, { now = Date.now } = {}) {
  const signingKey = Buffer.isBuffer(secret) ? secret.toString('base64url') : secret;
  if (typeof signingKey !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(signingKey) ||
      Buffer.from(signingKey, 'base64url').toString('base64url') !== signingKey) {
    throw new TypeError('A 32-byte rental signing key is required.');
  }

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
        (purchased && !validOrder(claims.order))) throw denied();
    return { film: film.film, revision: film.revision, expiresAt: claims.exp, rentalExpiresAt: purchased ? null : end,
      ...(purchased ? { access: 'buy', orderId: claims.order } : {}) };
  }

  // The caller retrieves the PaymentIntent and expanded charge server-to-server.
  function confirmedCharge(intent, film, amount, kind) {
    const scope = rentalScope(film);
    const charge = intent?.latest_charge;
    const meta = intent?.metadata;
    const legacy = meta?.kind === undefined && meta?.amount === undefined && kind === 'rent' && amount === 99;
    if (!isPrice(amount) || intent?.object !== 'payment_intent' || !intent.id?.startsWith('pi_') ||
        intent.status !== 'succeeded' || intent.livemode !== false || intent.amount !== amount ||
        intent.amount_received !== amount || intent.currency !== 'usd' || meta?.product !== 'stream-rental-prototype' ||
        meta.scope !== scope || (!legacy && (meta.kind !== kind || meta.amount !== String(amount))) ||
        charge?.object !== 'charge' || charge.livemode !== false || charge.status !== 'succeeded' ||
        charge.payment_intent !== intent.id || charge.captured !== true || charge.paid !== true ||
        charge.refunded !== false || charge.amount_refunded !== 0 || charge.disputed !== false ||
        !Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.created > Math.floor(now() / 1000)) throw denied();
    if (!legacy && (charge.amount !== amount || charge.amount_captured !== amount || charge.currency !== 'usd')) throw denied();
    return { scope, created: charge.created };
  }

  return {
    async issueReceipt(intent, film, { amount = 99, paidAt } = {}) {
      const { scope, created } = confirmedCharge(intent, film, amount, 'rent');
      // Hosted orders can settle after charge creation. Their stored, verified
      // settlement time remains the clock origin across retries and renewals.
      const start = paidAt === undefined ? created : paidAt;
      const current = Math.floor(now() / 1000);
      if (!Number.isSafeInteger(start) || start < created || start > current || start + RENTAL_SECONDS <= current) throw denied();
      return signExpiringToken({ type: 'rental-v1', scope }, signingKey, {
        now: start * 1000, ttlSeconds: RENTAL_SECONDS, maxTtlSeconds: RENTAL_SECONDS
      });
    },

    async issuePurchaseReceipt(intent, film, { amount, orderId } = {}) {
      const { scope } = confirmedCharge(intent, film, amount, 'buy');
      if (!validOrder(orderId) || intent.metadata.order !== orderId) throw denied();
      return signExpiringToken({ type: 'purchase-v1', scope, order: orderId }, signingKey, {
        now: now(), ttlSeconds: PURCHASE_RECEIPT_SECONDS, maxTtlSeconds: PURCHASE_RECEIPT_SECONDS
      });
    },

    async exchange(receipt, film) {
      const claims = await read(receipt, ['rental-v1', 'purchase-v1'], film);
      const purchased = claims.type === 'purchase-v1';
      if (purchased && !validOrder(claims.order)) throw denied();
      const time = now();
      const current = Math.floor(time / 1000);
      const expiresAt = Math.min(current + SESSION_SECONDS, claims.exp);
      if (expiresAt <= current) throw denied();
      const purpose = purchased ? { type: 'purchase-playback-v1', order: claims.order, receiptEnd: claims.exp } :
        { type: 'playback-v1', rentalEnd: claims.exp };
      const grant = await signExpiringToken({ ...purpose, scope: claims.scope, session: randomToken(16) },
        signingKey, { now: time, ttlSeconds: expiresAt - current, maxTtlSeconds: SESSION_SECONDS });
      return { grant, expiresAt, rentalExpiresAt: purchased ? null : claims.exp,
        ...(purchased ? { access: 'buy', orderId: claims.order } : {}) };
    },

    verifyGrant,

    async verifyDownloadGrant(grant, film) {
      const access = await verifyGrant(grant, film);
      if (access.access !== 'buy') throw denied();
      return { orderId: access.orderId, expiresAt: access.expiresAt };
    },

    async keyForGrant(grant, film) {
      await verifyGrant(grant, film);
      const material = await hmacSha256('hls-aes128-v1:' + grant, signingKey);
      return Buffer.from(material, 'base64url').subarray(0, 16);
    }
  };
}
