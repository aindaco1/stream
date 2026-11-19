import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS makers (
      id TEXT PRIMARY KEY, stripe TEXT NOT NULL DEFAULT '{}', bucket_id TEXT, draft TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS storage_drafts (owner TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (mode TEXT NOT NULL, account TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(mode, account));
    CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, config TEXT NOT NULL, sealed BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS films (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bucket_id TEXT NOT NULL, metadata TEXT NOT NULL);`);
  const sql = query => db.prepare(query);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const store = {
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
    claimAccount(owner, account, mode) {
      sql('INSERT OR IGNORE INTO claims VALUES(?,?,?)').run(mode, account, owner);
      return sql('SELECT owner FROM claims WHERE mode=? AND account=?').get(mode, account).owner === owner;
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
    films(owner) {
      return sql("SELECT id, json_extract(metadata, '$.title') AS title FROM films WHERE owner=? ORDER BY rowid DESC").all(owner);
    },
    film(owner, id) {
      const row = sql('SELECT f.metadata, b.config FROM films f JOIN buckets b ON b.id=f.bucket_id AND b.owner=f.owner WHERE f.id=? AND f.owner=?').get(id, owner);
      return row && { ...JSON.parse(row.metadata), bucket: JSON.parse(row.config) };
    },
    close() { if (db.isOpen) db.close(); }
  };
  return store;
}
