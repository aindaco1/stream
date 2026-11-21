import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { programStore, isProgramId } from './program-store.js';
import { analyticsReports } from './analytics.js';
import { bucketReader } from './r2-write.js';
import { DatabaseSync } from 'node:sqlite';
import { recoveryStore } from './viewer-recovery.js';
import { StripeSetupError, stripeSetupStateForMode } from './setup-stripe.js';
import { filmPrices, rentalHours } from './prices.js';
import { filmTaxFeeShare, tipFor } from './checkout-tips.js';

const token = () => randomBytes(32).toString('base64url');
const hash = text => createHash('sha256').update(text).digest('hex');
const newDraft = () => ({ id: 'f-' + randomUUID() });

function vaultKey(directory) {
  const path = join(directory, 'credential.key');
  try {
    return readFileSync(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const temp = join(directory, '.' + randomUUID());
  writeFileSync(temp, randomBytes(32), { flag: 'wx', mode: 0o600 });
  try {
    try { linkSync(temp, path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { unlinkSync(temp); }
  return readFileSync(path);
}

function connectionId(owner, { accountId, jurisdiction, bucket }) {
  return JSON.stringify([owner, accountId, jurisdiction, bucket]);
}

export function openSetupStore(directory) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const key = vaultKey(directory);
  if (key.length !== 32) throw new Error('Invalid setup credential key.');
  const path = join(directory, 'setup.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout=3000');
  // The setup and viewer processes can open the same database together.
  // SQLite can report BUSY immediately while enabling or recovering WAL.
  const deadline = Date.now() + 3000;
  for (;;) {
    try { db.exec('PRAGMA journal_mode=WAL'); break; }
    catch (error) {
      if ((error.errcode & 255) !== 5 || Date.now() >= deadline) {
        db.close();
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS makers (
      id TEXT PRIMARY KEY, stripe TEXT NOT NULL DEFAULT '{}', bucket_id TEXT, draft TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_admins (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS storage_drafts (owner TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (mode TEXT NOT NULL, account TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(mode, account));
    CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, config TEXT NOT NULL, sealed BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS films (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bucket_id TEXT NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS film_uploads (owner TEXT NOT NULL, draftId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,draftId));
    CREATE TABLE IF NOT EXISTS thumbnail_edits (filmId TEXT PRIMARY KEY, lock TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS film_publication (
      filmId TEXT PRIMARY KEY, owner TEXT NOT NULL, published INTEGER NOT NULL CHECK (published IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS film_counts (filmId TEXT PRIMARY KEY, previews INTEGER NOT NULL, plays INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS viewer_nm_tax_rates (
      platform TEXT NOT NULL, location TEXT NOT NULL, ppm INTEGER NOT NULL, inclusive INTEGER NOT NULL,
      stripeId TEXT NOT NULL, PRIMARY KEY(platform,location,ppm,inclusive)
    );
    CREATE TABLE IF NOT EXISTS film_view_receipts (
      filmId TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, createdAt INTEGER NOT NULL,
      PRIMARY KEY(filmId,kind,digest)
    );
    CREATE INDEX IF NOT EXISTS film_view_receipt_age ON film_view_receipts(createdAt);
    CREATE TABLE IF NOT EXISTS connected_test_orders (
      filmId TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, platform TEXT NOT NULL,
      revision TEXT NOT NULL, source TEXT NOT NULL, orderId TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, intentId TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS viewer_test_orders (
      tokenHash TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE, filmId TEXT NOT NULL,
      owner TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL,
      platform TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL, createdAt INTEGER NOT NULL,
      sessionId TEXT UNIQUE, intentId TEXT UNIQUE, paidAt INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      checkedAt INTEGER, webhookEventId TEXT, webhookAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS viewer_order_rate ON viewer_test_orders(filmId,createdAt);`);
  const sql = query => db.prepare(query);
  function stripeSelection(owner, mode) {
    const row = sql('SELECT stripe FROM makers WHERE id=?').get(owner);
    if (!row) throw new StripeSetupError('Filmmaker workspace unavailable.', 404);
    const document = JSON.parse(row.stripe);
    const state = stripeSetupStateForMode(document, mode);
    const confirmation = createHmac('sha256', key).update(JSON.stringify(['stripe-selection', owner, mode, state])).digest('base64url');
    return { document, state, confirmation };
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Orders created before embedded Checkout are $0.99 hosted rentals.
  transaction(() => {
    for (const table of ['invitations', 'sessions']) {
      if (!sql('PRAGMA table_info(' + table + ')').all().some(row => row.name === 'audience')) {
        db.exec("ALTER TABLE " + table + " ADD COLUMN audience TEXT NOT NULL DEFAULT 'filmmaker'");
      }
    }
    const columns = new Set(sql('PRAGMA table_xinfo(viewer_test_orders)').all().map(row => row.name));
    if (!columns.has('verifiedAt')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN verifiedAt INTEGER');
    if (!columns.has('position')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('positionMember')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN positionMember TEXT');
    if (!columns.has('kind')) db.exec("ALTER TABLE viewer_test_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'rent'");
    if (!columns.has('amount')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN amount INTEGER NOT NULL DEFAULT 99');
    if (!columns.has('tipPercent')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN tipPercent INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('tipAmount')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN tipAmount INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('stripeFeeCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN stripeFeeCents INTEGER');
    if (!columns.has('taxPolicy')) db.exec("ALTER TABLE viewer_test_orders ADD COLUMN taxPolicy TEXT NOT NULL DEFAULT 'none' CHECK(taxPolicy IN ('none','marketplace-v1'))");
    if (!columns.has('nmQuote')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN nmQuote TEXT');
    if (!columns.has('viewingAddressTag')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN viewingAddressTag TEXT');
    if (!columns.has('taxCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN taxCents INTEGER');
    if (!columns.has('tipTaxCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN tipTaxCents INTEGER');
    if (!columns.has('chargedTotalCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN chargedTotalCents INTEGER');
    // Existing orders keep their original payout terms. Only new automatic-tax orders start with a pending fee.
    if (!columns.has('taxBasicFeeCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN taxBasicFeeCents INTEGER DEFAULT 0');
    if (!columns.has('filmTaxFeeCents')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN filmTaxFeeCents INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('taxFeeReference')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN taxFeeReference TEXT');
    if (!columns.has('chargeBalanceId')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN chargeBalanceId TEXT');
    if (!columns.has('cardProcessingCents')) db.exec(`ALTER TABLE viewer_test_orders ADD COLUMN cardProcessingCents INTEGER
      GENERATED ALWAYS AS (stripeFeeCents - CASE WHEN chargeBalanceId=taxFeeReference THEN taxBasicFeeCents ELSE 0 END) VIRTUAL`);
    if (!columns.has('transferId')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN transferId TEXT');
    if (!columns.has('transferAttempt')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN transferAttempt INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('transferRetryAt')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN transferRetryAt INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('uiMode')) db.exec("ALTER TABLE viewer_test_orders ADD COLUMN uiMode TEXT NOT NULL DEFAULT 'hosted'");
    if (!columns.has('cardOnly')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN cardOnly INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('rentalHours')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN rentalHours INTEGER NOT NULL DEFAULT 48');
    if (!columns.has('chargeId')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN chargeId TEXT');
    if (!columns.has('refundedAmount')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN refundedAmount INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('disputeStatus')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN disputeStatus TEXT');
    if (!columns.has('revocationReason')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN revocationReason TEXT');
    if (!columns.has('ledgerVersion')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN ledgerVersion INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('withdrawalState')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN withdrawalState TEXT');
    if (!columns.has('withdrawalRetryAt')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN withdrawalRetryAt INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS viewer_order_charge ON viewer_test_orders(chargeId);
      CREATE UNIQUE INDEX IF NOT EXISTS viewer_transfer_id ON viewer_test_orders(transferId) WHERE transferId IS NOT NULL AND transferId!='no_proceeds';
      CREATE INDEX IF NOT EXISTS viewer_transfer_due ON viewer_test_orders(transferRetryAt,createdAt)
        WHERE taxPolicy='marketplace-v1' AND paidAt IS NOT NULL AND transferId IS NULL;
      CREATE INDEX IF NOT EXISTS viewer_withdrawal_due ON viewer_test_orders(withdrawalRetryAt) WHERE withdrawalState='requested' AND sessionId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS viewer_order_legacy_receipt ON viewer_test_orders(filmId,paidAt);
      CREATE TABLE IF NOT EXISTS viewer_payment_events(
        account TEXT NOT NULL,eventId TEXT NOT NULL,orderId TEXT NOT NULL,receivedAt INTEGER NOT NULL,
        PRIMARY KEY(account,eventId))`);
  });
  const accessOrder = sql('SELECT filmId,owner,account,scope,revision,kind,intentId,paidAt,rentalHours,status,revocationReason,disputeStatus FROM viewer_test_orders WHERE orderId=?');
  function bucketAccess(owner, config) {
    const id = connectionId(owner, config);
    const row = sql('SELECT sealed,config FROM buckets WHERE id=? AND owner=?').get(id, owner);
    if (!row) throw new Error('Storage connection unavailable.');
    const bytes = Buffer.from(row.sealed);
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const clear = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    return { ...JSON.parse(row.config), ...JSON.parse(clear.toString('utf8')) };
  }
  const store = {
    ...programStore(db, transaction, (owner,id) => store.film(owner,id)),
    ...recoveryStore(db, key),
    ...analyticsReports(db),
    invite(owner, audience = 'filmmaker') {
      if (!['admin', 'filmmaker'].includes(audience)) throw new Error('Invalid sign-in audience.');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._@+-]{0,95}$/.test(owner)) throw new Error('Use a short, unique filmmaker name.');
      const code = token();
      transaction(() => {
        const now = Date.now();
        sql('DELETE FROM invitations WHERE expires <= ? OR (owner = ? AND audience = ?)').run(now, owner, audience);
        sql('DELETE FROM sessions WHERE expires <= ?').run(now);
        if (audience === 'admin') sql('INSERT OR IGNORE INTO platform_admins(id) VALUES(?)').run(owner);
        else sql('INSERT OR IGNORE INTO makers(id,draft) VALUES(?,?)').run(owner, JSON.stringify(newDraft()));
        sql('INSERT INTO invitations(digest,owner,expires,audience) VALUES(?,?,?,?)').run(hash(code), owner, now + 30 * 60_000, audience);
      });
      return code;
    },
    signIn(code, audience = 'filmmaker') {
      if (!/^[\w-]{43}$/.test(code)) return;
      return transaction(() => {
        const row = sql('DELETE FROM invitations WHERE digest=? AND expires>? AND audience=? RETURNING owner').get(hash(code), Date.now(), audience);
        if (!row) return;
        const session = token();
        sql('INSERT INTO sessions(digest,owner,csrf,expires,audience) VALUES(?,?,?,?,?)')
          .run(hash(session), row.owner, token(), Date.now() + (audience === 'admin' ? 12 * 3600_000 : 14 * 86400_000), audience);
        return session;
      });
    },
    session(value, audience = 'filmmaker') {
      return value && sql(`SELECT owner, csrf FROM sessions WHERE digest=? AND expires>? AND audience=?
        AND (audience='filmmaker' OR EXISTS(SELECT 1 FROM platform_admins a WHERE a.id=sessions.owner))`).get(hash(value), Date.now(), audience);
    },
    signOut(value) { sql('DELETE FROM sessions WHERE digest=?').run(hash(value)); },
    maker(owner) {
      const row = sql('SELECT * FROM makers WHERE id=?').get(owner);
      if (!row) return;
      const bucket = row.bucket_id && sql('SELECT config FROM buckets WHERE id=? AND owner=?').get(row.bucket_id, owner);
      return { stripe: JSON.parse(row.stripe), draft: JSON.parse(row.draft), r2: bucket && JSON.parse(bucket.config) };
    },
    saveStripe(owner, state) { sql('UPDATE makers SET stripe=? WHERE id=?').run(JSON.stringify(state), owner); },
    stripeContext(owner, mode) {
      const selected = stripeSelection(owner, mode);
      let expected = selected.confirmation;
      function current() {
        const latest = stripeSelection(owner, mode);
        if (latest.confirmation !== expected) throw new StripeSetupError('Stripe setup changed. Reload the setup card to continue.', 409);
        return latest.document;
      }
      return {
        creatorId: owner, state: selected.state,
        get confirmation() { return expected; },
        assertCurrent() { current(); },
        save() {
          transaction(() => {
            const document = current();
            document.byMode[mode] = selected.state;
            store.saveStripe(owner, document);
            expected = stripeSelection(owner, mode).confirmation;
          });
        },
        claimAccount(account, requestedMode) {
          return transaction(() => {
            current();
            return requestedMode === mode && store.claimAccount(owner, account, mode);
          });
        }
      };
    },
    resetStripe(owner, mode, confirmation) {
      return transaction(() => {
        const selected = stripeSelection(owner, mode);
        if (confirmation !== selected.confirmation) return false;
        const previous = selected.state.accountId;
        selected.document.byMode[mode] = { mode, status: 'unconnected', generation: randomUUID() };
        store.saveStripe(owner, selected.document);
        // Preserve the claim and settled ledger. Only incomplete checkouts on
        // the former selection are closed by the durable Stripe expiry worker.
        if (mode === 'test' && previous) {
          sql("UPDATE viewer_test_orders SET withdrawalState='requested' WHERE owner=? AND account=? AND status='pending' AND withdrawalState IS NULL")
            .run(owner, previous);
        }
        return true;
      });
    },
    claimAccount(owner, account, mode) {
      sql('INSERT OR IGNORE INTO claims VALUES(?,?,?)').run(mode, account, owner);
      return sql('SELECT owner FROM claims WHERE mode=? AND account=?').get(mode, account).owner === owner;
    },
    ownsTestAccount(owner, account) {
      return Boolean(sql("SELECT 1 FROM claims WHERE mode='test' AND account=? AND owner=?").get(account, owner));
    },
    reserveTestOrder({ owner, filmId, account, platform, revision, source }) {
      return transaction(() => {
        const maker = store.maker(owner);
        const state = maker && stripeSetupStateForMode(maker.stripe, 'test');
        if (!store.ownsTestAccount(owner, account) || state?.accountId !== account ||
            store.film(owner, filmId)?.revision !== revision) throw new Error('The saved film or Stripe connection changed.');
        sql('INSERT INTO connected_test_orders (owner,filmId,account,platform,revision,source,orderId,createdAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(filmId) DO NOTHING')
          .run(owner, filmId, account, platform, revision, source, randomUUID(), Date.now());
        const order = sql('SELECT * FROM connected_test_orders WHERE filmId=?').get(filmId);
        if (order.owner !== owner || order.account !== account || order.platform !== platform ||
            order.revision !== revision || order.source !== source) throw new Error('This film’s test order is bound to another recipient or revision.');
        return order;
      });
    },
    recordTestIntent(orderId, intentId) {
      const result = sql('UPDATE connected_test_orders SET intentId=? WHERE orderId=? AND (intentId IS NULL OR intentId=?)')
        .run(intentId, orderId, intentId);
      if (result.changes !== 1) throw new Error('The test order has a conflicting Stripe payment.');
    },
    viewingAddressTag(address) {
      const fields = ['country','state','line1','line2','city','postalCode'].map(field =>
        String(address[field] ?? '').trim().replace(/\s+/gu, ' ').toUpperCase());
      return createHmac('sha256',key).update(JSON.stringify(['viewing-location',...fields])).digest('base64url');
    },
    nmRateId(platform, quote, inclusive) {
      return sql('SELECT stripeId FROM viewer_nm_tax_rates WHERE platform=? AND location=? AND ppm=? AND inclusive=?')
        .get(platform,quote.code,quote.ratePartsPerMillion,Number(inclusive))?.stripeId;
    },
    rememberNmRate(platform, quote, inclusive, stripeId) {
      sql('INSERT OR IGNORE INTO viewer_nm_tax_rates VALUES(?,?,?,?,?)')
        .run(platform,quote.code,quote.ratePartsPerMillion,Number(inclusive),stripeId);
      return store.nmRateId(platform,quote,inclusive);
    },
    reserveViewerOrder({ tokenHash, id, owner, account, scope, revision, platform, title, origin, kind, amount, tipPercent = 0, rentalHours: hours = 48, taxPolicy = 'none', nmQuote = null, viewingAddressTag = null }) {
      return transaction(() => {
        const existing = store.viewerOrderForToken(tokenHash);
        if (existing) return existing;
        if (!['none', 'marketplace-v1'].includes(taxPolicy)) throw new Error('Unsupported order tax policy.');
        const maker = store.maker(owner);
        const seller = maker && stripeSetupStateForMode(maker.stripe, 'test');
        const program = isProgramId(id) && store.program(owner,id);
        const film = program ? program.published && program.revision === revision && store.programVersion(id,revision) : store.film(owner,id);
        const currentRevision = program ? program.revision : film?.revision;
        const tipAmount = tipFor(amount,tipPercent);
        if (tipAmount === null || store.filmPublication(id)?.published === 0 || !store.ownsTestAccount(owner, account) || seller?.accountId !== account || !film || currentRevision !== revision ||
            filmPrices(film.prices)?.[kind] !== amount ||
            (kind === 'rent' && (rentalHours(film.rentalHours) !== hours || !Number.isInteger(hours)))) {
          const error = new Error('The film offer changed.');
          error.code = 'viewer_offer_changed';
          throw error;
        }
        const now = Date.now();
        const { n } = sql('SELECT count(*) AS n FROM viewer_test_orders WHERE filmId=? AND createdAt>?').get(id, now - 3600_000);
        if (n >= 30) {
          const error = new Error('This film reached its sandbox checkout limit. Try again later.');
          error.code = 'viewer_rate_limit';
          throw error;
        }
        sql("INSERT INTO viewer_test_orders (tokenHash,orderId,filmId,owner,account,scope,revision,platform,title,origin,createdAt,kind,amount,tipPercent,tipAmount,uiMode,cardOnly,rentalHours,taxPolicy,nmQuote,viewingAddressTag,taxBasicFeeCents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'elements',1,?,?,?,?,?)")
          .run(tokenHash, randomUUID(), id, owner, account, scope, revision, platform, title, origin, now, kind, amount, tipPercent, tipAmount, kind === 'rent' ? hours : 48, taxPolicy, nmQuote && JSON.stringify(nmQuote), viewingAddressTag, taxPolicy === 'marketplace-v1' && !nmQuote ? null : 0);
        return store.viewerOrderForToken(tokenHash);
      });
    },
    viewerOrderForToken(digest) { return sql('SELECT * FROM viewer_test_orders WHERE tokenHash=?').get(digest); },
    viewerOrderById(id) { return sql('SELECT * FROM viewer_test_orders WHERE orderId=?').get(id); },
    viewerAccessById(id) { return accessOrder.get(id); },
    viewerOrderBySession(id) { return sql('SELECT * FROM viewer_test_orders WHERE sessionId=?').get(id); },
    viewerOrderByPayment(account, intentId, chargeId) {
      return sql("SELECT * FROM viewer_test_orders WHERE taxPolicy='none' AND account=? AND (intentId=? OR chargeId=?)").get(account, intentId ?? null, chargeId ?? null);
    },
    viewerOrderByPlatformPayment(platform, intentId, chargeId) {
      return sql(`SELECT * FROM viewer_test_orders WHERE taxPolicy='marketplace-v1' AND platform=:platform
        AND (intentId=:intent OR chargeId=:charge) AND (:intent IS NULL OR intentId=:intent) AND (:charge IS NULL OR chargeId=:charge)`)
        .get({ platform, intent: intentId ?? null, charge: chargeId ?? null });
    },
    pendingTaxFees(platform) {
      return sql(`SELECT chargeId, sessionId, paidAt, chargedTotalCents FROM viewer_test_orders
        WHERE platform=? AND paidAt IS NOT NULL AND taxBasicFeeCents IS NULL ORDER BY paidAt,orderId`).all(platform);
    },
    recordTaxFees(platform, fees) {
      return transaction(() => {
        let recorded = 0;
        for (const { chargeId, feeCents, reference } of fees) {
          const order = store.viewerOrderByPlatformPayment(platform, null, chargeId);
          if (!order?.paidAt || !/^ch_[a-zA-Z0-9]+$/.test(chargeId) || !/^(txn|frr)_[a-zA-Z0-9]+$/.test(reference) ||
              (feeCents > 0 && !reference.startsWith('txn_'))) throw Error('Expected a paid platform charge and its Stripe fee reference.');
          if (order.taxBasicFeeCents !== null) {
            if (order.taxFeeReference === reference && order.taxBasicFeeCents === feeCents) continue;
            throw Error('This order already has a fee decision. Review the report before retrying.');
          }
          const filmFee = filmTaxFeeShare(feeCents, order.chargedTotalCents, order.tipAmount);
          if (order.stripeFeeCents === null || !order.chargeBalanceId ||
              (order.chargeBalanceId === reference && feeCents > order.stripeFeeCents)) throw Error('The charge fee breakdown is not ready or does not match.');
          sql(`UPDATE viewer_test_orders SET taxBasicFeeCents=?,filmTaxFeeCents=?,taxFeeReference=?,
            transferRetryAt=0,ledgerVersion=ledgerVersion+1 WHERE orderId=?`).run(feeCents, filmFee, reference, order.orderId);
          recorded++;
        }
        return recorded;
      });
    },
    pendingViewerTransfers(platform = null) {
      // Rental access can expire independently of a filmmaker's payment. Only financial adjustments hold a transfer.
      return sql(`SELECT * FROM viewer_test_orders WHERE taxPolicy='marketplace-v1' AND paidAt IS NOT NULL
        AND (taxBasicFeeCents IS NOT NULL OR stripeFeeCents IS NULL) AND transferId IS NULL AND transferRetryAt<=? AND (? IS NULL OR platform=?)
        AND intentId IS NOT NULL AND chargeId IS NOT NULL AND chargedTotalCents IS NOT NULL
        AND refundedAmount=0 AND revocationReason IS NULL AND (disputeStatus IS NULL OR disputeStatus IN ('won','prevented','warning_closed'))
        ORDER BY transferRetryAt,createdAt,orderId LIMIT 20`).all(Date.now(), platform, platform);
    },
    retryViewerTransfer(orderId) {
      sql("UPDATE viewer_test_orders SET transferRetryAt=? WHERE orderId=? AND taxPolicy='marketplace-v1' AND transferId IS NULL")
        .run(Date.now() + 30000, orderId);
    },
    advanceRejectedTransfer(order) {
      return sql(`UPDATE viewer_test_orders SET transferAttempt=transferAttempt+1
        WHERE orderId=? AND taxPolicy='marketplace-v1' AND transferId IS NULL AND transferAttempt=? AND chargeId=?`)
        .run(order.orderId,order.transferAttempt,order.chargeId).changes === 1;
    },
    setViewerTransfer(orderId, transferId) {
      if (typeof transferId !== 'string' || (transferId !== 'no_proceeds' && !/^tr_[A-Za-z0-9]{1,128}$/.test(transferId))) return false;
      return sql(`UPDATE viewer_test_orders SET transferId=:transfer,transferRetryAt=0 WHERE orderId=:id AND taxPolicy='marketplace-v1'
        AND paidAt IS NOT NULL AND chargeId IS NOT NULL AND chargedTotalCents IS NOT NULL AND cardProcessingCents IS NOT NULL AND taxBasicFeeCents IS NOT NULL
        AND (transferId IS NULL OR transferId=:transfer) AND (
          (:transfer='no_proceeds' AND cardProcessingCents+filmTaxFeeCents>=amount) OR
          (:transfer!='no_proceeds' AND cardProcessingCents+filmTaxFeeCents<amount AND NOT EXISTS(
            SELECT 1 FROM viewer_test_orders WHERE transferId=:transfer AND orderId!=:id))
        )`).run({ transfer: transferId, id: orderId }).changes === 1;
    },
    hasViewerSellerAccount(account) { return Boolean(sql("SELECT 1 FROM claims WHERE mode='test' AND account=?").get(account)); },
    paymentEventSeen(account, id) { return Boolean(sql('SELECT 1 FROM viewer_payment_events WHERE account=? AND eventId=?').get(account,id)); },
    notePaymentEvent(account, id, orderId) {
      sql('INSERT OR IGNORE INTO viewer_payment_events VALUES(?,?,?,?)').run(account,id,orderId,Date.now());
    },
    legacyOrderForRenewal(offer, end) {
      const rows = sql("SELECT * FROM viewer_claimed_orders WHERE filmId=? AND owner=? AND account=coalesce(?,account) AND scope=? AND revision=? AND kind='rent' AND rentalHours=48 AND paidAt=? LIMIT 2")
        .all(offer.id, offer.owner, offer.account, offer.scope, offer.revision, end - 48 * 3600);
      return rows.length === 1 && rows[0];
    },
    accessForLegacyRental(offer, end) {
      const rows = sql("SELECT status,revocationReason FROM viewer_claimed_orders WHERE filmId=? AND owner=? AND account=coalesce(?,account) AND scope=? AND revision=? AND kind='rent' AND rentalHours=48 AND paidAt=?")
        .all(offer.id,offer.owner,offer.account,offer.scope,offer.revision,end - 48 * 3600);
      return rows.length > 0 && rows.every(row => row.status === 'paid' && !row.revocationReason);
    },
    bindViewerSession(orderId, sessionId) {
      const result = sql('UPDATE viewer_test_orders SET sessionId=? WHERE orderId=? AND (sessionId IS NULL OR sessionId=?)')
        .run(sessionId, orderId, sessionId);
      if (result.changes !== 1) throw new Error('Conflicting Checkout Session.');
    },
    withdrawViewerOrder(orderId) {
      sql("UPDATE viewer_test_orders SET withdrawalState='requested' WHERE orderId=? AND status='pending' AND withdrawalState IS NULL").run(orderId);
    },
    requestedWithdrawals(owner = null, filmId = null) {
      return sql(`SELECT * FROM viewer_test_orders WHERE withdrawalState='requested' AND sessionId IS NOT NULL
        AND withdrawalRetryAt<=? AND (? IS NULL OR owner=?) AND (? IS NULL OR filmId=?) ORDER BY withdrawalRetryAt,createdAt LIMIT 32`)
        .all(Date.now(),owner,owner,filmId,filmId);
    },
    pendingWithdrawals(owner,filmId = null) {
      return sql("SELECT COUNT(*) AS n FROM viewer_test_orders WHERE owner=? AND (? IS NULL OR filmId=?) AND withdrawalState='requested' AND sessionId IS NOT NULL").get(owner,filmId,filmId).n;
    },
    finishWithdrawal(orderId,sessionId) {
      sql("UPDATE viewer_test_orders SET withdrawalState='closed' WHERE orderId=? AND sessionId=? AND withdrawalState='requested'").run(orderId,sessionId);
    },
    retryWithdrawal(orderId) {
      sql("UPDATE viewer_test_orders SET withdrawalRetryAt=? WHERE orderId=? AND withdrawalState='requested'").run(Date.now()+30_000,orderId);
    },
    checkPendingViewerOrder(orderId) {
      return sql("UPDATE viewer_test_orders SET checkedAt=? WHERE orderId=? AND status='pending' AND (checkedAt IS NULL OR checkedAt<=?)")
        .run(Date.now(), orderId, Date.now() - 3000).changes === 1;
    },
    expireViewerOrder(orderId) {
      sql("UPDATE viewer_test_orders SET status='expired',ledgerVersion=ledgerVersion+1 WHERE orderId=? AND status='pending' AND intentId IS NULL").run(orderId);
    },
    reconcileViewerPayment(order, { intentId, chargeId, paidAt, refundedAmount, disputeStatus, revocationReason, stripeFeeCents = null, chargeBalanceId = null,
      taxCents, tipTaxCents, chargedTotalCents }) {
      if (order.taxPolicy === 'none') {
        taxCents ??= 0;
        tipTaxCents ??= 0;
        chargedTotalCents ??= order.amount + order.tipAmount;
      }
      const cents = value => Number.isSafeInteger(value) && value >= 0;
      if (![taxCents, tipTaxCents, chargedTotalCents, refundedAmount].every(cents) ||
          tipTaxCents > taxCents || tipTaxCents > order.tipAmount || refundedAmount > chargedTotalCents ||
          chargedTotalCents !== order.amount + order.tipAmount + taxCents - tipTaxCents ||
          (order.taxPolicy === 'none' && taxCents !== 0) || (stripeFeeCents !== null && !cents(stripeFeeCents))) {
        throw new Error('Invalid verified checkout totals.');
      }
      if ((chargeBalanceId !== null && (!/^txn_[a-zA-Z0-9]+$/.test(chargeBalanceId) || (order.chargeBalanceId && order.chargeBalanceId !== chargeBalanceId))) ||
          (order.chargedTotalCents !== null && (order.chargedTotalCents !== chargedTotalCents || order.taxCents !== taxCents || order.tipTaxCents !== tipTaxCents)) ||
          (order.stripeFeeCents !== null && stripeFeeCents !== null && order.stripeFeeCents !== stripeFeeCents)) {
        throw new Error('The verified payment amounts changed.');
      }
      // A slower provider read cannot overwrite a newer reconciliation from another process.
      return sql(`UPDATE viewer_test_orders SET status=CASE WHEN ? IS NOT NULL OR
          (kind='rent' AND COALESCE(paidAt,?)+rentalHours*3600<=?) THEN 'expired' ELSE 'paid' END,
          intentId=?, chargeId=?, paidAt=COALESCE(paidAt,?), refundedAmount=?, disputeStatus=?, revocationReason=?,
          taxCents=?, tipTaxCents=?, chargedTotalCents=?, stripeFeeCents=COALESCE(stripeFeeCents,?),chargeBalanceId=COALESCE(chargeBalanceId,?),
          verifiedAt=unixepoch(), ledgerVersion=ledgerVersion+1 WHERE orderId=? AND sessionId=? AND ledgerVersion=?
          AND (intentId IS NULL OR intentId=?) AND (chargeId IS NULL OR chargeId=?) RETURNING *`)
        .get(revocationReason, paidAt, Math.floor(Date.now()/1000), intentId, chargeId, paidAt, refundedAmount,
          disputeStatus, revocationReason, taxCents, tipTaxCents, chargedTotalCents, stripeFeeCents, chargeBalanceId,
          order.orderId, order.sessionId, order.ledgerVersion, intentId, chargeId);
    },
    noteViewerWebhook(orderId, eventId) {
      sql('UPDATE viewer_test_orders SET webhookEventId=COALESCE(webhookEventId,?),webhookAt=COALESCE(webhookAt,?) WHERE orderId=?')
        .run(eventId, Date.now(), orderId);
    },
    saveStorageDraft(owner, config) {
      sql('INSERT INTO storage_drafts VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET config=excluded.config').run(owner, JSON.stringify(config));
    },
    storageDraft(owner) {
      const row = sql('SELECT config FROM storage_drafts WHERE owner=?').get(owner);
      return row && JSON.parse(row.config);
    },
    saveBucket(owner, { accountId, bucket, jurisdiction, accessKeyId, secretAccessKey, uploads }, { select = true } = {}) {
      const config = { accountId, jurisdiction, bucket, ...(uploads ? { uploads: true } : {}) };
      const id = connectionId(owner, config);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ accessKeyId, secretAccessKey })), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      transaction(() => {
        sql('INSERT INTO buckets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed,config=excluded.config')
          .run(id, owner, JSON.stringify(config), sealed);
        if (select) sql('UPDATE makers SET bucket_id=? WHERE id=?').run(id, owner);
        if (select) sql('DELETE FROM storage_drafts WHERE owner=?').run(owner);
      });
    },
    credentials(owner, config) {
      const saved = bucketAccess(owner, config);
      return saved.uploads ? bucketReader(saved) : saved;
    },
    uploadCredentials(owner, config) {
      const saved = bucketAccess(owner, config);
      return saved.uploads ? saved : undefined;
    },
    upload(owner, id) {
      const row = sql('SELECT data FROM film_uploads WHERE owner=? AND draftId=?').get(owner, id);
      return row && JSON.parse(row.data);
    },
    saveUpload(owner, id, value) {
      sql('INSERT INTO film_uploads VALUES(?,?,?) ON CONFLICT(owner,draftId) DO UPDATE SET data=excluded.data')
        .run(owner, id, JSON.stringify(value));
    },
    clearUpload(owner, id) { sql('DELETE FROM film_uploads WHERE owner=? AND draftId=?').run(owner, id); },
    finishUpload(owner, id, objectKey) {
      transaction(() => {
        const changed = sql("UPDATE makers SET draft=json_set(draft,'$.objectKey',?) WHERE id=? AND json_extract(draft,'$.id')=?").run(objectKey, owner, id);
        if (!changed.changes) throw new Error('Film draft changed.');
        sql("UPDATE film_uploads SET data=json_set(data,'$.complete',json('true')) WHERE owner=? AND draftId=?").run(owner,id);
      });
    },
    saveDraft(owner, draft) { sql('UPDATE makers SET draft=? WHERE id=?').run(JSON.stringify(draft), owner); },
    nextDraft(owner) { store.saveDraft(owner, newDraft()); },
    saveFilm(owner, bucket, film) {
      transaction(() => {
        sql('INSERT INTO films VALUES(?,?,?,?)').run(film.id, owner, connectionId(owner, bucket), JSON.stringify(film));
        store.clearUpload(owner, film.id);
      });
    },
    setFilmPrices(owner, id, prices) {
      return sql("UPDATE films SET metadata=json_set(metadata, '$.prices', json(?)) WHERE owner=? AND id=?")
        .run(JSON.stringify(prices), owner, id).changes === 1;
    },
    setFilmSettings(owner, id, { prices, rentalHours, previewSeconds }) {
      return sql("UPDATE films SET metadata=json_set(metadata,'$.prices',json(?),'$.rentalHours',?,'$.previewSeconds',?) WHERE owner=? AND id=?")
        .run(JSON.stringify(prices), rentalHours, previewSeconds, owner, id).changes === 1;
    },
    setFilmInfo(owner, id, info) {
      return sql("UPDATE films SET metadata=json_set(metadata,'$.info',json(?)) WHERE owner=? AND id=?")
        .run(JSON.stringify(info), owner, id).changes === 1;
    },
    beginThumbnailEdit(owner, id) {
      const lock = randomUUID(), now = Date.now();
      const table = isProgramId(id) ? 'programs' : 'films';
      const acquired = sql(`INSERT INTO thumbnail_edits SELECT id,?,? FROM ${table} WHERE owner=? AND id=?
        ON CONFLICT(filmId) DO UPDATE SET lock=excluded.lock, expires=excluded.expires WHERE expires < ?`)
        .run(lock, now + 120000, owner, id, now).changes;
      return acquired ? lock : null;
    },
    markThumbnailPending(owner, id) {
      sql(`UPDATE ${isProgramId(id) ? 'programs' : 'films'} SET metadata=json_set(metadata,'$.thumbnail','pending') WHERE owner=? AND id=?`).run(owner, id);
    },
    reconcileThumbnail(owner, id, version) {
      sql(`UPDATE ${isProgramId(id) ? 'programs' : 'films'} SET metadata=json_set(metadata,'$.thumbnail',?) WHERE owner=? AND id=?
        AND json_extract(metadata,'$.thumbnail')='pending'
        AND NOT EXISTS (SELECT 1 FROM thumbnail_edits WHERE filmId=? AND expires>=?)`)
        .run(version, owner, id, id, Date.now());
    },
    finishThumbnailEdit(owner, id, lock, version) {
      transaction(() => {
        if (sql('DELETE FROM thumbnail_edits WHERE filmId=? AND lock=?').run(id, lock).changes && version !== undefined) {
          sql(`UPDATE ${isProgramId(id) ? 'programs' : 'films'} SET metadata=json_set(metadata,'$.thumbnail',?) WHERE owner=? AND id=?`).run(version, owner, id);
        }
      });
    },
    setFilmPublication(owner, id, published) {
      return transaction(() => {
        const changed = sql(`INSERT INTO film_publication (filmId,owner,published) SELECT id,owner,? FROM films WHERE id=? AND owner=?
          ON CONFLICT(filmId) DO UPDATE SET published=excluded.published WHERE owner=excluded.owner`)
          .run(published ? 1 : 0, id, owner).changes === 1;
        if (changed && !published) {
          sql("UPDATE viewer_test_orders SET withdrawalState='requested' WHERE owner=? AND filmId=? AND status='pending' AND withdrawalState IS NULL").run(owner,id);
          store.withdrawProgramsContaining(owner,id);
        }
        return changed;
      });
    },
    filmPublication(id) { return sql('SELECT owner,published FROM film_publication WHERE filmId=?').get(id); },
    publishedFilmIds() { return sql('SELECT filmId FROM film_publication WHERE published=1 ORDER BY rowid').all().map(row => row.filmId); },
    priorOrderOwner(id) {
      return sql(`SELECT owner FROM viewer_test_orders WHERE filmId=? AND sessionId IS NOT NULL
        UNION ALL SELECT owner FROM connected_test_orders WHERE filmId=? AND intentId IS NOT NULL LIMIT 1`).get(id, id)?.owner;
    },
    recordView(owner, id, kind, eventId) {
      if (!['preview', 'paid'].includes(kind) || typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(eventId)) return false;
      const now = Date.now();
      return transaction(() => {
        // Retain anonymous retry identifiers for a day; keep only counts thereafter.
        sql('DELETE FROM film_view_receipts WHERE rowid IN (SELECT rowid FROM film_view_receipts WHERE createdAt<? LIMIT 64)').run(now - 86400_000);
        const digest = hash(JSON.stringify([id, kind, eventId]));
        const added = sql('INSERT OR IGNORE INTO film_view_receipts SELECT id,?,?,? FROM films WHERE owner=? AND id=?')
          .run(kind, digest, now, owner, id).changes;
        if (!added) return false;
        sql(`INSERT INTO film_counts(filmId,previews,plays) VALUES(?,?,?) ON CONFLICT(filmId)
          DO UPDATE SET previews=previews+excluded.previews, plays=plays+excluded.plays`)
          .run(id, kind === 'preview' ? 1 : 0, kind === 'paid' ? 1 : 0);
        return true;
      });
    },
    programs(owner) {
      return store.programStats(owner).map(({id,stats}) => ({ ...store.program(owner,id), stats }));
    },
    bucketFilmTitles(owner, config, keys) {
      const rows = sql(`SELECT json_extract(metadata,'$.objectKey') AS key, json_extract(metadata,'$.title') AS title
        FROM films WHERE owner=? AND bucket_id=? AND json_extract(metadata,'$.objectKey') IN (SELECT value FROM json_each(?))
        ORDER BY rowid`).all(owner, connectionId(owner, config), JSON.stringify(keys));
      return new Map(rows.map(row => [row.key, row.title]));
    },
    films(owner) {
      const rows = sql("SELECT id,json_extract(metadata,'$.title') AS title,json_extract(metadata,'$.prices') AS prices,json_extract(metadata,'$.rentalHours') AS hours,json_extract(metadata,'$.previewSeconds') AS seconds FROM films WHERE owner=? ORDER BY rowid DESC").all(owner);
      return rows.map(({ id, title, prices, hours, seconds }) => ({ id, title, prices: prices === null ? undefined : JSON.parse(prices),
        rentalHours: hours ?? undefined, previewSeconds: seconds ?? undefined }));
    },
    film(owner, id) {
      const row = sql('SELECT f.metadata, b.config FROM films f JOIN buckets b ON b.id=f.bucket_id AND b.owner=f.owner WHERE f.id=? AND f.owner=?').get(id, owner);
      return row && { ...JSON.parse(row.metadata), bucket: JSON.parse(row.config) };
    },
    close() { if (db.isOpen) db.close(); }
  };
  return store;
}
