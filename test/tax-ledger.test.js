import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openSetupStore } from '../src/setup-store.js';
import { newMexicoReport } from '../src/nm-tax-report.js';
import { importTaxFeeReport } from '../src/tax-fee-report.js';
import { filmTaxFeeShare } from '../src/checkout-tips.js';
import { renderPlatformDashboard } from '../src/setup-view.js';

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'stream-tax-ledger-'));
  const directory = join(stateDir, 'filmmakers');
  let store = openSetupStore(directory);
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }); });
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
  return { get store() { return store; },stateDir,owner,platform,account,reserve,verified,
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
  assert.equal(report().total.processingFees,64);
  assert.equal(report().total.estimatedOrders,1);
  assert.equal(ctx.store.pendingViewerTransfers(ctx.platform).length,0);
  assert.deepEqual(ctx.store.claimProcessingFeeChecks(ctx.platform).map(o=>o.orderId),[order.orderId]);
  assert.equal(ctx.store.pendingViewerTransfers('acct_Other').length,0);
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_TooEarly'),false);
  ctx.restart();
  assert.deepEqual([ctx.store.viewerOrderByPlatformPayment(ctx.platform,'pi_Sale','ch_Sale').orderId,
    ctx.store.viewerOrderByPlatformPayment(ctx.platform,null,'ch_Sale').orderId], [order.orderId,order.orderId]);
  assert.equal(ctx.store.viewerOrderByPlatformPayment('acct_Other','pi_Sale','ch_Sale'),undefined);
  assert.equal(ctx.store.viewerOrderByPlatformPayment(ctx.platform,'pi_Wrong','ch_Sale'),undefined);
  assert.equal(ctx.store.viewerOrderByPayment(ctx.account,'pi_Sale','ch_Sale'),undefined);
  assert.throws(() => settle({taxCents:110,tipTaxCents:20,chargedTotalCents:1190}));
  const later = settle({stripeFeeCents:55,chargeBalanceId:'txn_card'});
  assert.equal(ctx.store.setViewerTransfer(order.orderId,'tr_TooEarly'),false);
  assert.equal(ctx.store.pendingTaxFees(ctx.platform).length,1);
  ctx.store.recordTaxFees(ctx.platform,[{chargeId:'ch_Sale',feeCents:0,reference:'frr_zero'}]);
  assert.equal(settle({},order),undefined);
  assert.throws(() => settle({stripeFeeCents:56},later));
  assert.equal(settle({}).stripeFeeCents,55);
  assert.equal(report().total.netRevenue,945);
  assert.equal(report().total.reportedFees,55);
  assert.equal(report().total.processingFees,55);
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
  assert.equal(report().total.paymentAdjustments,1000);
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
    const paidOrder = ctx.store.reconcileViewerPayment(order, {...ctx.verified,chargeBalanceId:'txn_' + suffix,intentId:'pi_' + suffix,chargeId:'ch_' + suffix,
      ...(policy==='none' && {taxCents:0,tipTaxCents:0,chargedTotalCents:1100}),...adjustments});
    if (policy !== 'none' && paidOrder.stripeFeeCents !== null) {
      ctx.store.recordTaxFees(ctx.platform,[{chargeId:paidOrder.chargeId,feeCents:0,reference:'frr_zero'}]);
    }
    return paidOrder;
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
      VALUES ('one','old-paid',1,'paid','cs_old','pi_old',3),('two','old-open',1,'pending','cs_open',NULL,NULL);
    ALTER TABLE viewer_test_orders ADD COLUMN taxPolicy TEXT NOT NULL DEFAULT 'none';
    INSERT INTO viewer_test_orders(tokenHash,orderId,platform,createdAt,status,sessionId,intentId,paidAt,taxPolicy)
      VALUES ('three','market-open','acct_old',1,'pending','cs_mopen',NULL,NULL,'marketplace-v1'),
             ('four','market-paid','acct_old',1,'paid','cs_mpaid','pi_mpaid',3,'marketplace-v1');`);
  old.close();
  const store = openSetupStore(directory);
  t.after(() => store.close());
  const legacy = store.viewerOrderById('old-paid');
  assert.deepEqual([legacy.taxPolicy,legacy.amount,legacy.tipAmount,legacy.chargedTotalCents,legacy.status],['none',99,0,null,'paid']);
  assert.equal(store.viewerOrderById('old-open').sessionId,'cs_open');
  for (const id of ['market-open','market-paid']) {
    const migrated = store.viewerOrderById(id);
    assert.deepEqual([migrated.taxPolicy,migrated.taxBasicFeeCents,migrated.filmTaxFeeCents],['marketplace-v1',0,0]);
  }
  assert.deepEqual(store.pendingTaxFees('acct_old'),[]);
  const verified = store.reconcileViewerPayment(legacy,{intentId:'pi_old',chargeId:'ch_old',paidAt:3,refundedAmount:0,
    disputeStatus:null,revocationReason:null,stripeFeeCents:33});
  assert.deepEqual([verified.taxCents,verified.tipTaxCents,verified.chargedTotalCents],[0,0,99]);
  assert.equal(store.pendingViewerTransfers().length,0);
});

test('the film and tip share the actual fee in whole cents on their tax-inclusive line totals', () => {
  assert.equal(filmTaxFeeShare(11, 2200, 200), 10);
  assert.equal(filmTaxFeeShare(9, 2200, 200), 8); // Actual pricing can differ from 0.5%.
  assert.equal(filmTaxFeeShare(11, 2200, 0), 11);
  assert.equal(filmTaxFeeShare(0, 117, 10), 0);
  assert.equal(filmTaxFeeShare(1, 100, 50), 1);
  assert.throws(() => filmTaxFeeShare(2.5, 100, 10));
  assert.throws(() => filmTaxFeeShare(12, 10, 0));
});

test('the itemized report matches the platform charge and deducts an inline tax fee only once', async t => {
  const ctx = await setup(t);
  const pay = suffix => ctx.store.reconcileViewerPayment(ctx.reserve(), {...ctx.verified, intentId:'pi_' + suffix,
    chargeId:'ch_' + suffix, chargeBalanceId:'txn_' + suffix, stripeFeeCents:60});
  const standalone = pay('standalone'), inline = pay('inline');
  const headers = 'account_id,incurred_by,product,feature_name,amount,currency,balance_transaction_id';
  const row = (account, id, product, feature, amount, currency, ref) => [account,id,product,feature,amount,currency,ref].join(',');
  const external = row(ctx.platform,standalone.chargeId,'Automatic Taxes','Automatic tax','0.1100','USD','txn_fee');
  const included = row(ctx.platform,inline.intentId,'Tax','Automatic tax','0.11','usd',inline.chargeBalanceId);
  const load = (...rows) => importTaxFeeReport(ctx.store,ctx.platform,[headers,...rows].join('\n'));
  assert.equal(ctx.store.platformReport(null).total.pendingTaxFees,2);
  const pendingReport = renderPlatformDashboard('csrf', ctx.store.platformReport(null), true);
  assert.match(pendingReport, /data-report="overview" data-pending-fees/);
  assert.match(pendingReport, />Stripe Tax fees<\/dt><dd>Pending<\/dd>/);
  assert.deepEqual(load(external.replace('0.1100','0.11').replace(ctx.platform,'acct_other'),
    included.replace(',Tax,Automatic tax,',',Payments,Card processing,')),{matched:0,recorded:0});
  for (const bad of [included.replace(',usd,',',eur,'),included.replace('0.11','-0.11'),included.replace('0.11','0.115'),external]) {
    assert.throws(() => load(external,bad));
    assert.equal(ctx.store.viewerOrderById(standalone.orderId).taxBasicFeeCents,null);
  }
  assert.throws(() => load(external,included.replace('0.11','0.61'))); // Whole import rolls back.
  assert.equal(ctx.store.pendingTaxFees(ctx.platform).length,2);
  assert.deepEqual(load(external,included),{matched:2,recorded:2});
  ctx.restart();
  assert.deepEqual(load(external,included),{matched:2,recorded:0});
  assert.throws(() => load(external.replace('0.1100','0.12')));
  const a = ctx.store.viewerOrderById(standalone.orderId), b = ctx.store.viewerOrderById(inline.orderId);
  assert.deepEqual([a.cardProcessingCents,a.filmTaxFeeCents,b.cardProcessingCents,b.filmTaxFeeCents],[60,10,49,10]);
  const totals = ctx.store.platformReport(null).total;
  assert.deepEqual([totals.reportedFees,totals.processingFees,totals.netRevenue,totals.platformTips,totals.filmTaxFees,totals.tipTaxFees,totals.pendingTaxFees],
    [109,109,1871,178,20,2,0]);
  assert.equal(ctx.store.pendingViewerTransfers(ctx.platform).length,2);
});

test('the operator can reconcile a reported fee and explicit exceptions from the command line', async t => {
  const ctx = await setup(t);
  const run = (...args) => execFileSync(process.execPath, ['scripts/tax-fees.js',args[0],ctx.platform,...args.slice(1)], {
    encoding:'utf8', env:{...process.env,STREAM_STATE_DIR:ctx.stateDir}, stdio:['ignore','pipe','pipe']
  });
  for (const id of ['reported','manual','free']) {
    ctx.store.reconcileViewerPayment(ctx.reserve(), {...ctx.verified,intentId:'pi_' + id,chargeId:'ch_' + id,
      chargeBalanceId:'txn_' + id,stripeFeeCents:57});
  }
  assert.match(run('pending'),/ch_reported/);
  const path = join(ctx.stateDir,'fees.csv');
  await writeFile(path,'incurred_by,product,feature_name,amount,currency,balance_transaction_id\nch_reported,Tax,Automatic tax,0.06,usd,txn_reportfee');
  assert.match(run('import',path),/recorded: 1/);
  assert.match(run('import',path),/recorded: 0/);
  assert.throws(() => run('confirm','ch_free','0','txn_unverified'));
  assert.throws(() => run('confirm','ch_manual','1.5','txn_invalid'));
  assert.match(run('confirm','ch_free','0','frr_complete'),/recorded: 1/);
  assert.match(run('confirm','ch_manual','7','txn_manualfee'),/recorded: 1/);
  assert.throws(() => run('confirm','ch_manual','8','txn_manualfee'));
  assert.doesNotMatch(run('pending'),/ch_reported|ch_free|ch_manual/);
  assert.deepEqual(ctx.store.pendingViewerTransfers(ctx.platform).map(o => o.taxBasicFeeCents).sort(),[0,6,7]);
});

test('New Mexico district export uses local calendar boundaries and separates manual from Stripe-calculated sales', async t => {
  const ctx = await setup(t), db = new DatabaseSync(join(ctx.stateDir,'filmmakers','setup.sqlite'));
  t.after(() => db.close());
  function buy(date, manual, adjusted = false) {
    const o = ctx.reserve({nmQuote:manual ? {code:'02-701',ratePartsPerMillion:76250} : null});
    db.prepare("UPDATE viewer_test_orders SET status='paid',paidAt=?,taxCents=83,tipTaxCents=7,refundedAmount=? WHERE orderId=?")
      .run(Date.parse(date)/1000, adjusted ? 100 : 0, o.orderId);
  }
  buy('2026-11-01T05:59:59Z',true);
  buy('2026-11-01T06:00:00Z',true);
  buy('2026-12-01T06:59:59Z',true,true);
  buy('2026-12-01T07:00:00Z',true);
  buy('2026-11-20T12:00:00Z',false);
  const rows = newMexicoReport(ctx.store,'2026-11').trim().split('\r\n');
  assert.equal(rows.length,2);
  assert.equal(rows[1],'2026-11,02-701,7.6250,2,20.00,1.86,21.86,1.52,0.14,1.66,1');
  assert.throws(() => newMexicoReport(ctx.store,'2026-13'));
});
