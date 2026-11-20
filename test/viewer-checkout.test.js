import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@dustwave/worker-core/crypto';
import { createRentalAuthority, rentalScope, savedFilmScope } from '../src/rental.js';
import { revisionFor } from '../src/media.js';
import { createPublicFilms } from '../src/public-films.js';
import { openSetupStore } from '../src/setup-store.js';
import { createViewerCheckout } from '../src/viewer-checkout.js';
import { makeServer } from '../src/server.js';

const origin = 'http://127.0.0.1:8787';
const secret = 'whsec_fixture';
const viewerToken = () => randomBytes(32).toString('base64url');
const sourceHead = {revision:'"test-cut-one"', size:4};

async function context(t, { legacy = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'stream-viewer-test-'));
  const owner = 'Buyer rehearsal filmmaker', account = 'acct_seller';
  const id = 'f-' + randomUUID();
  const offer = { id, owner, account, title: 'A short film', scope: savedFilmScope(owner,id),
    prices: {rent:99,buy:499}, revision: revisionFor(sourceHead), authority: createRentalAuthority(randomBytes(32)) };
  const token = viewerToken();
  const orderId = randomUUID();
  if (legacy) {
    const db = new DatabaseSync(join(folder, 'setup.sqlite'));
    db.exec(`CREATE TABLE viewer_test_orders (
      tokenHash TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE, filmId TEXT NOT NULL,
      owner TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL, revision TEXT NOT NULL,
      platform TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL, createdAt INTEGER NOT NULL,
      sessionId TEXT UNIQUE, intentId TEXT UNIQUE, paidAt INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      checkedAt INTEGER, webhookEventId TEXT, webhookAt INTEGER)`);
    db.prepare('INSERT INTO viewer_test_orders(tokenHash,orderId,filmId,owner,account,scope,revision,platform,title,origin,createdAt,sessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(await sha256Hex(token),orderId,offer.id,owner,account,offer.scope,offer.revision,'acct_platform',offer.title,origin,Date.now(),'cs_test_legacy');
    db.close();
  }
  const store = openSetupStore(folder);
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }); });
  store.invite(owner);
  store.claimAccount(owner, account, 'test');
  store.saveStripe(owner, { byMode: { test: { mode: 'test', creatorId: owner, channel: 'oauth', accountId: account,
    status:'ready',chargesEnabled:true,payoutsEnabled:true } } });
  const bucket = { accountId: 'fixture', bucket: 'synthetic', jurisdiction: 'default' };
  store.saveBucket(owner, { ...bucket, accessKeyId: 'fixture', secretAccessKey: 'fixture' });
  store.saveFilm(owner, bucket, { id: offer.id, title: offer.title, revision: offer.revision, prices: offer.prices,
    duration:136, objectKey:'film.mp4', rights:{version:'v1', statement:'I have the rights', acceptedAt:new Date().toISOString()} });
  const calls = [], sessions = new Map(), intents = new Map(), requests = new Map();
  const refunds = [], disputes = [];
  const behavior = { available: true, platform: 'acct_platform', sellers:new Set([account]), origin, lose: false, missingSecret: false };
  const purchased = Math.floor(Date.now() / 1000) - 300;
  function addSession(suffix, amount, markers, uiMode, allowedMethods = null) {
    const id = 'cs_test_' + suffix, pi = 'pi_' + suffix;
    sessions.set(id, { id, object:'checkout.session', status:'open', payment_status:'unpaid', payment_intent:pi,
      livemode:false, mode:'payment', currency:'usd', amount_total:amount, amount_subtotal:amount,
      metadata:markers, client_reference_id:markers.order, ui_mode:uiMode,
      allowed_payment_method_types:allowedMethods,
      client_secret:uiMode !== 'hosted' && !behavior.missingSecret ? id+'_secret_rehearsal' : null });
    intents.set(pi, {id:pi, object:'payment_intent', livemode:false, status:'succeeded', amount, amount_received:amount, currency:'usd', metadata:{...markers},
      latest_charge:{id:'ch_' + suffix,object:'charge',livemode:false,status:'succeeded',paid:true,captured:true,refunded:false,disputed:false,
        amount, amount_captured:amount,amount_refunded:0,currency:'usd',created:purchased,payment_intent:pi,payment_method_details:{type:'card'}}});
    return id;
  }
  if (legacy) addSession('legacy',99,{order:orderId,flow:'stream-viewer-rental',product:'stream-rental-prototype',
    scope:rentalScope({film:offer.scope,revision:offer.revision})}, 'hosted');
  async function fetchImpl(href, init) {
    const url = new URL(href), method = init.method, headers = new Headers(init.headers);
    const recipient = headers.get('Stripe-Account');
    const form = init.body && new URLSearchParams(init.body);
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(init.redirect, 'error');
    calls.push({ method, path: url.pathname, recipient });
    if (url.pathname === '/v1/account') return Response.json({ id: behavior.platform, object: 'account' });
    const seller = url.pathname.startsWith('/v1/accounts/') && url.pathname.split('/').at(-1);
    if (behavior.sellers.has(seller)) return Response.json({ id: seller, object: 'account', type: 'standard',
      charges_enabled: behavior.available, payouts_enabled: behavior.available });
    assert.ok(behavior.sellers.has(recipient));
    if (method === 'POST' && url.pathname.endsWith('/expire')) {
      const session = sessions.get(url.pathname.split('/').at(-2));
      assert.ok(session);
      if (behavior.completeDuringExpire === session.id) {
        Object.assign(session,{status:'complete',payment_status:'paid'});
        return Response.json({error:{message:'Session already completed.'}},{status:400});
      }
      if (behavior.expireUnavailable) return Response.json({error:{message:'Try again.'}},{status:503});
      assert.equal(session.status,'open');
      session.status='expired';
      session.client_secret=null;
      return Response.json(session);
    }
    if (url.pathname === '/v1/refunds' || url.pathname === '/v1/disputes') {
      assert.equal(method,'GET');
      const rows = url.pathname === '/v1/refunds' ? refunds : disputes;
      const response = Response.json({object:'list',has_more:false,data:rows.filter(row=>row.charge===url.searchParams.get('charge'))});
      if (behavior.delayRead) {
        const delay = behavior.delayRead;
        delete behavior.delayRead;
        await delay();
      }
      return response;
    }
    if (method === 'POST') {
      assert.equal(url.pathname, '/v1/checkout/sessions');
      const filmAmount = Number(form.get('line_items[0][price_data][unit_amount]'));
      const tipAmount = Number(form.get('line_items[1][price_data][unit_amount]'));
      const amount = filmAmount + tipAmount;
      assert.equal(form.get('payment_intent_data[application_fee_amount]'), tipAmount ? String(tipAmount) : null);
      if (tipAmount) assert.equal(form.get('line_items[1][price_data][product_data][name]'),'Optional tip to Dust Wave');
      assert.equal(headers.get('Stripe-Version'), '2026-10-28.endive');
      const uiMode = form.get('ui_mode');
      if (uiMode === 'embedded_page') {
        assert.equal(form.get('redirect_on_completion'), 'never');
        assert.equal(form.has('return_url'),false);
      } else {
        assert.equal(uiMode,'elements');
        assert.equal(form.has('redirect_on_completion'),false);
        assert.equal(form.get('return_url'),behavior.origin + '/embed/' + offer.id + '?order=' + form.get('client_reference_id'));
      }
      assert.equal(form.has('payment_method_types[0]'),false);
      const methods = [...form].filter(([name]) => name.startsWith('allowed_payment_method_types')).map(([,value])=>value);
      calls.at(-1).allowedMethods = methods;
      for (const k of ['success_url','cancel_url','payment_intent_data[transfer_data][destination]']) assert.equal(form.has(k),false);
      const key = headers.get('Idempotency-Key');
      assert.ok(key);
      let id = requests.get(key);
      if (!id) {
        const suffix = randomBytes(8).toString('hex');
        const order = form.get('client_reference_id');
        const markers = Object.fromEntries(['order','flow','product','scope','kind','amount'].map(k => [k,form.get('metadata[' + k + ']')]));
        for (const k of ['film_amount','tip_amount','tip_percent']) if (tipAmount) markers[k] = form.get('metadata['+k+']');
        assert.equal(markers.order,order);
        assert.equal(markers.amount,String(amount));
        for (const [k,v] of Object.entries(markers)) assert.equal(v,form.get('payment_intent_data[metadata][' + k + ']'));
        id = addSession(suffix, amount, markers, uiMode, methods.length ? methods : null);
        if (tipAmount) {
          const intent = intents.get(sessions.get(id).payment_intent);
          intent.application_fee_amount = tipAmount;
          intent.latest_charge.application_fee_amount = tipAmount;
          intent.latest_charge.application_fee = 'fee_' + suffix;
        }
        requests.set(key, id);
      }
      if (behavior.lose) { behavior.lose=false; throw new Error('Interrupted after creating session'); }
      if (behavior.holdCreateResponse) await behavior.holdCreateResponse();
      return Response.json(sessions.get(id));
    }
    const id = url.pathname.split('/').at(-1);
    if (sessions.has(id)) return Response.json(sessions.get(id));
    assert.ok(['latest_charge','latest_charge.balance_transaction'].includes(url.searchParams.get('expand[0]')));
    return Response.json(intents.get(id));
  }
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture', STRIPE_CONNECT_PUBLISHABLE_KEY:'pk_test_fixture', STRIPE_CONNECT_WEBHOOK_SECRET: secret };
  const checkout = createViewerCheckout({ store, env, fetchImpl });
  const first = () => sessions.values().next().value;
  const sign = (event, time = Math.floor(Date.now()/1000)) => {
    const payload = JSON.stringify(event);
    const digest = createHmac('sha256',secret).update(time + '.' + payload).digest('hex');
    return [Buffer.from(payload), 't=' + time + ',v1=' + digest];
  };
  const event = () => ({object:'event',id:'evt_fixture',type:'checkout.session.completed',account,livemode:false,data:{object:first()}});
  const pay = () => { Object.assign(first(), { status:'complete', payment_status:'paid' }); };
  return { folder, store, env, fetchImpl, offer, token, checkout, calls, first, sessions, intents, refunds, disputes, behavior, purchased, sign, event, pay,
    start: (kind = 'rent') => checkout.start({ offer,token,origin,kind }), status: () => checkout.status({offer,token}) };
}

