import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSetupStore } from './setup-store-core.js';

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

export function openSetupStore(directory, paymentMode = 'test') {
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
  function transaction(fn, readOnly = false) {
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  try { return createSetupStore(db, key, paymentMode, transaction); }
  catch (error) { db.close(); throw error; }
}
