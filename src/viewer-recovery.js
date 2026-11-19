import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { classifyResendFailure } from '@dustwave/worker-core/resend';
import { prepareResendEmail } from '@dustwave/worker-core/email';

const digest = value => createHash('sha256').update(value).digest('hex');
const minute = 60_000;

function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254) return;
  const email = value.trim();
  const match = /^([^\s@<>,;:"\\]+)@([a-z\d.-]+\.[a-z]{2,})$/i.exec(email);
  if (match && !/[\x00-\x1f\x7f]/.test(value)) return match[1] + '@' + match[2].toLowerCase();
}

// Only the address fingerprint, token digests and play position persist.
// The mailbox supplied on a restore request is used for that delivery only.
export function recoveryStore(db, key) {
  db.exec(`CREATE TABLE IF NOT EXISTS viewer_recovery (
    orderId TEXT PRIMARY KEY, emailHash TEXT NOT NULL, accessHash TEXT NOT NULL UNIQUE,
    codeHash TEXT UNIQUE, sentAt INTEGER, used INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS recovery_email ON viewer_recovery(emailHash);
    CREATE INDEX IF NOT EXISTS recovery_recent ON viewer_recovery(sentAt) WHERE sentAt IS NOT NULL;
    CREATE VIEW IF NOT EXISTS viewer_claimed_orders AS SELECT o.* FROM viewer_test_orders o
      JOIN claims c ON c.owner=o.owner AND c.account=o.account AND c.mode='test'`);
  const fingerprint = (purpose, value) => createHmac('sha256', key).update(purpose + '\0' + value).digest('base64url');
  const accessToken = orderId => fingerprint('viewer-restore', orderId);
  const active = "o.status='paid' AND (o.kind='buy' OR o.paidAt+o.rentalHours*3600>unixepoch())";
  return {
    previousRecoveryOrders(after) {
      return db.prepare(`SELECT o.rowid AS cursor,o.* FROM viewer_test_orders o
        LEFT JOIN viewer_recovery r USING(orderId) WHERE o.rowid>? AND r.orderId IS NULL
        AND o.sessionId IS NOT NULL AND ${active} ORDER BY o.rowid LIMIT 12`).all(after);
    },
    rememberViewerEmail(orderId, value) {
      const email = mailbox(value);
      db.prepare(`INSERT INTO viewer_recovery(orderId,emailHash,accessHash) VALUES(?,?,?)
        ON CONFLICT(orderId) DO UPDATE SET emailHash=excluded.emailHash
        WHERE viewer_recovery.emailHash='' AND excluded.emailHash!=''`)
        .run(orderId, email ? fingerprint('checkout-email', email) : '', digest(accessToken(orderId)));
    },
    viewerOrderForAccess(hash) {
      return db.prepare('SELECT * FROM viewer_test_orders WHERE tokenHash=? OR orderId=(SELECT orderId FROM viewer_recovery WHERE accessHash=?)').get(hash, hash);
    },
    setViewerPosition(orderId, seconds) {
      db.prepare("UPDATE viewer_test_orders SET position=? WHERE orderId=? AND status='paid' AND position!=?")
        .run(seconds, orderId, seconds);
    },
    reserveRecovery(offer, address) {
      const email = mailbox(address);
      if (!email) return;
      const code = randomBytes(32).toString('base64url');
      const now = Date.now();
      const row = db.prepare(`UPDATE viewer_recovery SET codeHash=?,sentAt=?,used=0
        WHERE orderId=(SELECT o.orderId FROM viewer_claimed_orders o JOIN viewer_recovery r USING(orderId)
          WHERE o.owner=? AND o.filmId=? AND o.account=coalesce(?,o.account) AND o.revision=? AND r.emailHash=? AND ${active}
          ORDER BY (o.kind='buy') DESC,o.paidAt+o.rentalHours*3600 DESC LIMIT 1)
        AND (sentAt IS NULL OR sentAt<?)
        AND (SELECT count(*) FROM viewer_recovery WHERE sentAt>=?)<60
        RETURNING orderId`).get(digest(code), now, offer.owner, offer.id, offer.account, offer.revision,
          fingerprint('checkout-email', email), now - minute, now - minute);
      if (row) return { code, email };
    },
    redeemRecovery(offer, code) {
      if (!/^[\w-]{43}$/.test(code)) return;
      const row = db.prepare(`UPDATE viewer_recovery SET used=1 WHERE codeHash=? AND used=0 AND sentAt>?
        AND orderId IN (SELECT o.orderId FROM viewer_claimed_orders o WHERE o.owner=? AND o.filmId=? AND o.account=coalesce(?,o.account) AND o.revision=? AND ${active})
        RETURNING orderId`).get(digest(code), Date.now() - 15 * minute, offer.owner, offer.id, offer.account, offer.revision);
      return row && accessToken(row.orderId);
    }
  };
}

export function createViewerRecovery({ store, env = process.env, fetchImpl = fetch }) {
  if (!env.STREAM_RECOVERY_FROM || !env.RESEND_API_KEY) return;
  return {
    request(offer, address, origin) {
      if (env.STREAM_RECOVERY_TEST_TO && mailbox(address) !== mailbox(env.STREAM_RECOVERY_TEST_TO)) return;
      const delivery = store.reserveRecovery(offer, address);
      if (!delivery) return;
      const link = origin + '/embed/' + encodeURIComponent(offer.id) + '#restore=' + delivery.code;
      const payload = prepareResendEmail({ from: env.STREAM_RECOVERY_FROM, to: [delivery.email],
        subject: 'Your Stream access link',
        text: 'You requested access to ' + offer.title + '. Open this private link within 15 minutes to continue watching.\n\n' +
          link + '\n\nIf you did not request this email, you can ignore it.' });
      // A request gets the same public response for every address. Log delivery
      // failures without an address, film, order, request body or credential.
      const send = async () => {
        const options = { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json', 'Idempotency-Key': 'stream-restore-' + digest(delivery.code) },
          body: JSON.stringify(payload), redirect: 'error' };
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetchImpl('https://api.resend.com/emails', { ...options, signal: AbortSignal.timeout(10000) })
            .catch(() => null);
          if (response?.ok) return;
          const failure = classifyResendFailure(response?.status || 0, { retryAfter: response?.headers.get('retry-after') });
          if (!failure.retryable || attempt === 2 || failure.retryAfterSeconds > 20) break;
          await wait(Math.max(attempt + 1, failure.retryAfterSeconds) * 1000);
        }
        console.error('Stream recovery email delivery failed. A new link can be requested in one minute.');
      };
      void send().catch(() => console.error('Stream recovery email could not be sent.'));
    },
    redeem(offer, code) { return store.redeemRecovery(offer, code); }
  };
}