async function priorOrder(c,kind,uiMode = 'elements') {
  const order = c.store.reserveViewerOrder({ ...c.offer, tokenHash:await sha256Hex(c.token),
    platform:'acct_platform', origin, kind, amount:c.offer.prices[kind] });
  const db = new DatabaseSync(join(c.folder,'setup.sqlite'));
  db.prepare('UPDATE viewer_test_orders SET uiMode=?, cardOnly=0 WHERE orderId=?').run(uiMode,order.orderId);
  db.close();
  return order;
}

test('a voluntary tip travels as a direct application fee and reconciles independently of the film price', async t => {
  for (const kind of ['rent','buy']) {
    const c=await context(t), connection={offer:c.offer,token:c.token,origin,kind,tipPercent:10};
    const [opened,retried] = await Promise.all([c.checkout.start(connection),c.checkout.start(connection)]);
    assert.deepEqual(opened,retried);
    const subtotal=c.offer.prices[kind], tip=kind==='rent'?10:50, total=subtotal+tip;
    assert.deepEqual([opened.filmAmount,opened.tipAmount,opened.amount,opened.tipPercent],[subtotal,tip,total,10]);
    assert.equal(c.sessions.size,1);
    assert.equal(c.calls.find(row=>row.method==='POST').recipient,c.offer.account);
    await assert.rejects(c.checkout.start({...connection,tipPercent:5}),{statusCode:409});
    c.pay();
    const intent=c.intents.get(c.first().payment_intent), charge=intent.latest_charge;
    intent.application_fee_amount=tip-1;
    await assert.rejects(c.status(),{statusCode:409});
    intent.application_fee_amount=tip;
    charge.application_fee_amount=0;
    await assert.rejects(c.checkout.webhook(...c.sign(c.event())),{statusCode:409});
    charge.application_fee_amount=tip;
    // The buyer can watch before the asynchronous balance transaction is ready.
    await c.checkout.webhook(...c.sign(c.event()));
    const paid=await c.status();
    assert.equal(paid.status,'paid');
    assert.equal(paid.kind,kind);
    assert.ok((await c.offer.authority.exchange(paid.receipt,{film:c.offer.scope,revision:c.offer.revision})).grant);
    assert.equal(c.store.viewerOrderById(opened.orderId).stripeFeeCents,null);
    charge.balance_transaction={id:'txn_fixture',object:'balance_transaction',type:'charge',status:'pending',
      source:charge.id,amount:total,fee:tip+33,net:subtotal-33,currency:'usd',fee_details:[
        {type:'application_fee',application:'ca_platform',amount:tip,currency:'usd'}, {type:'stripe_fee',amount:33,currency:'usd'}]};
    await c.status();
    const recorded=c.store.viewerOrderById(opened.orderId);
    assert.deepEqual([recorded.amount,recorded.tipAmount,recorded.stripeFeeCents],[subtotal,tip,33]);
    charge.balance_transaction=null;
    await c.status();
    assert.equal(c.store.viewerOrderById(opened.orderId).stripeFeeCents,33);
    // A full refund is measured against the amount the viewer actually paid.
    const refund={object:'refund',id:'re_filmonly',charge:charge.id,payment_intent:intent.id,amount:subtotal,currency:'usd',status:'succeeded'};
    c.refunds.push(refund);
    charge.amount_refunded=subtotal;
    assert.equal((await c.status()).status,'paid');
    c.refunds.push({...refund,id:'re_tiptoo',amount:tip});
    Object.assign(charge,{amount_refunded:total,refunded:true});
    assert.equal((await c.status()).status,'revoked');
  }
});

test('editing a tip closes the old form and preserves an order that settles during the change', async t => {
  const c=await context(t);
  const first={offer:c.offer,token:c.token,origin,kind:'rent',tipPercent:5};
  const opened=await c.checkout.start(first);
  assert.deepEqual(await c.checkout.abandon(first),{status:'expired'});
  await assert.rejects(c.checkout.start(first),{statusCode:410});
  const second={...first,token:viewerToken(),tipPercent:0};
  const next=await c.checkout.start(second);
  assert.equal(next.amount,99);
  assert.notEqual(opened.orderId,next.orderId);
  c.behavior.completeDuringExpire=c.store.viewerOrderById(next.orderId).sessionId;
  assert.deepEqual(await c.checkout.abandon(second),{status:'paid'});
  assert.equal(c.store.viewerOrderById(next.orderId).status,'paid');
  for (const percent of [-1,16,2.5,'1']) {
    await assert.rejects(c.checkout.start({...first,token:viewerToken(),tipPercent:percent}),{statusCode:400});
  }
});

