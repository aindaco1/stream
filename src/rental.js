import { createHash } from 'node:crypto';
import { hmacSha256, randomToken } from '@dustwave/worker-core/crypto';
import { signExpiringToken, verifyExpiringToken } from '@dustwave/worker-core/session-security';

const RENTAL_SECONDS = 48 * 60 * 60;
const SESSION_SECONDS = 10 * 60;

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

  async function read(token, type, film) {
    const time = now();
    const claims = await verifyExpiringToken(token, signingKey, {
      now: time,
      requiredClaims: ['type', 'scope']
    });
    if (!claims || claims.type !== type || claims.scope !== rentalScope(film) ||
        claims.exp <= Math.floor(time / 1000)) throw denied();
    return claims;
  }

  async function verifyGrant(grant, film) {
    const claims = await read(grant, 'playback-v1', film);
    if (!Number.isSafeInteger(claims.rentalEnd) || claims.exp > claims.rentalEnd ||
        typeof claims.session !== 'string' || !claims.session) throw denied();
    return { film: film.film, revision: film.revision, expiresAt: claims.exp, rentalExpiresAt: claims.rentalEnd };
  }

  return {
    // The caller obtains this object server-to-server from Stripe with latest_charge expanded.
    async issueReceipt(intent, film) {
      const scope = rentalScope(film);
      const charge = intent?.latest_charge;
      if (intent?.object !== 'payment_intent' || !intent.id?.startsWith('pi_') ||
          intent.status !== 'succeeded' || intent.livemode !== false ||
          intent.amount !== 99 || intent.amount_received !== 99 || intent.currency !== 'usd' ||
          intent.metadata?.product !== 'stream-rental-prototype' || intent.metadata?.scope !== scope ||
          charge?.object !== 'charge' || charge.livemode !== false || charge.status !== 'succeeded' ||
          charge.payment_intent !== intent.id || charge.captured !== true || charge.paid !== true ||
          charge.refunded !== false || charge.amount_refunded !== 0 || charge.disputed !== false ||
          !Number.isSafeInteger(charge.created)) throw denied();

      const current = Math.floor(now() / 1000);
      if (charge.created <= 0 || charge.created > current || charge.created + RENTAL_SECONDS <= current) throw denied();
      return signExpiringToken({ type: 'rental-v1', scope }, signingKey, {
        now: charge.created * 1000,
        ttlSeconds: RENTAL_SECONDS,
        maxTtlSeconds: RENTAL_SECONDS
      });
    },

    async exchange(receipt, film) {
      const rental = await read(receipt, 'rental-v1', film);
      const time = now();
      const current = Math.floor(time / 1000);
      const expiresAt = Math.min(current + SESSION_SECONDS, rental.exp);
      if (expiresAt <= current) throw denied();
      const grant = await signExpiringToken({
        type: 'playback-v1', scope: rental.scope, session: randomToken(16), rentalEnd: rental.exp
      }, signingKey, { now: time, ttlSeconds: expiresAt - current, maxTtlSeconds: SESSION_SECONDS });
      return { grant, expiresAt, rentalExpiresAt: rental.exp };
    },

    verifyGrant,

    async keyForGrant(grant, film) {
      await verifyGrant(grant, film);
      const material = await hmacSha256('hls-aes128-v1:' + grant, signingKey);
      return Buffer.from(material, 'base64url').subarray(0, 16);
    }
  };
}
