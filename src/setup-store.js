import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recoveryStore } from './viewer-recovery.js';
import { StripeSetupError, stripeSetupStateForMode } from './setup-stripe.js';
import { filmPrices, isPrice, rentalHours } from './prices.js';

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
    CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS storage_drafts (owner TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (mode TEXT NOT NULL, account TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(mode, account));
    CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, config TEXT NOT NULL, sealed BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS films (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bucket_id TEXT NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS film_publication (
      filmId TEXT PRIMARY KEY, owner TEXT NOT NULL, published INTEGER NOT NULL CHECK (published IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS film_counts (filmId TEXT PRIMARY KEY, previews INTEGER NOT NULL, plays INTEGER NOT NULL);
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
    const columns = new Set(sql('PRAGMA table_info(viewer_test_orders)').all().map(row => row.name));
    if (!columns.has('verifiedAt')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN verifiedAt INTEGER');
    if (!columns.has('position')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('kind')) db.exec("ALTER TABLE viewer_test_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'rent'");
    if (!columns.has('amount')) db.exec('ALTER TABLE viewer_test_orders ADD COLUMN amount INTEGER NOT NULL DEFAULT 99');
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
      CREATE INDEX IF NOT EXISTS viewer_withdrawal_due ON viewer_test_orders(withdrawalRetryAt) WHERE withdrawalState='requested' AND sessionId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS viewer_order_legacy_receipt ON viewer_test_orders(filmId,paidAt);
      CREATE TABLE IF NOT EXISTS viewer_payment_events(
        account TEXT NOT NULL,eventId TEXT NOT NULL,orderId TEXT NOT NULL,receivedAt INTEGER NOT NULL,
        PRIMARY KEY(account,eventId))`);
  });
  const accessOrder = sql('SELECT filmId,owner,account,scope,revision,kind,intentId,paidAt,rentalHours,status,revocationReason,disputeStatus FROM viewer_test_orders WHERE orderId=?');
  const store = {
    ...recoveryStore(db, key),
    invite(owner) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._@+-]{0,95}$/.test(owner)) throw new Error('Use a short, unique filmmaker name.');
      const code = token();
      transaction(() => {
        const now = Date.now();
        sql('DELETE FROM invitations WHERE expires <= ? OR owner = ?').run(now, owner);
        sql('DELETE FROM sessions WHERE expires <= ?').run(now);
        sql('INSERT OR IGNORE INTO makers(id,draft) VALUES(?,?)').run(owner, JSON.stringify(newDraft()));
        sql('INSERT INTO invitations VALUES(?,?,?)').run(hash(code), owner, now + 30 * 60_000);
      });
      return code;
    },
    signIn(code) {
      if (!/^[\w-]{43}$/.test(code)) return;
      return transaction(() => {
        const row = sql('DELETE FROM invitations WHERE digest=? AND expires>? RETURNING owner').get(hash(code), Date.now());
        if (!row) return;
        const session = token();
        sql('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session), row.owner, token(), Date.now() + 14 * 86400_000);
        return session;
      });
    },
    session(value) {
      return value && sql('SELECT owner, csrf FROM sessions WHERE digest=? AND expires>?').get(hash(value), Date.now());
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
    reserveViewerOrder({ tokenHash, id, owner, account, scope, revision, platform, title, origin, kind, amount, rentalHours: hours = 48 }) {
      return transaction(() => {
        const existing = store.viewerOrderForToken(tokenHash);
        if (existing) return existing;
        const maker = store.maker(owner);
        const seller = maker && stripeSetupStateForMode(maker.stripe, 'test');
        const film = store.film(owner, id);
        if (store.filmPublication(id)?.published === 0 || !store.ownsTestAccount(owner, account) || seller?.accountId !== account || film?.revision !== revision ||
            !isPrice(amount) || filmPrices(film.prices)?.[kind] !== amount ||
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
        sql("INSERT INTO viewer_test_orders (tokenHash,orderId,filmId,owner,account,scope,revision,platform,title,origin,createdAt,kind,amount,uiMode,cardOnly,rentalHours) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'elements',1,?)")
          .run(tokenHash, randomUUID(), id, owner, account, scope, revision, platform, title, origin, now, kind, amount, kind === 'rent' ? hours : 48);
        return store.viewerOrderForToken(tokenHash);
      });
    },
    viewerOrderForToken(digest) { return sql('SELECT * FROM viewer_test_orders WHERE tokenHash=?').get(digest); },
    viewerOrderById(id) { return sql('SELECT * FROM viewer_test_orders WHERE orderId=?').get(id); },
    viewerAccessById(id) { return accessOrder.get(id); },
    viewerOrderBySession(id) { return sql('SELECT * FROM viewer_test_orders WHERE sessionId=?').get(id); },
    viewerOrderByPayment(account, intentId, chargeId) {
      return sql('SELECT * FROM viewer_test_orders WHERE account=? AND (intentId=? OR chargeId=?)').get(account, intentId ?? null, chargeId);
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
    reconcileViewerPayment(order, { intentId, chargeId, paidAt, refundedAmount, disputeStatus, revocationReason }) {
      // A slower provider read cannot overwrite a newer reconciliation from another process.
      return sql(`UPDATE viewer_test_orders SET status=CASE WHEN ? IS NOT NULL OR
          (kind='rent' AND COALESCE(paidAt,?)+rentalHours*3600<=?) THEN 'expired' ELSE 'paid' END,
          intentId=?, chargeId=?, paidAt=COALESCE(paidAt,?), refundedAmount=?, disputeStatus=?, revocationReason=?,
          verifiedAt=unixepoch(), ledgerVersion=ledgerVersion+1 WHERE orderId=? AND sessionId=? AND ledgerVersion=?
          AND (intentId IS NULL OR intentId=?) AND (chargeId IS NULL OR chargeId=?) RETURNING *`)
        .get(revocationReason, paidAt, Math.floor(Date.now()/1000), intentId, chargeId, paidAt, refundedAmount,
          disputeStatus, revocationReason, order.orderId, order.sessionId, order.ledgerVersion, intentId, chargeId);
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
    saveBucket(owner, { accountId, bucket, jurisdiction, accessKeyId, secretAccessKey }) {
      const config = { accountId, jurisdiction, bucket };
      const id = connectionId(owner, config);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ accessKeyId, secretAccessKey })), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      transaction(() => {
        sql('INSERT INTO buckets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed')
          .run(id, owner, JSON.stringify(config), sealed);
        sql('UPDATE makers SET bucket_id=? WHERE id=?').run(id, owner);
        sql('DELETE FROM storage_drafts WHERE owner=?').run(owner);
      });
    },
    credentials(owner, config) {
      const id = connectionId(owner, config);
      const row = sql('SELECT sealed FROM buckets WHERE id=? AND owner=?').get(id, owner);
      if (!row) throw new Error('Storage connection unavailable.');
      const bytes = Buffer.from(row.sealed);
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const clear = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
      return { ...config, ...JSON.parse(clear.toString('utf8')) };
    },
    saveDraft(owner, draft) { sql('UPDATE makers SET draft=? WHERE id=?').run(JSON.stringify(draft), owner); },
    nextDraft(owner) { store.saveDraft(owner, newDraft()); },
    saveFilm(owner, bucket, film) {
      sql('INSERT INTO films VALUES(?,?,?,?)').run(film.id, owner, connectionId(owner, bucket), JSON.stringify(film));
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
    setFilmPublication(owner, id, published) {
      return transaction(() => {
        const changed = sql(`INSERT INTO film_publication (filmId,owner,published) SELECT id,owner,? FROM films WHERE id=? AND owner=?
          ON CONFLICT(filmId) DO UPDATE SET published=excluded.published WHERE owner=excluded.owner`)
          .run(published ? 1 : 0, id, owner).changes === 1;
        if (changed && !published) {
          sql("UPDATE viewer_test_orders SET withdrawalState='requested' WHERE owner=? AND filmId=? AND status='pending' AND withdrawalState IS NULL").run(owner,id);
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
    dashboardFilms(owner) {
      const rows = sql(`SELECT f.metadata, COALESCE(c.previews,0) AS previews,COALESCE(c.plays,0) AS plays,
        COALESCE(p.rentals,0) AS rentals,COALESCE(p.purchases,0) AS purchases,
        COALESCE(p.gross,0) AS gross,COALESCE(p.refunded,0) AS refunded FROM films f
        LEFT JOIN film_counts c ON c.filmId=f.id
        LEFT JOIN (SELECT filmId,SUM(kind='rent') AS rentals,SUM(kind='buy') AS purchases,
          SUM(amount) AS gross,SUM(refundedAmount) AS refunded FROM viewer_test_orders
          WHERE owner=? AND intentId IS NOT NULL AND paidAt IS NOT NULL GROUP BY filmId) p ON p.filmId=f.id
        WHERE f.owner=? ORDER BY f.rowid DESC`).all(owner, owner);
      return rows.map(({ metadata, ...stats }) => {
        const { id, title, prices, previewSeconds, rentalHours, duration, info } = JSON.parse(metadata);
        return { id, title, prices, previewSeconds, rentalHours, duration, info, stats };
      });
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