test('switching the connected seller preserves original purchases, recovery and receipts and routes only new sales to the replacement', async t => {
  const c = await context(t);
  const {owner, account} = c.offer;
  const existing = {...c.offer, account:null};
  const bought = await c.start('buy');
  c.pay();
  c.first().customer_details = {email:'viewer@example.test'};
  assert.equal((await c.status()).status,'paid');
  const openToken = viewerToken();
  const unfinished = await c.checkout.start({offer:c.offer,token:openToken,origin});
  const results = c.store.dashboardFilms(owner)[0].stats;
  assert.equal(results.purchases,1);
  const live = c.store.stripeContext(owner,'live');
  assert.equal(c.store.resetStripe(owner,'live',live.confirmation), true);
  assert.equal(c.store.viewerOrderById(unfinished.orderId).withdrawalState,null);
  const testMode = c.store.stripeContext(owner,'test');
  assert.equal(c.store.resetStripe(owner,'test',testMode.confirmation),true);
  await assert.rejects(c.checkout.start({offer:c.offer,token:viewerToken(),origin}),{statusCode:409});
  await assert.rejects(c.checkout.start({offer:existing,token:viewerToken(),origin}),{statusCode:409});
  assert.equal(c.store.pendingWithdrawals(owner),1);
  assert.equal(await c.checkout.closeWithdrawnSessions(owner),0);
  assert.equal(c.store.viewerOrderById(unfinished.orderId).status,'expired');
  assert.equal(c.store.viewerOrderById(bought.orderId).withdrawalState,null);
  assert.deepEqual(c.store.dashboardFilms(owner)[0].stats,results);
  assert.equal(c.checkout.accessAllowed({offer:existing,orderId:bought.orderId,kind:'buy'}),true);
  assert.equal((await c.checkout.status({offer:existing,token:c.token})).status,'paid');
  const {code} = c.store.reserveRecovery(existing,'viewer@example.test');

  const replacement = 'acct_replacement';
  const next = c.store.stripeContext(owner,'test');
  assert.ok(next.claimAccount(replacement,'test'));
  Object.assign(next.state,{creatorId:owner,accountId:replacement,channel:'oauth',status:'ready',chargesEnabled:true,payoutsEnabled:true});
  next.save();
  c.behavior.sellers.add(replacement);
  const newOffer = {...c.offer, account:replacement};
  const recovered = c.store.redeemRecovery(existing,code);
  const reads = c.calls.length;
  assert.equal((await c.checkout.status({offer:existing,token:recovered})).kind,'buy');
  assert.equal(await c.checkout.verifyPurchase({offer:existing,orderId:bought.orderId}),true);
  assert.ok(c.calls.slice(reads).every(call=>call.recipient===account));
  assert.equal(await c.checkout.verifyPurchase({offer:{...existing,owner:'Someone else'},orderId:bought.orderId}),false);
  assert.equal(await c.checkout.verifyPurchase({offer:{...existing,revision:'replacement cut'},orderId:bought.orderId}),false);
  await assert.rejects(c.checkout.start({offer:newOffer,token:openToken,origin}),{statusCode:410});
  const reopened = await c.checkout.start({offer:newOffer,token:viewerToken(),origin});
  assert.equal(reopened.account,replacement);
  assert.equal(c.store.viewerOrderById(reopened.orderId).account,replacement);
  assert.deepEqual(c.calls.filter(call=>call.method==='POST' && call.path==='/v1/checkout/sessions').map(call=>call.recipient),
    [account,account,replacement]);
  const charge = c.intents.get(c.first().payment_intent).latest_charge;
  c.refunds.push({object:'refund',id:'re_return',charge:charge.id,payment_intent:charge.payment_intent,
    currency:'usd',amount:bought.amount,status:'succeeded'});
  Object.assign(charge,{refunded:true,amount_refunded:bought.amount});
  await c.checkout.webhook(...c.sign({...c.event(),id:'evt_return',type:'charge.refunded',data:{object:charge}}));
  assert.equal(c.checkout.accessAllowed({offer:existing,orderId:bought.orderId,kind:'buy'}),false);
  assert.equal(c.store.viewerOrderById(bought.orderId).refundedAmount,bought.amount);
  assert.equal(c.store.viewerOrderById(reopened.orderId).withdrawalState,null);
});

test('a pre-existing rental retains its original expiry and historical receipt through connection reset',async t=>{
  const c = await context(t,{legacy:true});
  c.pay();
  const paid = await c.status();
  const {owner} = c.offer, existing = {...c.offer,account:null};
  const previous = c.store.stripeContext(owner,'test');
  assert.ok(c.store.resetStripe(owner,'test',previous.confirmation));
  const checked = await c.checkout.status({offer:existing,token:c.token});
  assert.equal(checked.expiresAt,paid.expiresAt);
  const grant = {offer:existing,kind:'rent',rentalExpiresAt:paid.expiresAt};
  assert.ok(c.checkout.accessAllowed(grant));
  assert.ok(await c.checkout.verifyPlayback(grant));
  assert.equal(c.checkout.accessAllowed({...grant,offer:{...existing,scope:'another-film'}}),false);
});

test('normal HTTP checkout, order, renewal, media and original routes keep the paid film isolated across reset', async t => {
  const c = await context(t);
  const {id,owner} = c.offer;
  const saved = c.store.film(owner,id);
  const otherId = 'f-' + randomUUID();
  c.store.saveFilm(owner, saved.bucket, {...saved,id:otherId,title:'Other film'});
  for (const filmId of [id,otherId]) c.store.setFilmPublication(owner,filmId,true);
  const catalog = createPublicFilms({store:c.store,env:c.env,authority:c.offer.authority,
    sourceFor:()=>({head:async()=>sourceHead,read:async()=>Buffer.from('film')}),
    openMedia:async()=>({revision:c.offer.revision,segments:[{duration:1}],segment:async()=>Buffer.from('film'),close(){}})});
  const server = await makeServer(null,{checkout:c.checkout,catalog});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  c.behavior.origin = base;
  const post=(action,body,filmId=id)=>fetch(base+'/film/'+filmId+'/'+action,{method:'POST',headers:{Origin:base,'Content-Type':'text/plain'},body});
  const open = await post('buy',c.token+' 10');
  assert.equal(open.status,200);
  const tipped = await open.json();
  assert.deepEqual([tipped.account,tipped.tipAmount,tipped.amount],[c.offer.account,50,549]);
  c.pay();
  const receipt = (await (await post('order',c.token)).json()).receipt;
  const grant = (await (await post('session',receipt)).json()).grant;
  const authenticated = {headers:{Authorization:'Bearer '+grant}};
  async function access() {
    const confirmed = await post('order',c.token);
    assert.equal(confirmed.status,200);
    assert.equal((await confirmed.json()).kind,'buy');
    assert.equal((await post('session',receipt)).status,200);
    for (const path of ['play/index.m3u8','play/key','play/0.ts','download']) {
      const response = await fetch(base+'/film/'+id+'/'+path,authenticated);
      assert.equal(response.status,200,path);
      const body = Buffer.from(await response.arrayBuffer());
      assert.ok(body.length);
      if (path==='download') assert.equal(body.toString(),'film');
    }
  }
  const old = c.store.stripeContext(owner,'test');
  assert.ok(c.store.resetStripe(owner,'test',old.confirmation));
  assert.equal((await post('checkout',viewerToken())).status,404);
  await access();
  const next = c.store.stripeContext(owner,'test');
  next.claimAccount('acct_next','test');
  Object.assign(next.state,old.state,{accountId:'acct_next'});
  next.save();
  c.behavior.sellers.add('acct_next');
  const replacement = await post('buy',viewerToken());
  assert.equal(replacement.status,200);
  assert.equal((await replacement.json()).account,'acct_next');
  const unfinished = viewerToken();
  assert.equal((await post('checkout',unfinished+' 15')).status,200);
  assert.deepEqual(await (await post('abandon',unfinished)).json(),{status:'expired'});
  assert.equal((await post('checkout',unfinished+' 15')).status,410);
  await access();
  assert.equal((await post('session',receipt,otherId)).status,403);
  assert.equal((await fetch(base+'/film/'+otherId+'/play/key',authenticated)).status,403);
  assert.equal((await fetch(base+'/film/'+otherId+'/download',authenticated)).status,403);
});

