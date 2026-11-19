import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recoveryStore, createViewerRecovery } from '../src/viewer-recovery.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const offer = { owner: 'A', id: 'film-a', account: 'acct_one', title: 'Test film', revision: 'cut-v1' };
const buyer = 'Buyer@example.test';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE viewer_test_orders (orderId TEXT PRIMARY KEY,owner,filmId,account,revision,kind,
    status,paidAt INTEGER,rentalHours INTEGER,tokenHash,position INTEGER,sessionId);
    CREATE TABLE claims (mode TEXT, account TEXT, owner TEXT, PRIMARY KEY(mode,account))`);
  db.prepare("INSERT INTO claims VALUES('test',?,?)").run(offer.account, offer.owner);
  db.prepare("INSERT INTO viewer_test_orders VALUES('one',?,?,?,?,'rent','paid',unixepoch(),48,'original',63,'session')")
    .run(offer.owner, offer.id, offer.account, offer.revision);
  const store = recoveryStore(db, randomBytes(32));
  return { db, store };
}

test('email recovery binds to the verified address, film, seller, cut and original rental clock', t => {
  const { db,store } = fixture(t);
  assert.equal(store.previousRecoveryOrders(0).length, 1);
  store.rememberViewerEmail('one', null);
  assert.equal(store.previousRecoveryOrders(0).length, 0, 'An old charge without an email needs one backfill read');
  store.rememberViewerEmail('one', buyer);
  assert.equal(store.previousRecoveryOrders(0).length, 0);
  for (const address of ['else@example.test', buyer + ',other@example.test', buyer + '\n']) {
    assert.equal(store.reserveRecovery(offer, address), undefined);
  }
  const {code} = store.reserveRecovery(offer, 'Buyer@EXAMPLE.TEST');
  assert.equal(store.reserveRecovery(offer, buyer), undefined, 'cooldown during concurrent requests');
  for (const wrong of [{id:'film-b'}, {owner:'B'}, {account:'acct_two'}, {revision:'cut-v2'}]) {
    assert.equal(store.redeemRecovery({...offer,...wrong},code), undefined);
  }
  const access = store.redeemRecovery(offer,code);
  assert.equal(store.redeemRecovery(offer, code), undefined, 'single use');
  const restored = store.viewerOrderForAccess(hash(access));
  assert.equal(restored.position,63);
  assert.equal(restored.tokenHash,'original');
  store.setViewerPosition('one',81);
  assert.equal(store.viewerOrderForAccess('original').position,81);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM viewer_test_orders').get().n,1);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM viewer_recovery').get()).includes(buyer));
  db.exec('UPDATE viewer_recovery SET sentAt=0');
  const expiring = store.reserveRecovery(offer,buyer).code;
  db.exec('UPDATE viewer_recovery SET sentAt=0');
  assert.equal(store.redeemRecovery(offer,expiring),undefined);
  const revoked = store.reserveRecovery(offer,buyer).code;
  db.exec("UPDATE viewer_test_orders SET status='expired'");
  assert.equal(store.redeemRecovery(offer,revoked),undefined);
  db.exec("UPDATE viewer_test_orders SET status='paid',paidAt=unixepoch()-48*3600");
  assert.equal(store.redeemRecovery(offer,revoked),undefined);
  assert.equal(store.reserveRecovery(offer,buyer),undefined);
});

test('recovery emails contain a single-use fragment and only go to an eligible test recipient', async t => {
  const { store } = fixture(t);
  store.rememberViewerEmail('one',buyer);
  const calls = [];
  const ready = Promise.withResolvers();
  const recovery = createViewerRecovery({ store, env:{ RESEND_API_KEY:'fixture', STREAM_RECOVERY_FROM:'Stream <stream@example.test>',
    STREAM_RECOVERY_TEST_TO:buyer }, fetchImpl:async (url, init) => {
    calls.push({url,payload:JSON.parse(init.body)});
    ready.resolve();
    return new Response('{}');
  }});
  for (const address of ['other@example.test',buyer,buyer]) recovery.request(offer,address,'https://stream.example.test');
  await ready.promise;
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].payload.to,[buyer]);
  assert.equal(calls[0].payload.headers['Auto-Submitted'],'auto-generated');
  const link = new URL(calls[0].payload.text.match(/https:\S+/)[0]);
  assert.equal(link.pathname,'/embed/film-a');
  assert.equal(link.search,'');
  const code = new URLSearchParams(link.hash.slice(1)).get('restore');
  const token = recovery.redeem(offer,code);
  assert.equal(store.viewerOrderForAccess(hash(token)).orderId,'one');
  assert.equal(recovery.redeem(offer,code),undefined);
});
