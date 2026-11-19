import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@dustwave/worker-core/crypto';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { openSetupStore } from '../src/setup-store.js';
import { createViewerCheckout } from '../src/viewer-checkout.js';

const origin = 'http://127.0.0.1:8787';
const secret = 'whsec_fixture';
const viewerToken = () => randomBytes(32).toString('base64url');

async function context(t, { legacy = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'stream-viewer-test-'));
  const owner = 'Buyer rehearsal filmmaker', account = 'acct_seller';
  const offer = { id: 'f-' + randomUUID(), owner, account, title: 'A short film', scope: 'saved/clip',
    prices: {rent:99,buy:499}, revision: 'revision-one', authority: createRentalAuthority(randomBytes(32)) };
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
  store.saveStripe(owner, { byMode: { test: { mode: 'test', creatorId: owner, channel: 'oauth', accountId: account } } });
  const bucket = { accountId: 'fixture', bucket: 'synthetic', jurisdiction: 'default' };
  store.saveBucket(owner, { ...bucket, accessKeyId: 'fixture', secretAccessKey: 'fixture' });
  store.saveFilm(owner, bucket, { id: offer.id, title: offer.title, revision: offer.revision, prices: offer.prices });
  const calls = [], sessions = new Map(), intents = new Map(), requests = new Map();
  const behavior = { available: true, platform: 'acct_platform', lose: false, missingSecret: false };
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
    if (url.pathname === '/v1/accounts/' + account) return Response.json({ id: account, object: 'account', type: 'standard',
      charges_enabled: behavior.available, payouts_enabled: behavior.available });
    assert.equal(recipient, account);
    if (method === 'POST') {
      assert.equal(url.pathname, '/v1/checkout/sessions');
      const amount = Number(form.get('line_items[0][price_data][unit_amount]'));
      assert.equal(headers.get('Stripe-Version'), '2026-10-28.endive');
      const uiMode = form.get('ui_mode');
      if (uiMode === 'embedded_page') {
        assert.equal(form.get('redirect_on_completion'), 'never');
        assert.equal(form.has('return_url'),false);
      } else {
        assert.equal(uiMode,'elements');
        assert.equal(form.has('redirect_on_completion'),false);
        assert.equal(form.get('return_url'),origin + '/embed/' + offer.id + '?order=' + form.get('client_reference_id'));
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
        assert.equal(markers.order,order);
        assert.equal(markers.amount,String(amount));
        for (const [k,v] of Object.entries(markers)) assert.equal(v,form.get('payment_intent_data[metadata][' + k + ']'));
        id = addSession(suffix, amount, markers, uiMode, methods.length ? methods : null);
        requests.set(key, id);
      }
      if (behavior.lose) { behavior.lose=false; throw new Error('Interrupted after creating session'); }
      return Response.json(sessions.get(id));
    }
    const id = url.pathname.split('/').at(-1);
    if (sessions.has(id)) return Response.json(sessions.get(id));
    assert.equal(url.searchParams.get('expand[0]'),'latest_charge');
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
  return { folder, store, env, fetchImpl, offer, token, checkout, calls, first, sessions, intents, behavior, purchased, sign, event, pay,
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

test('a reload or concurrent click reuses Checkout Elements, polling and verified Connect webhook fulfill once', async t => {
  const c=await context(t);
  assert.deepEqual(await c.status(),{ status:'pending' });
  assert.equal(c.calls.length,0);
  const [a,b]=await Promise.all([c.start(),c.start()]);
  assert.deepEqual(a,b);
  assert.deepEqual(a,{clientSecret:c.first().client_secret,publishableKey:'pk_test_fixture',account:c.offer.account,
    uiMode:'elements',orderId:c.first().client_reference_id,title:c.offer.title,kind:'rent',amount:99,currency:'usd'});
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
  c.intents.get(c.first().payment_intent).latest_charge.amount_refunded=1;
  assert.deepEqual(await c.status(),{status:'expired'});
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
  assert.equal(await restored.verifyPurchase(request), false);
  assert.deepEqual(await c.status(), {status:'expired'});
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