test('a reload or concurrent click reuses Checkout Elements, polling and verified Connect webhook fulfill once', async t => {
  const c=await context(t);
  assert.deepEqual(await c.status(),{ status:'pending' });
  assert.equal(c.calls.length,0);
  const [a,b]=await Promise.all([c.start(),c.start()]);
  assert.deepEqual(a,b);
  assert.deepEqual(a,{clientSecret:c.first().client_secret,publishableKey:'pk_test_fixture',account:c.offer.account,
    uiMode:'elements',orderId:c.first().client_reference_id,title:c.offer.title,kind:'rent',amount:99,
    filmAmount:99,tipPercent:0,tipAmount:0,currency:'usd',rentalHours:48});
  assert.equal(c.calls.filter(x=>x.method==='POST').length,1);
  assert.deepEqual(c.calls.find(x=>x.method==='POST').allowedMethods,['card']);
  const order=c.store.viewerOrderBySession(c.first().id);
  assert.equal(order.tokenHash,await sha256Hex(c.token));
  assert.ok(!JSON.stringify(order).includes(c.token));
  assert.ok(!JSON.stringify(order).includes(a.clientSecret));
  const polls=c.calls.length;
  await c.status(); await c.status();
  assert.equal(c.calls.length-polls,1);
  c.pay();
  const delivery=c.sign(c.event());
  await Promise.all([c.checkout.webhook(...delivery),c.checkout.webhook(...delivery)]);
  const [one,two]=await Promise.all([c.status(),c.status()]);
  assert.equal(one.status,'paid');
  assert.equal(one.kind,'rent');
  assert.equal(one.receipt,two.receipt);
  const restored = createViewerCheckout({store:c.store,env:c.env,fetchImpl:c.fetchImpl});
  assert.deepEqual(await restored.status({offer:c.offer,token:c.token}),one);
  const grant=await c.offer.authority.exchange(one.receipt,{film:c.offer.scope,revision:c.offer.revision});
  assert.equal(grant.rentalExpiresAt,c.purchased + 48*3600);
  const row=c.store.viewerOrderBySession(c.first().id);
  assert.equal(row.paidAt,c.purchased);
  assert.equal(row.status,'paid');
  assert.equal(row.webhookEventId,'evt_fixture');
  assert.ok(row.webhookAt);
  assert.deepEqual(await c.start(),{status:'paid'});
  assert.equal(await c.checkout.verifyPurchase({offer:c.offer, orderId:row.orderId}),false);
  assert.ok(c.calls.filter(x=>x.path.includes('checkout')||x.path.includes('payment_intents')).every(x=>x.recipient===c.offer.account));
});

test('invalid or unrelated webhook cannot mark an order paid, and paid status can fulfill independently',async t=>{
  const c=await context(t);await c.start();c.pay();
  const event=c.event();
  await assert.rejects(c.checkout.webhook(Buffer.from('{}'),'v1=invalid'),{statusCode:400});
  await assert.rejects(c.checkout.webhook(...c.sign(event,1)),{statusCode:400});
  await c.checkout.webhook(...c.sign({...event,account:'acct_other'}));
  await c.checkout.webhook(...c.sign({...event,livemode:true}));
  assert.equal(c.store.viewerOrderBySession(c.first().id).status,'pending');
  assert.deepEqual(await c.checkout.status({offer:{...c.offer,id:'other'},token:c.token}),{status:'pending'});
  await assert.rejects(c.checkout.start({offer:{...c.offer,scope:'different'},token:c.token,origin}),{statusCode:409});
  assert.equal((await c.status()).status,'paid');
  assert.equal(c.store.viewerOrderBySession(c.first().id).webhookEventId,null);
  const charge=c.intents.get(c.first().payment_intent).latest_charge;
  charge.amount_refunded=99;
  c.refunds.push({id:'re_full',object:'refund',charge:charge.id,payment_intent:charge.payment_intent,amount:99,currency:'usd',status:'succeeded'});
  assert.deepEqual(await c.status(),{status:'revoked'});
  await c.checkout.webhook(...c.sign(event));
  assert.equal(c.store.viewerOrderBySession(c.first().id).status,'expired');
  await assert.rejects(c.start(),{statusCode:410});
});

test('Stripe session and expanded charge must agree with the immutable saved rental',async t=>{
  const c=await context(t);await c.start();c.pay();
  const session=c.first(), intent=c.intents.get(session.payment_intent);
  const send=()=>c.checkout.webhook(...c.sign(c.event()));
  for(const [target,key,wrong] of [[session,'amount_total',100],[session,'currency','eur'],[session,'client_reference_id','wrong'],
    [intent.metadata,'scope','wrong'],[intent,'transfer_data',{destination:'acct_other'}],[intent.latest_charge,'amount_captured',98],
    [intent.latest_charge,'payment_intent','pi_other'],[intent,'application_fee_amount',15],[intent.latest_charge,'livemode',true]]) {
    const previous=target[key];target[key]=wrong;
    await assert.rejects(send(),{statusCode:409});
    assert.equal(c.store.viewerOrderBySession(session.id).status,'pending');
    target[key]=previous;
  }
  intent.latest_charge.created=Math.floor(Date.now()/1000)-49*3600;
  await send();
  assert.equal(c.store.viewerOrderBySession(session.id).status,'expired');
});

