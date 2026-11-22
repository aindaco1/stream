import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {viewerWebhookEvents} from '../src/viewer-checkout.js';
import {checkLiveStripe,syncTaxFeeReports,reviewTaxFee} from '../src/stripe-live-operations.js';
import {createMaintenanceServer} from '../src/viewer-maintenance.js';

const env = {STRIPE_CONNECT_SECRET_KEY:'rk_live_fixture',STRIPE_CONNECT_PUBLISHABLE_KEY:'pk_live_fixture',
  STRIPE_CONNECT_WEBHOOK_SECRET:'whsec_connected',STRIPE_PLATFORM_WEBHOOK_SECRET:'whsec_platform',STREAM_PUBLIC_ORIGIN:'https://watch.example.com'};
const reportType = 'all_fees.incurred_at.itemized.2';

test('live readiness uses read-only Stripe endpoints and checks each configured destination and registration', async () => {
  const endpoints = ['/checkout/webhook','/checkout/platform-webhook'].map(path => ({url:env.STREAM_PUBLIC_ORIGIN + path,
    enabled_events:viewerWebhookEvents,livemode:true,status:'enabled'}));
  const list = data => ({object:'list',data,has_more:false});
  const records = new Map([
    ['/v1/account',{object:'account',id:'acct_films',charges_enabled:true,payouts_enabled:true}],
    ['/v1/tax/settings',{object:'tax.settings',livemode:true,status:'active'}],
    ['/v1/tax/registrations',list([{country:'US',country_options:{us:{state:'NM'}},livemode:true,status:'active'}])],
    ['/v1/webhook_endpoints',list(endpoints)],
    ['/v1/reporting/report_types/'+reportType,{object:'reporting.report_type',id:reportType,livemode:true}]
  ]);
  const read = async (url,init) => {
    assert.equal(init.method ?? 'GET','GET');
    assert.equal(init.redirect,'error');
    assert.equal(new URL(url).origin,'https://api.stripe.com');
    return Response.json(records.get(new URL(url).pathname));
  };
  const result = await checkLiveStripe(env,read);
  assert.ok(result.connectWebhookEnabled && result.platformWebhookEnabled && result.feesReportAvailable && result.distinctSigningSecretsPresent);
  assert.deepEqual(result.activeTaxLocations,['US-NM']);
  endpoints[1].enabled_events=['checkout.session.completed'];
  assert.equal((await checkLiveStripe(env,read)).platformWebhookEnabled,false);
});

test('maintenance imports a completed live fee report only for actual pending orders; missing rows remain pending', async () => {
  const start = 20000*86400;
  const end = start + 86400;
  const now = end*1000 + 10*86400000;
  const order = {orderId:'order',chargeId:'ch_sale',paidAt:start+321,platform:'acct_platform',taxBasicFeeCents:null};
  const applied = [];
  const store = {paymentMode:'live', pendingTaxFees:() => [order],viewerOrderByPlatformPayment:(platform,intent,charge) => charge===order.chargeId && platform===order.platform ? order : undefined,
    recordTaxFees(platform,fees) { assert.equal(platform,order.platform); applied.push(...fees); return fees.length; }};
  let income = 'ch_unrelated';
  const report = {id:'frr_report',object:'reporting.report_run',status:'succeeded',livemode:true,report_type:reportType,
    parameters:{interval_start:start,interval_end:end},result:{id:'file_data'}};
  const remote = async (url,init) => {
    const u = new URL(url);
    assert.equal(init.redirect,'error');
    if (u.pathname.includes('report_types')) return Response.json({id:reportType,livemode:true,data_available_start:start,data_available_end:end});
    if (u.pathname === '/v1/reporting/report_runs') {
      assert.equal(init.method,'POST');
      assert.ok(init.headers['Idempotency-Key']);
      assert.equal(init.body.get('parameters[interval_start]'),String(start));
      return Response.json({id:report.id});
    }
    if (u.pathname === '/v1/reporting/report_runs/frr_report') return Response.json(report);
    assert.equal(u.href,'https://files.stripe.com/v1/files/file_data/contents');
    return new Response('incurred_by,product,feature_name,amount,currency,balance_transaction_id\n'+income+',Tax,Automatic tax,0.03,usd,txn_actual');
  };
  const sync = () => syncTaxFeeReports(store,env.STRIPE_CONNECT_SECRET_KEY,order.platform,{fetchImpl:remote,now});
  assert.equal((await sync()).recorded,0);
  income=order.chargeId;
  assert.equal((await sync()).recorded,1);
  assert.deepEqual(applied,[{chargeId:'ch_sale',feeCents:3,reference:'txn_actual'}]);
  report.livemode=false;
  await assert.rejects(sync(),/different report/);
  assert.equal(applied.length,1);
});

test('the private cron endpoint accepts only its authenticated bodyless operation', async t => {
  let passes=0, success=true;
  const key='a'.repeat(48);
  const server = createMaintenanceServer(key,async () => { passes++; return success; });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const options = {method:'POST',headers:{Authorization:'Bearer ' + key}};
  for (const [path,args] of [['/reconcile',{}],['/reconcile',{method:'POST'}],['/other',options],['/reconcile',{...options,body:'x'}]]) {
    assert.equal((await fetch(base+path,args)).status,404);
  }
  assert.equal(passes,0);
  assert.equal((await fetch(base+'/reconcile', options)).status,204);
  success=false;
  assert.equal((await fetch(base+'/reconcile', options)).status,503);
  assert.equal(passes,2);
});

test('a manual zero fee requires a reviewed, sufficiently mature live report for the original paid charge', async () => {
  const now=Math.floor(Date.now()/1000), day=86400, paidAt=now-6*day;
  const order={platform:'acct_films',chargeId:'ch_film',paidAt,taxPolicy:'marketplace-v1',taxBasicFeeCents:null};
  const writes=[];
  const store={paymentMode:'live', viewerOrderByPlatformPayment:() => order,
    recordTaxFees(platform,rows,reviewer) { for (const row of rows) writes.push({platform,reviewer,...row}); return rows.length; }};
  const report={id:'frr_itemized',object:'reporting.report_run',report_type:reportType,status:'succeeded',livemode:true,
    created:now,parameters:{interval_start:paidAt-1,interval_end:paidAt+day,currency:'usd'},result:{id:'file_report'}};
  const fetchImpl = async url => new URL(url).hostname === 'files.stripe.com' ?
    new Response('incurred_by,product,feature_name,amount,currency,balance_transaction_id\n') : Response.json(report);
  const input={store,key:env.STRIPE_CONNECT_SECRET_KEY,platform:order.platform,chargeId:order.chargeId,reportId:report.id,reviewer:'Operator',fetchImpl};
  await assert.rejects(reviewTaxFee(input),/Confirm a zero/);
  for (const invalid of [{created:paidAt+3*day},{livemode:false},{report_type:'other'},{parameters:{interval_start:paidAt+1,interval_end:now}}]) {
    const saved={...report};Object.assign(report,invalid);
    await assert.rejects(reviewTaxFee({...input,confirmZero:true}));
    Object.assign(report,saved);
  }
  assert.equal(writes.length,0);
  await reviewTaxFee({...input,confirmZero:true});
  assert.deepEqual(writes,[{platform:order.platform,reviewer:'Operator',chargeId:order.chargeId,feeCents:0,reference:report.id}]);
});
