import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openSetupStore } from '../src/setup-store.js';
import { renderPlatformDashboard } from '../src/setup-view.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stream-tax-ledger-'));
  let store = openSetupStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = 'Seller', account = 'acct_Seller', platform = 'acct_DustWave', id = 'f-' + randomUUID();
  const bucket = { accountId: 'c'.repeat(32), bucket: 'private-tests', jurisdiction: 'default' };
  store.invite(owner);
  store.claimAccount(owner, account, 'test');
  store.saveStripe(owner, { byMode: { test: { accountId:account, mode:'test',status:'ready',chargesEnabled:true,payoutsEnabled:true } } });
  store.saveBucket(owner, { ...bucket, accessKeyId:'test',secretAccessKey:'local-test' });
  store.saveFilm(owner,bucket,{id,title:'Film',revision:'cut',prices:{rent:1000,buy:1000}});
  const offer = { id,owner,account,platform,scope:'film-scope',revision:'cut',title:'Film',origin:'https://stream.test',
    kind:'rent',amount:1000,tipPercent:10,taxPolicy:'marketplace-v1' };
  const reserve = (extra = {}) => {
    const order = store.reserveViewerOrder({ ...offer,tokenHash:randomUUID(),...extra });
    const session = order.sessionId || 'cs_' + randomUUID();
    store.bindViewerSession(order.orderId, session);
    return store.viewerOrderBySession(session);
  };
  const verified = { intentId:'pi_Sale',chargeId:'ch_Sale',paidAt:Math.floor(Date.now()/1000),refundedAmount:0,
    revocationReason:null,disputeStatus:null,taxCents:90,tipTaxCents:10,chargedTotalCents:1180 };
  return { get store() { return store; },owner,platform,account,reserve,verified,
    restart() { store.close(); store = openSetupStore(directory); } };
}

test('tax policy and verified charges survive restart, receipt replay, fee delays and later refunds', async t => {
  const ctx = await setup(t), order = ctx.reserve();
  assert.equal(order.taxPolicy, 'marketplace-v1');
  assert.equal(order.chargedTotalCents, null);
  assert.equal(ctx.reserve({tokenHash:order.tokenHash,taxPolicy:'none'}).taxPolicy, 'marketplace-v1');
  assert.throws(() => ctx.reserve({taxPolicy:'unknown'}));
  const settle = (extra, current = ctx.store.viewerOrderById(order.orderId)) =>
    ctx.store.reconcileViewerPayment(current, {...ctx.verified,...extra});
  for (const bad of [{taxCents:undefined},{tipTaxCents:-1},{tipTaxCents:91},{tipTaxCents:8.3},{taxCents:140,tipTaxCents:102},
    {chargedTotalCents:1190},{refundedAmount:1181},{stripeFeeCents:-5}]) assert.throws(() => settle(bad));
  assert.equal(ctx.store.pendingViewerTransfers().length,0);
  assert.equal(settle().stripeFeeCents,null);
  const report = () => ctx.store.platformReport(null);
  assert.equal(report().total.taxCollected,90);
  assert.equal(report().total.platformTips,90);
  assert.equal(report().total.revenue,1000);
  assert.equal(report().total.netRevenue,936);
  assert.equal(report().total.estimatedFees,64);
  assert.equal(report().total.estimatedOrders,1);
  assert.equal(ctx.store.pendingViewerTransfers(ctx.platform)[0].orderId,order.orderId);
  assert.equal(ctx.store.pendingViewerTransfers('acct_Other').length,0);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_TooEarly'),false);
  ctx.restart();
  assert.deepEqual([ctx.store.viewerOrderByPlatformPayment(ctx.platform,'pi_Sale','ch_Sale').orderId,
    ctx.store.viewerOrderByPlatformPayment(ctx.platform,null,'ch_Sale').orderId], [order.orderId,order.orderId]);
  assert.equal(ctx.store.viewerOrderByPlatformPayment('acct_Other','pi_Sale','ch_Sale'),undefined);
  assert.equal(ctx.store.viewerOrderByPlatformPayment(ctx.platform,'pi_Wrong','ch_Sale'),undefined);
  assert.equal(ctx.store.viewerOrderByPayment(ctx.account,'pi_Sale','ch_Sale'),undefined);
  assert.throws(() => settle({taxCents:110,tipTaxCents:20,chargedTotalCents:1190}));
  const later = settle({stripeFeeCents:55});
  assert.equal(settle({},order),undefined);
  assert.throws(() => settle({stripeFeeCents:56},later));
  assert.equal(settle({}).stripeFeeCents,55);
  assert.equal(report().total.netRevenue,945);
  assert.equal(report().total.reportedFees,55);
  assert.equal(report().total.estimatedFees,64);
  assert.equal(report().total.estimatedOrders,0);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'no_proceeds'),false);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_Seller'),true);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_Seller'),true);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_Different'),false);
  ctx.restart();
  assert.equal(ctx.store.pendingViewerTransfers().length,0);
  const reversed = settle({refundedAmount:1180,revocationReason:'refund'});
  assert.equal(reversed.transferId,'tr_Seller');
  assert.equal(report().total.transfersToReview,1);
  assert.equal(report().total.netRevenue,-55);
  assert.equal(report().total.platformTips,90);
  assert.equal(report().total.taxCollected,90);
  const admin = renderPlatformDashboard('test', report());
  assert.match(admin,/Transfers to review/);
  assert.match(admin,/Tax charged/);
  assert.match(admin,/reversal after funds were sent/);
});