test('sandbox keys, distinct ready recipient, viewer token and a Stripe-provided client secret are mandatory',async t=>{
  const c=await context(t);
  for(const overrides of [{STRIPE_CONNECT_SECRET_KEY:'sk_live_fixture'},{STRIPE_CONNECT_PUBLISHABLE_KEY:'pk_live_fixture'},
      {STRIPE_CONNECT_PUBLISHABLE_KEY:'sk_test_neverSend'},{STRIPE_CONNECT_PUBLISHABLE_KEY:''}]) {
    const bad=createViewerCheckout({store:c.store,env:{...c.env,...overrides},fetchImpl:c.fetchImpl});
    await assert.rejects(bad.start({offer:c.offer,token:c.token,origin}),{statusCode:503});
  }
  await assert.rejects(c.checkout.start({offer:c.offer,token:'bad',origin}),{statusCode:400});
  assert.equal(c.calls.length,0);
  c.behavior.platform=c.offer.account;
  await assert.rejects(c.start(),{statusCode:409});
  c.behavior.platform='acct_platform';
  const next=createViewerCheckout({store:c.store,env:c.env,fetchImpl:c.fetchImpl});
  c.behavior.available=false;
  await assert.rejects(next.start({offer:c.offer,token:c.token,origin}));
  assert.equal(c.sessions.size,0);
  c.behavior.available=true;c.behavior.missingSecret=true;
  await assert.rejects(next.start({offer:c.offer,token:c.token,origin}),{statusCode:409});
});

test('lost creates reuse Stripe idempotency and quota excludes repeat buyers with existing tokens',async t=>{
  const c=await context(t);
  c.behavior.lose=true;
  await assert.rejects(c.start(),{statusCode:503});
  assert.equal(c.sessions.size,1);
  const firstSecret=(await c.start()).clientSecret;
  assert.equal(c.sessions.size,1);
  for(let n=1;n<30;n++)await c.checkout.start({offer:c.offer,token:viewerToken(),origin});
  const calls=c.calls.length;
  await assert.rejects(c.checkout.start({offer:c.offer,token:viewerToken(),origin}),{statusCode:429});
  assert.equal(c.calls.length,calls);
  assert.equal((await c.start()).clientSecret,firstSecret);
  c.first().status='expired';
  assert.deepEqual(await c.status(),{status:'expired'});
});

