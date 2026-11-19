import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@dustwave/worker-core/crypto';
import { createRentalAuthority } from '../src/rental.js';
import { openSetupStore } from '../src/setup-store.js';
import { createViewerCheckout } from '../src/viewer-checkout.js';

const origin = 'http://127.0.0.1:8787';
const secret = 'whsec_fixture';
const viewerToken = () => randomBytes(32).toString('base64url');

async function context(t) {
  const folder = await mkdtemp(join(tmpdir(), 'stream-viewer-test-'));
  const store = openSetupStore(folder);
  t.after(async () => { store.close(); await rm(folder, { recursive: true, force: true }); });
  const owner = 'Buyer rehearsal filmmaker', account = 'acct_seller';
  const offer = { id: 'f-' + randomUUID(), owner, account, title: 'A short film', scope: 'saved/clip',
    revision: 'revision-one', authority: createRentalAuthority(randomBytes(32)) };
  store.invite(owner);
  store.claimAccount(owner, account, 'test');
  store.saveStripe(owner, { byMode: { test: { mode: 'test', creatorId: owner, channel: 'oauth', accountId: account } } });
  const bucket = { accountId: 'fixture', bucket: 'synthetic', jurisdiction: 'default' };
  store.saveBucket(owner, { ...bucket, accessKeyId: 'fixture', secretAccessKey: 'fixture' });
  store.saveFilm(owner, bucket, { id: offer.id, title: offer.title, revision: offer.revision });
  const calls = [], sessions = new Map(), intents = new Map(), requests = new Map();
  const behavior = { available: true, platform: 'acct_platform', lose: false, untrustedUrl: false };
  const purchased = Math.floor(Date.now() / 1000) - 300;
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
      assert.equal(form.get('line_items[0][price_data][unit_amount]'), '99');
      assert.equal(form.get('success_url'), origin + '/checkout/return');
      assert.equal(form.get('cancel_url'), origin + '/checkout/cancel');
      const key = headers.get('Idempotency-Key');
      assert.ok(key);
      let id = requests.get(key);
      if (!id) {
        const suffix = randomBytes(8).toString('hex');
        id = 'cs_test_' + suffix;
        const pi = 'pi_' + suffix;
        const order = form.get('client_reference_id');
        const markers = Object.fromEntries(['order','flow','product','scope'].map(k => [k,form.get('metadata[' + k + ']')]));
        for (const [k,v] of Object.entries(markers)) assert.equal(v,form.get('payment_intent_data[metadata][' + k + ']'));
        requests.set(key, id);
        sessions.set(id, { id, object:'checkout.session', status:'open', payment_status:'unpaid', payment_intent:pi,
          livemode:false, mode:'payment', currency:'usd', amount_total:99, amount_subtotal:99,
          metadata:markers, client_reference_id:order, url:'https://' + (behavior.untrustedUrl ? 'example.test' : 'checkout.stripe.com') + '/c/pay/' + id });
        intents.set(pi, {id:pi, object:'payment_intent', livemode:false, status:'succeeded', amount:99, amount_received:99, currency:'usd', metadata:{...markers},
          latest_charge:{id:'ch_' + suffix,object:'charge',livemode:false,status:'succeeded',paid:true,captured:true,refunded:false,disputed:false,
            amount:99,amount_captured:99,amount_refunded:0,currency:'usd',created:purchased,payment_intent:pi}});
      }
      if (behavior.lose) { behavior.lose=false; throw new Error('Interrupted after creating session'); }
      return Response.json(sessions.get(id));
    }
    const id = url.pathname.split('/').at(-1);
    if (sessions.has(id)) return Response.json(sessions.get(id));
    assert.equal(url.searchParams.get('expand[0]'),'latest_charge');
    return Response.json(intents.get(id));
  }
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture', STRIPE_CONNECT_WEBHOOK_SECRET: secret };
  const checkout = createViewerCheckout({ store, env, fetchImpl });
  const token = viewerToken();
  const first = () => sessions.values().next().value;
  const sign = (event, time = Math.floor(Date.now()/1000)) => {
    const payload = JSON.stringify(event);
    const digest = createHmac('sha256',secret).update(time + '.' + payload).digest('hex');
    return [Buffer.from(payload), 't=' + time + ',v1=' + digest];
  };
  const event = () => ({object:'event',id:'evt_fixture',type:'checkout.session.completed',account,livemode:false,data:{object:first()}});
  const pay = () => { Object.assign(first(), { status:'complete', payment_status:'paid' }); };
  return { store, env, fetchImpl, offer, token, checkout, calls, first, sessions, intents, behavior, purchased, sign, event, pay,
    start: () => checkout.start({ offer,token,origin }), status: () => checkout.status({offer,token}) };
}

test('a reload or concurrent click reuses hosted Checkout, polling and verified Connect webhook fulfill once', async t => {
  const c=await context(t);
  assert.deepEqual(await c.status(),{ status:'pending' });
  assert.equal(c.calls.length,0);
  const [a,b]=await Promise.all([c.start(),c.start()]);
  assert.deepEqual(a,b);
  assert.equal(c.calls.filter(x=>x.method==='POST').length,1);
  const order=c.store.viewerOrderBySession(c.first().id);
  assert.equal(order.tokenHash,await sha256Hex(c.token));
  assert.ok(!JSON.stringify(order).includes(c.token));
  const polls=c.calls.length;
  await c.status(); await c.status();
  assert.equal(c.calls.length-polls,1);
  c.pay();
  const delivery=c.sign(c.event());
  await Promise.all([c.checkout.webhook(...delivery),c.checkout.webhook(...delivery)]);
  const [one,two]=await Promise.all([c.status(),c.status()]);
  assert.equal(one.status,'paid');
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
  assert.equal((await c.start()).url,origin+'/checkout/return');
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

test('sandbox key, distinct ready recipient, viewer token and a Stripe-provided checkout URL are mandatory',async t=>{
  const c=await context(t);
  const bad=createViewerCheckout({store:c.store,env:{STRIPE_CONNECT_SECRET_KEY:'sk_live_fixture'},fetchImpl:c.fetchImpl});
  await assert.rejects(bad.start({offer:c.offer,token:c.token,origin}),{statusCode:503});
  await assert.rejects(c.checkout.start({offer:c.offer,token:'bad',origin}),{statusCode:400});
  assert.equal(c.calls.length,0);
  c.behavior.platform=c.offer.account;
  await assert.rejects(c.start(),{statusCode:409});
  c.behavior.platform='acct_platform';
  const next=createViewerCheckout({store:c.store,env:c.env,fetchImpl:c.fetchImpl});
  c.behavior.available=false;
  await assert.rejects(next.start({offer:c.offer,token:c.token,origin}));
  assert.equal(c.sessions.size,0);
  c.behavior.available=true;c.behavior.untrustedUrl=true;
  await assert.rejects(next.start({offer:c.offer,token:c.token,origin}),{statusCode:409});
});

test('lost creates reuse Stripe idempotency and quota excludes repeat buyers with existing tokens',async t=>{
  const c=await context(t);
  c.behavior.lose=true;
  await assert.rejects(c.start(),{statusCode:503});
  assert.equal(c.sessions.size,1);
  const paidUrl=(await c.start()).url;
  assert.equal(c.sessions.size,1);
  for(let n=1;n<30;n++)await c.checkout.start({offer:c.offer,token:viewerToken(),origin});
  const calls=c.calls.length;
  await assert.rejects(c.checkout.start({offer:c.offer,token:viewerToken(),origin}),{statusCode:429});
  assert.equal(c.calls.length,calls);
  assert.equal((await c.start()).url,paidUrl);
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