test('transfer retries survive restart and separate zero-proceeds, adjusted and historical orders', async t => {
  const ctx = await setup(t);
  const now = Date.now();
  t.mock.timers.enable({apis:['Date'],now});
  function paid(suffix, policy, adjustments = {}) {
    const order = ctx.reserve({taxPolicy:policy});
    return ctx.store.reconcileViewerPayment(order, {...ctx.verified,intentId:'pi_' + suffix,chargeId:'ch_' + suffix,
      ...(policy==='none' && {taxCents:0,tipTaxCents:0,chargedTotalCents:1100}),...adjustments});
  }
  const old = paid('Old','none'), empty = paid('Tiny','marketplace-v1',{stripeFeeCents:1000});
  const expired = paid('Expired','marketplace-v1',{paidAt:Math.floor(now/1000)-3*86400,stripeFeeCents:35});
  const counted = paid('Partial','marketplace-v1',{refundedAmount:5,stripeFeeCents:40});
  paid('Disputed','marketplace-v1',{disputeStatus:'needs_response',revocationReason:'dispute'});
  assert.equal(expired.status,'expired');
  assert.equal(ctx.store.setViewerTransfer(old.orderId,'tr_Old'),false);
  assert.equal(ctx.store.setViewerTransfer(empty.orderId,'tr_Tiny'),false);
  assert.equal(ctx.store.setViewerTransfer(empty.orderId,'no_proceeds'),true);
  assert.equal(ctx.store.setViewerTransfer(empty.orderId,'no_proceeds'),true);
  assert.equal(ctx.store.viewerOrderByPayment(ctx.account,'pi_Old','ch_Old').orderId,old.orderId);
  assert.equal(ctx.store.viewerOrderByPlatformPayment(ctx.platform,'pi_Old','ch_Old'),undefined);
  assert.deepEqual(ctx.store.pendingViewerTransfers().map(o=>o.orderId),[expired.orderId]);
  ctx.store.retryViewerTransfer(expired.orderId);
  ctx.restart();
  assert.equal(ctx.store.pendingViewerTransfers().length,0);
  t.mock.timers.tick(30001);
  assert.deepEqual(ctx.store.pendingViewerTransfers().map(o=>o.orderId),[expired.orderId]);
  assert.equal(ctx.store.setViewerTransfer(expired.orderId,'tr_OnlyOnce'),true);
  // A successful provider POST may return after an adjustment. Retain its ID for review.
  assert.equal(ctx.store.setViewerTransfer(counted.orderId,'tr_OnlyOnce'),false);
  assert.equal(ctx.store.setViewerTransfer(counted.orderId,'tr_Adjusted'),true);
  assert.equal(ctx.store.platformReport(null).total.transfersToReview,2);
});

test('an original order schema migrates with both paid orders and unfinished legacy Sessions intact', async t => {
  const directory = await mkdtemp(join(tmpdir(),'stream-old-tax-ledger-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const old = new DatabaseSync(join(directory,'setup.sqlite'));
  old.exec(`CREATE TABLE viewer_test_orders (
    tokenHash TEXT PRIMARY KEY,orderId TEXT UNIQUE,filmId TEXT,owner TEXT,account TEXT,scope TEXT,revision TEXT,
    platform TEXT,title TEXT,origin TEXT,createdAt INTEGER,sessionId TEXT UNIQUE,intentId TEXT UNIQUE,paidAt INTEGER,
    status TEXT,checkedAt INTEGER,webhookEventId TEXT,webhookAt INTEGER);
    INSERT INTO viewer_test_orders(tokenHash,orderId,createdAt,status,sessionId,intentId,paidAt)
      VALUES ('one','old-paid',1,'paid','cs_old','pi_old',3),('two','old-open',1,'pending','cs_open',NULL,NULL);`);
  old.close();
  const store = openSetupStore(directory);
  t.after(() => store.close());
  const legacy = store.viewerOrderById('old-paid');
  assert.deepEqual([legacy.taxPolicy,legacy.amount,legacy.tipAmount,legacy.chargedTotalCents,legacy.status],['none',99,0,null,'paid']);
  assert.equal(store.viewerOrderById('old-open').sessionId,'cs_open');
  const verified = store.reconcileViewerPayment(legacy,{intentId:'pi_old',chargeId:'ch_old',paidAt:3,refundedAmount:0,
    disputeStatus:null,revocationReason:null,stripeFeeCents:33});
  assert.deepEqual([verified.taxCents,verified.tipTaxCents,verified.chargedTotalCents],[0,0,99]);
  assert.equal(store.pendingViewerTransfers().length,0);
});