test('an interrupted, unbound order can be replaced once the Stripe retry window ends', async t => {
  const c = await context(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  c.behavior.lose = true;
  await assert.rejects(c.start(), { statusCode: 503 });
  t.mock.timers.tick(24 * 3600_000);
  assert.deepEqual(await c.status(), { status: 'expired' });
  await assert.rejects(c.start(), { statusCode: 410 });
  assert.equal(c.sessions.size, 1);
});

test('a purchase survives 48 hours and a service restart, while each new download checks the paid order', async t => {
  const c = await context(t);
  await c.start('buy');
  const row = c.store.viewerOrderBySession(c.first().id);
  const request = { offer:c.offer, orderId:row.orderId };
  assert.equal(row.kind, 'buy');
  assert.equal(row.amount, 499);
  assert.equal(await c.checkout.verifyPurchase(request), false);
  await assert.rejects(c.start('rent'), {statusCode:409});
  c.pay();
  const intent = c.intents.get(c.first().payment_intent);
  intent.latest_charge.created -= 60 * 86400;
  await c.checkout.webhook(...c.sign(c.event()));
  const reopened = openSetupStore(c.folder);
  t.after(() => reopened.close());
  const restored = createViewerCheckout({store:reopened,env:c.env,fetchImpl:c.fetchImpl});
  const paid = await restored.status({offer:c.offer,token:c.token});
  assert.equal(paid.kind, 'buy');
  assert.ok(paid.receipt);
  assert.deepEqual(await c.start('buy'), {status:'paid'});
  assert.equal(await restored.verifyPurchase(request), true);
  for (const changed of [{id:'other'}, {owner:'Another filmmaker'}, {scope:'another/scope'}, {revision:'new'}, {account:'acct_other'}]) {
    assert.equal(await restored.verifyPurchase({...request,offer:{...c.offer,...changed}}), false);
  }
  assert.equal(await restored.verifyPurchase({...request,orderId:randomUUID()}), false);
  intent.latest_charge.refunded = true;
  intent.latest_charge.amount_refunded = row.amount;
  c.refunds.push({id:'re_full',object:'refund',charge:intent.latest_charge.id,amount:row.amount,currency:'usd',status:'succeeded'});
  assert.equal(await restored.verifyPurchase(request), false);
  assert.deepEqual(await c.status(), {status:'revoked'});
  assert.equal(reopened.viewerOrderById(row.orderId).status, 'expired');
});

test('the saved order retains its original price and kind when a filmmaker changes or pauses sales', async t => {
  const c = await context(t);
  c.offer.prices = {rent:149,buy:575};
  c.store.setFilmPrices(c.offer.owner, c.offer.id, c.offer.prices);
  await c.start();
  assert.equal(c.first().amount_total, 149);
  const before = c.store.film(c.offer.owner,c.offer.id);
  const updated = {rent:null,buy:800};
  assert.equal(c.store.setFilmPrices('Other filmmaker', c.offer.id, updated),false);
  assert.equal(c.store.setFilmPrices(c.offer.owner, c.offer.id, updated),true);
  assert.deepEqual(c.store.film(c.offer.owner,c.offer.id),{...before,prices:updated});
  assert.deepEqual(c.store.films(c.offer.owner)[0].prices,updated);
  // A stale offer cannot create an order at a different price than the database.
  const freshStart = kind => c.checkout.start({offer:c.offer,token:viewerToken(),origin,kind});
  await assert.rejects(freshStart('buy'), {statusCode:409});
  c.offer.prices = updated;
  await assert.rejects(freshStart('rent'), {statusCode:409});
  await assert.rejects(freshStart('unknown'), {statusCode:400});
  const previous = await c.start();
  assert.equal(previous.clientSecret,c.first().client_secret);
  assert.equal(previous.amount,149);
  assert.equal(previous.kind,'rent');
  await freshStart('buy');
  assert.deepEqual([...c.sessions.values()].map(row=>row.amount_total),[149,800]);
  c.pay();
  assert.equal((await c.status()).kind,'rent');
});

test('buy metadata and local settlement stay bound to the same order, amount and payment', async t => {
  const c = await context(t);
  await c.start('buy');
  c.pay();
  const session = c.first(), intent = c.intents.get(session.payment_intent);
  for (const [target,key,wrong] of [[session.metadata,'kind','rent'],[intent.metadata,'amount','99'],
    [intent.metadata,'order',randomUUID()],[intent,'amount_received',99],[intent.latest_charge,'amount',99]]) {
    const expected=target[key];
    target[key]=wrong;
    await assert.rejects(c.checkout.webhook(...c.sign(c.event())),{statusCode:409});
    assert.equal(c.store.viewerOrderBySession(session.id).status,'pending');
    target[key]=expected;
  }
});

test('a delayed payment stays locked during processing and a verified failure allows a new checkout', async t => {
  const c = await context(t);
  await priorOrder(c,'buy');
  await c.start('buy');
  const session = c.first(), intent = c.intents.get(session.payment_intent);
  session.status = 'complete';
  intent.status = 'processing';
  intent.amount_received = 0;
  intent.latest_charge = null;
  const failed = { ...c.event(), type:'checkout.session.async_payment_failed' };
  await c.checkout.webhook(...c.sign(failed));
  assert.deepEqual(await c.status(), {status:'pending'});
  intent.status = 'requires_payment_method';
  await c.checkout.webhook(...c.sign(failed));
  assert.deepEqual(await c.status(), {status:'expired'});
  const next = await c.checkout.start({offer:c.offer,token:viewerToken(),origin,kind:'buy'});
  assert.ok(next.clientSecret);
  assert.equal(c.sessions.size,2);
});

test('a rental settled after three days receives 48 hours from its signed payment event, including after replay and restart', async t => {
  t.mock.timers.enable({ apis:['Date'], now:Date.now() });
  const c = await context(t);
  await priorOrder(c,'rent');
  await c.start();
  const session = c.first(), intent = c.intents.get(session.payment_intent);
  intent.latest_charge.payment_method_details = {type:'us_bank_account'};
  intent.latest_charge.balance_transaction = {id:'txn_bank',object:'balance_transaction',type:'payment',source:intent.latest_charge.id,
    amount:99,fee:1,net:98,status:'pending',currency:'usd',fee_details:[{type:'stripe_fee',amount:1,currency:'usd'}]};
  session.status = 'complete';
  intent.status = 'processing';
  const began = Math.floor(Date.now()/1000);
  const pending = { ...c.event(), created:began };
  await c.checkout.webhook(...c.sign(pending));
  assert.deepEqual(await c.status(),{status:'pending'});
  t.mock.timers.tick(72 * 3600_000);
  c.pay();
  intent.status = 'succeeded';
  const paidAt = Math.floor(Date.now()/1000) - 120;
  const success = { ...c.event(), id:'evt_settled', type:'checkout.session.async_payment_succeeded', created:paidAt };
  await c.checkout.webhook(...c.sign(success));
  assert.equal(c.store.viewerOrderBySession(session.id).paidAt,paidAt);
  assert.equal(c.store.viewerOrderBySession(session.id).stripeFeeCents,1);
  const restoredStore = openSetupStore(c.folder);
  t.after(() => restoredStore.close());
  const restored = createViewerCheckout({store:restoredStore,env:c.env,fetchImpl:c.fetchImpl});
  const receipt = (await restored.status({offer:c.offer,token:c.token})).receipt;
  const film = {film:c.offer.scope,revision:c.offer.revision};
  assert.equal((await c.offer.authority.exchange(receipt,film)).rentalExpiresAt,paidAt + 48*3600);
  t.mock.timers.tick(24*3600_000);
  await restored.webhook(...c.sign(success));
  assert.equal((await restored.status({offer:c.offer,token:c.token})).receipt,receipt);
  t.mock.timers.tick((24*3600 - 120)*1000);
  await restored.webhook(...c.sign(success));
  assert.deepEqual(await c.status(),{status:'expired'});
  assert.equal(restoredStore.viewerOrderBySession(session.id).paidAt,paidAt);
});

test('first canonical confirmation recovers missed delayed webhooks without moving the rental clock later', async t => {
  t.mock.timers.enable({ apis:['Date'], now:Date.now() });
  const c = await context(t);
  await priorOrder(c,'rent');
  await c.start();
  const session = c.first(), intent = c.intents.get(session.payment_intent);
  intent.latest_charge.payment_method_details = {type:'sepa_debit'};
  t.mock.timers.tick(96 * 3600_000);
  c.pay();
  const confirmed = Math.floor(Date.now()/1000);
  const first = await c.status();
  assert.equal(first.status,'paid');
  assert.equal(c.store.viewerOrderBySession(session.id).paidAt,confirmed);
  t.mock.timers.tick(6 * 3600_000);
  const old = { ...c.event(), type:'checkout.session.async_payment_succeeded', created:confirmed - 300 };
  await c.checkout.webhook(...c.sign(old));
  assert.equal((await c.status()).receipt,first.receipt);
  t.mock.timers.tick(42 * 3600_000);
  assert.deepEqual(await c.status(),{status:'expired'});
});

test('old hosted orders migrate as 99-cent rentals and can still fulfill from the original Checkout', async t => {
  const c = await context(t,{legacy:true});
  const order = c.store.viewerOrderBySession('cs_test_legacy');
  assert.deepEqual([order.uiMode,order.amount,order.kind],['hosted',99,'rent']);
  await assert.rejects(c.start(),{statusCode:409});
  c.pay();
  await c.checkout.webhook(...c.sign(c.event()));
  const result = await c.status();
  assert.equal(result.kind,'rent');
  assert.ok(result.receipt);
  assert.deepEqual(await c.start(),{status:'paid'});
  assert.equal(await c.checkout.verifyPurchase({offer:c.offer,orderId:order.orderId}),false);
  assert.equal(c.calls.filter(call=>call.method==='POST').length,0);
});

test('an embedded page from a previous release retries in its original mode and returns the held purchase terms', async t => {
  const c = await context(t);
  const order = await priorOrder(c,'buy','embedded_page');
  c.behavior.lose = true;
  await assert.rejects(c.start('buy'),{statusCode:503});
  c.offer.prices = {rent:null,buy:999};
  c.offer.title = 'New title';
  c.store.setFilmPrices(c.offer.owner,c.offer.id,c.offer.prices);
  const prior = await c.start('buy');
  assert.equal(prior.uiMode,'embedded_page');
  assert.equal(prior.title,order.title);
  assert.equal(prior.amount,499);
  assert.equal(prior.kind,'buy');
  assert.equal(prior.orderId,order.orderId);
  assert.deepEqual(await c.start('buy'),prior);
  assert.equal(c.sessions.size,1);
  assert.ok(c.calls.filter(call=>call.method==='POST').every(call=>call.allowedMethods.length===0));
  c.pay();
  assert.equal((await c.status()).kind,'buy');
});

test('existing Elements orders retain their dynamic methods on retry and new orders require a card-only form', async t => {
  const c = await context(t);
  await priorOrder(c,'buy');
  c.behavior.lose = true;
  await assert.rejects(c.start('buy'),{statusCode:503});
  const legacy = await c.start('buy');
  assert.equal(legacy.uiMode,'elements');
  assert.deepEqual(c.calls.filter(call=>call.method==='POST').map(call=>call.allowedMethods),[[],[]]);
  const token = viewerToken();
  const open = () => c.checkout.start({offer:c.offer,token,origin,kind:'buy'});
  const fresh = await open();
  const session = [...c.sessions.values()].find(value=>value.client_reference_id===fresh.orderId);
  assert.deepEqual(session.allowed_payment_method_types,['card']);
  session.allowed_payment_method_types = ['card','klarna'];
  await assert.rejects(open(),{statusCode:409});
});

test('signed connected adjustments control outstanding rental media and buyer downloads without payment requests per segment', async t => {
  for (const kind of ['rent','buy']) {
    const c = await context(t);
    const film = {film:c.offer.scope,revision:c.offer.revision};
    const source = {revision:film.revision,segments:[{duration:1}],async segment(){return Buffer.from('picture');},close(){}};
    const server = await makeServer(null,{checkout:c.checkout,catalog:{
      get:id=>id === c.offer.id && c.offer, open:async()=>source,
      async download(){return {size:4,title:'Film',async *stream(){yield Buffer.from('film');}};}
    }});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const origin='http://127.0.0.1:'+server.address().port, prefix=origin+'/film/'+c.offer.id+'/';
    const opened=await c.start(kind);
    c.pay();
    const intent=c.intents.get(c.first().payment_intent), charge=intent.latest_charge;
    const initial=await c.status();
    const access=await c.offer.authority.exchange(initial.receipt,film);
    const grant=access.grant;
    const requests=async expected=>{
      const at=c.calls.length;
      const headers={Authorization:'Bearer '+grant};
      for (const path of ['play/index.m3u8','play/key','play/0.ts']) {
        assert.equal((await fetch(prefix+path,{headers})).status,expected);
      }
      assert.equal((await fetch(prefix+'session',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:initial.receipt})).status,expected);
      assert.equal(c.calls.length,at);
      assert.equal((await fetch(prefix+'download',{headers})).status,kind==='buy'?expected:403);
    };
    const send=(type,id,obj,overrides={})=>c.checkout.webhook(...c.sign({...c.event(),type,id,data:{object:obj},...overrides}));
    const refund={object:'refund',id:'re_partial',charge:charge.id,payment_intent:intent.id,amount:1,currency:'usd',status:'pending'};
    c.refunds.push(refund);
    charge.amount_refunded=1;
    await send('refund.created','evt_pending',refund);
    await requests(200);
    refund.status='succeeded';
    await send('refund.updated','evt_partial',refund);
    assert.equal(c.store.viewerOrderById(opened.orderId).refundedAmount,1);
    assert.equal((await c.status()).status,'paid');
    await requests(200);
    const dispute={object:'dispute',id:'du_1',charge:charge.id,payment_intent:intent.id,livemode:false,status:'needs_response'};
    charge.disputed=true;
    c.disputes.push(dispute);
    await send('charge.dispute.created','evt_foreign',dispute,{account:'acct_elsewhere'});
    assert.equal(c.checkout.accessAllowed({offer:c.offer,orderId:opened.orderId,kind}),true);
    await send('charge.dispute.created','evt_dispute',dispute);
    assert.deepEqual(await c.status(),{status:'suspended'});
    await requests(403);
    const before=c.calls.length;
    await send('charge.dispute.created','evt_dispute',dispute);
    assert.equal(c.calls.length,before);
    dispute.status='won';
    await send('charge.dispute.closed','evt_won',dispute);
    await send('charge.dispute.updated','evt_late',{...dispute,status:'needs_response'});
    assert.equal(c.store.viewerOrderById(opened.orderId).disputeStatus,'won');
    await requests(200);
    assert.equal((await c.status()).status,'paid');
    dispute.status='lost';
    await send('charge.dispute.closed','evt_lost',dispute);
    await requests(403);
    assert.deepEqual(await c.status(),{status:'revoked'});
    c.refunds.push({...refund,id:'re_remainder',amount:opened.amount-1});
    charge.refunded=true;
    charge.amount_refunded=opened.amount;
    await send('charge.refunded','evt_full',charge);
    assert.equal(c.store.viewerOrderById(opened.orderId).revocationReason,'refund');
    dispute.status='won';
    await send('charge.dispute.closed','evt_resolution',dispute);
    await requests(403);
    assert.equal(c.store.viewerOrderById(opened.orderId).refundedAmount,opened.amount);
  }
});

