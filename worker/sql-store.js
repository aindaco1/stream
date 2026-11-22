import { createHash } from 'node:crypto';
import { createSetupStore } from '../src/setup-store-core.js';

// The domain store uses the synchronous SQLite statement interface on both runtimes.
export function openDurableStore(storage, encodedKey) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey ?? '')) throw Error('Configure a 32-byte STREAM_VAULT_KEY.');
  const db = {
    exec(sql) {
      storage.sql.exec(sql).toArray();
    },
    prepare(query) {
      function execute(args) {
        let sql = query;
        const named = args.length === 1 && args[0] && Object.getPrototypeOf(args[0]) === Object.prototype;
        if (named) {
          const bindings = args[0];
          args = [];
          sql = sql.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
            if (!Object.hasOwn(bindings, name)) throw Error('Missing SQL binding.');
            args.push(bindings[name]);
            return '?';
          });
        }
        return storage.sql.exec(
          sql,
          ...args.map((value) =>
            ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value
          )
        );
      }
      return {
        get(...args) {
          return execute(args).next().value;
        },
        all(...args) {
          return execute(args).toArray();
        },
        run(...args) {
          execute(args).toArray();
          return { changes: storage.sql.exec('SELECT changes() AS changes').one().changes };
        }
      };
    }
  };
  const key = Buffer.from(encodedKey, 'base64url');
  const store = createSetupStore(db, key, 'live', (fn) => storage.transactionSync(fn));
  storage.transactionSync(() => {
    const fingerprint = createHash('sha256').update(key).digest('hex');
    db.exec(
      'CREATE TABLE IF NOT EXISTS stream_vault_identity (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL)'
    );
    const saved = db.prepare('SELECT fingerprint FROM stream_vault_identity WHERE id=1').get();
    if (saved && saved.fingerprint !== fingerprint) throw Error('Vault key differs from the original Stream key.');
    if (!saved) db.prepare('INSERT INTO stream_vault_identity VALUES(1,?)').run(fingerprint);
  });
  return store;
}