test('a refund before the completion webhook binds its seller and intent and cannot revive the order on replay',async t=>{
  const c=await context(t), opened=await c.start();
  c.pay();
  const intent=c.intents.get(c.first().payment_intent), charge=intent.latest_charge;
  charge.refunded=true;
  charge.amount_refunded=opened.amount;
  const refund={object:'refund',id:'re_initial',charge:charge.id,payment_intent:intent.id,amount:opened.amount,currency:'usd',status:'succeeded'};
  c.refunds.push(refund);
  await c.checkout.webhook(...c.sign({...c.event(),type:'refund.created',id:'evt_early',data:{object:refund}}));
  await c.checkout.webhook(...c.sign(c.event()));
  const row=c.store.viewerOrderById(opened.orderId);
  assert.deepEqual([row.intentId,row.chargeId,row.refundedAmount,row.revocationReason],[intent.id,charge.id,opened.amount,'refund']);
  assert.deepEqual(await c.status(),{status:'revoked'});
  await assert.rejects(c.checkout.webhook(...c.sign({...c.event(),type:'refund.created',id:'evt_mismatch',data:{object:{...refund,charge:'ch_other'}}})),{statusCode:409});
  assert.ok(!c.store.paymentEventSeen(c.offer.account,'evt_mismatch'));
});

test('rental duration is fixed with the order price and old receipts fail closed if matching rentals are ambiguous',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const c=await context(t);
  const original=c.store.film(c.offer.owner,c.offer.id);
  c.offer.rentalHours=2;
  c.store.setFilmSettings(c.offer.owner,c.offer.id,{prices:original.prices,rentalHours:2,previewSeconds:10});
  const opened=await c.start();
  assert.equal(opened.rentalHours,2);
  c.offer.rentalHours=100;
  c.store.setFilmSettings(c.offer.owner,c.offer.id,{prices:original.prices,rentalHours:100,previewSeconds:10});
  assert.equal((await c.start()).rentalHours,2);
  c.pay();
  const paid=await c.status();
  assert.equal(paid.rentalHours,2);
  assert.equal(paid.expiresAt,c.purchased+2*3600);
  const grant=await c.offer.authority.exchange(paid.receipt,{film:c.offer.scope,revision:c.offer.revision});
  assert.equal(grant.orderId,opened.orderId);
  t.mock.timers.tick(2*3600_000);
  assert.equal(c.checkout.accessAllowed({offer:c.offer,orderId:opened.orderId,kind:'rent'}),false);
  assert.deepEqual(await c.status(),{status:'expired'});
  const legacy=await context(t,{legacy:true});
  legacy.pay();
  await legacy.status();
  const request={offer:legacy.offer,kind:'rent',rentalExpiresAt:legacy.purchased+48*3600};
  assert.equal(legacy.checkout.accessAllowed(request),true);
  const another=viewerToken();
  const concurrent=await legacy.checkout.start({offer:legacy.offer,token:another,origin});
  const session=[...legacy.sessions.values()].find(row=>row.client_reference_id===concurrent.orderId);
  Object.assign(session,{status:'complete',payment_status:'paid'});
  const pi=legacy.intents.get(session.payment_intent), charge=pi.latest_charge;
  charge.amount_refunded=99;
  legacy.refunds.push({object:'refund',id:'re_clock',charge:charge.id,amount:99,status:'succeeded',currency:'usd'});
  await legacy.checkout.status({offer:legacy.offer,token:another});
  assert.equal(legacy.checkout.accessAllowed(request),false);
});

test('an older in-flight partial refund observation cannot undo a full refund processed by another checkout worker',async t=>{
  const c=await context(t);
  await c.start('buy');
  c.pay();
  await c.status();
  const intent=c.intents.get(c.first().payment_intent), charge=intent.latest_charge;
  const refund={id:'re_small',object:'refund',charge:charge.id,payment_intent:intent.id,currency:'usd',amount:1,status:'succeeded'};
  c.refunds.push(refund);
  charge.amount_refunded=1;
  const reading=Promise.withResolvers(), resume=Promise.withResolvers();
  c.behavior.delayRead=()=>{ reading.resolve(); return resume.promise; };
  const stale=c.status();
  await reading.promise;
  const another=createViewerCheckout({store:c.store,env:c.env,fetchImpl:c.fetchImpl});
  const full={...refund,id:'re_rest',amount:charge.amount-1};
  c.refunds.push(full);
  charge.amount_refunded=charge.amount;
  charge.refunded=true;
  try {
    await another.webhook(...c.sign({...c.event(),type:'refund.created',id:'evt_last',data:{object:full}}));
  } finally { resume.resolve(); }
  assert.deepEqual(await stale,{status:'revoked'});
  assert.equal(c.store.viewerOrderBySession(c.first().id).refundedAmount,charge.amount);
});

test('unpublishing expires only this seller’s open Sessions and honors the payment that completes during expiration',async t=>{
  const c=await context(t);
  const first=await c.start();
  const secondToken=viewerToken();
  const second=await c.checkout.start({offer:c.offer,token:secondToken,origin,kind:'buy'});
  const other={...c.offer,id:'f-'+randomUUID()};
  const bucket=c.store.film(c.offer.owner,c.offer.id).bucket;
  c.store.saveFilm(other.owner,bucket,{id:other.id,title:other.title,revision:other.revision,prices:other.prices});
  const unrelated=c.store.reserveViewerOrder({...other,tokenHash:await sha256Hex(viewerToken()),platform:'acct_platform',
    origin,kind:'rent',amount:99});
  c.store.bindViewerSession(unrelated.orderId,'cs_test_unrelated');
  const sessionB=[...c.sessions.values()].find(s=>s.client_reference_id===second.orderId);
  c.behavior.completeDuringExpire=sessionB.id;
  assert.equal(c.store.setFilmPublication('Wrong filmmaker',c.offer.id,false),false);
  assert.equal(c.store.setFilmPublication(c.offer.owner,c.offer.id,false),true);
  assert.equal(await c.checkout.closeWithdrawnSessions(c.offer.owner,c.offer.id),0);
  assert.equal(c.first().status,'expired');
  assert.equal(c.store.viewerOrderById(first.orderId).status,'expired');
  const expires=c.calls.filter(call=>call.path.endsWith('/expire'));
  assert.equal(expires.length,2);
  assert.ok(expires.every(call=>call.recipient===c.offer.account));
  assert.equal(c.store.viewerOrderById(unrelated.orderId).withdrawalState,null);
  assert.equal((await c.checkout.status({offer:c.offer,token:secondToken})).status,'paid');
  assert.equal(c.checkout.accessAllowed({offer:c.offer,orderId:second.orderId,kind:'buy'}),true);
  await assert.rejects(c.checkout.start({offer:c.offer,token:viewerToken(),origin}),{statusCode:409});
  assert.equal(await c.checkout.closeWithdrawnSessions(c.offer.owner,c.offer.id),0);
  assert.equal(c.calls.filter(call=>call.path.endsWith('/expire')).length,2);
});

test('unpublish while Stripe is creating a session never releases its client secret, even when immediately republished',async t=>{
  const c=await context(t);
  const created=Promise.withResolvers(), resume=Promise.withResolvers();
  c.behavior.holdCreateResponse=()=>{created.resolve();return resume.promise;};
  const started=c.start();
  await created.promise;
  c.store.setFilmPublication(c.offer.owner,c.offer.id,false);
  assert.equal(await c.checkout.closeWithdrawnSessions(c.offer.owner,c.offer.id),0);
  c.store.setFilmPublication(c.offer.owner,c.offer.id,true);
  resume.resolve();
  await assert.rejects(started,{statusCode:410});
  assert.equal(c.first().status,'expired');
  assert.deepEqual(await c.status(),{status:'expired'});
});

test('a separate setup process resetting the recipient during session creation closes the old form even if the same account reconnects',async t=>{
  const c = await context(t);
  const admin = openSetupStore(c.folder);
  t.after(()=>admin.close());
  const created = Promise.withResolvers(), resume = Promise.withResolvers();
  c.behavior.holdCreateResponse=()=>{created.resolve();return resume.promise;};
  const started = c.start();
  await created.promise;
  const selected = admin.stripeContext(c.offer.owner,'test');
  assert.ok(admin.resetStripe(c.offer.owner,'test',selected.confirmation));
  const connected = admin.stripeContext(c.offer.owner,'test');
  assert.ok(connected.claimAccount(c.offer.account,'test'));
  Object.assign(connected.state,selected.state);
  connected.save();
  resume.resolve();
  await assert.rejects(started,{statusCode:410});
  assert.equal(c.first().status,'expired');
  await assert.rejects(c.start(),{statusCode:410});
  assert.equal(c.calls.filter(call=>call.method==='POST'&&call.path==='/v1/checkout/sessions').length,1);
});

test('an unavailable Stripe expiration is queued across restart and publication never restores a withdrawn form',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const c=await context(t);
  const started=await c.start();
  c.store.setFilmPublication(c.offer.owner,c.offer.id,false);
  c.behavior.expireUnavailable=true;
  assert.equal(await c.checkout.closeWithdrawnSessions(c.offer.owner,c.offer.id),1);
  assert.equal(c.store.filmPublication(c.offer.id).published,0);
  assert.equal(c.store.viewerOrderById(started.orderId).withdrawalState,'requested');
  const reopened=openSetupStore(c.folder);
  t.after(()=>reopened.close());
  const next=createViewerCheckout({store:reopened,env:c.env,fetchImpl:c.fetchImpl});
  c.behavior.expireUnavailable=false;
  t.mock.timers.tick(31_000);
  await next.closeWithdrawnSessions();
  assert.equal(reopened.viewerOrderById(started.orderId).status,'expired');
  assert.equal(reopened.viewerOrderById(started.orderId).withdrawalState,'closed');
  assert.equal(c.first().status,'expired');
  c.store.setFilmPublication(c.offer.owner,c.offer.id,true);
  await assert.rejects(c.start(),{statusCode:410});
  assert.ok((await c.checkout.start({offer:c.offer,token:viewerToken(),origin})).clientSecret);
});

test('the withdrawal worker never expires a Session whose provider metadata disagrees with the local order',async t=>{
  const c=await context(t);
  await c.start();
  c.store.setFilmPublication(c.offer.owner,c.offer.id,false);
  c.first().metadata.order='another-order';
  assert.equal(await c.checkout.closeWithdrawnSessions(c.offer.owner,c.offer.id),1);
  assert.equal(c.calls.some(call=>call.path.endsWith('/expire')),false);
  assert.equal(c.first().status,'open');
});

test('grant renewal recovers a missed external refund while routine media checks stay local', async t => {
  const c = await context(t);
  const order = await c.start();
  c.pay();
  await c.status();
  const request = { offer: c.offer, orderId: order.orderId, kind: 'rent' };
  const calls = c.calls.length;
  assert.equal(await c.checkout.verifyPlayback(request), true);
  assert.equal(c.calls.length, calls);
  const charge = c.intents.get(c.first().payment_intent).latest_charge;
  charge.amount_refunded = charge.amount;
  charge.refunded = true;
  c.refunds.push({ id: 're_missed', object: 'refund', charge: charge.id, amount: charge.amount,
    status: 'succeeded', currency: 'usd', payment_intent: charge.payment_intent });
  const db = new DatabaseSync(join(c.folder, 'setup.sqlite'));
  db.prepare('UPDATE viewer_test_orders SET verifiedAt=unixepoch()-301 WHERE orderId=?').run(order.orderId);
  db.close();
  assert.equal(await c.checkout.verifyPlayback(request), false);
  assert.equal(c.checkout.accessAllowed(request), false);
});
