import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSetupStore } from '../src/setup-store.js';
import { connectedTestRental } from '../src/connected-test-rental.js';
import { revisionFor } from '../src/media.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stream-test-sale-'));
  const store = openSetupStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = 'Test creator', filmId = 'f-' + randomUUID(), account = 'acct_connected';
  const platform = 'acct_platform';
  const bucket = { accountId: 'storage-test', jurisdiction: 'default', bucket: 'owned-test' };
  store.invite(owner);
  store.claimAccount(owner, account, 'test');
  const cfg = { mode: 'test', channel: 'oauth', accountId: account, creatorId: owner };
  store.saveStripe(owner, { byMode: { test: cfg, live: { ...cfg, mode: 'live', accountId: 'acct_real' } } });
  store.saveBucket(owner, { ...bucket, accessKeyId: 'fixture', secretAccessKey: 'fixture' });
  const head = { revision: '"0123abcd"' };
  const record = { id: filmId, objectKey: 'fixture.mp4', rights: {
    version: 'v1', statement: 'Distribution rights confirmed', acceptedAt: new Date().toISOString() }, revision: revisionFor(head) };
  store.saveFilm(owner, bucket, record);
  const calls = [], methods = new Map();
  const purchased = Math.floor(Date.now() / 1000);
  const behavior = { payouts: true, recipient: account, withhold: 0, modify: () => {}, platform };
  const fetchImpl = async (href, options) => {
    const url = new URL(href);
    const method = options.method;
    const headers = new Headers(options.headers);
    const recipient = headers.get('Stripe-Account');
    calls.push({ path: url.pathname, method, recipient, idempotency: headers.get('Idempotency-Key') });
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/v1/account') {
      assert.equal(method, 'GET');
      assert.equal(recipient, null);
      return Response.json({ id: behavior.platform, object: 'account' });
    }
    if (url.pathname === '/v1/accounts/' + behavior.recipient) {
      assert.equal(method, 'GET');
      return Response.json({ id: behavior.recipient, object: 'account', type: 'standard', charges_enabled: true, payouts_enabled: behavior.payouts });
    }
    assert.equal(recipient, behavior.recipient);
    if (method === 'POST') {
      assert.equal(url.pathname, '/v1/payment_intents');
      const body = new URLSearchParams(options.body);
      const idempotency = headers.get('Idempotency-Key');
      assert.ok(idempotency);
      assert.equal(body.get('amount'), '99');
      assert.equal(body.get('payment_method'), 'pm_card_visa');
      assert.equal(body.get('transfer_data[destination]'), null);
      if (!methods.has(idempotency)) methods.set(idempotency, Object.fromEntries(['scope', 'product', 'order'].map(k => [k, body.get('metadata[' + k + ']')])));
      if (behavior.loseResponse) { behavior.loseResponse = false; throw new Error('Lost response'); }
      return Response.json({ id: 'pi_saved', livemode: false });
    }
    assert.equal(url.pathname, '/v1/payment_intents/pi_saved');
    assert.equal(url.searchParams.get('expand[0]'), 'latest_charge.balance_transaction');
    const charge = { id: 'ch_saved', object: 'charge', payment_intent: 'pi_saved', created: purchased,
      livemode: false, status: 'succeeded', captured: true, paid: true, refunded: false, disputed: false,
      amount: 99, amount_captured: 99, amount_refunded: 0, currency: 'usd',
      balance_transaction: behavior.withhold-- > 0 ? null : { id: 'txn_saved', object: 'balance_transaction', type: 'charge', source: 'ch_saved',
        currency: 'usd', amount: 99, fee: 33, net: 66, status: 'pending', fee_details: [{ type: 'stripe_fee', currency: 'usd', amount: 33 }] } };
    const pi = { id: 'pi_saved', object: 'payment_intent', livemode: false, status: 'succeeded', amount: 99, amount_received: 99,
      currency: 'usd', metadata: { ...methods.values().next().value }, latest_charge: charge };
    behavior.modify(pi);
    return Response.json(pi);
  };
  const args = { owner, filmId, store, env: { STRIPE_CONNECT_SECRET_KEY: 'sk_test_localfixture' },
    signingKey: randomBytes(32), fetchImpl, sourceFor: () => ({ head: async () => head }), sleep: async () => {} };
  return { args, calls, methods, behavior, cfg, head, store };
}

test('two operators and a rerun share one bound connected-account payment, ledger and receipt', async t => {
  const f = await fixture(t);
  f.behavior.withhold = 1;
  f.behavior.loseResponse = true;
  const [a,b] = await Promise.all([connectedTestRental(f.args), connectedTestRental(f.args)]);
  assert.equal(a.receipt,b.receipt);
  assert.equal(f.methods.size,1);
  assert.equal(a.evidence.gross,99); assert.equal(a.evidence.stripeFees,33); assert.equal(a.evidence.net,66);
  assert.equal(a.evidence.platformFee,0);
  assert.equal(a.evidence.totalFees,33);
  assert.deepEqual(a.evidence.feeBreakdown,{stripe_fee:33});
  assert.equal(a.evidence.filmReceiptVerified,true);
  assert.doesNotMatch(JSON.stringify(a.evidence),/pi_saved|acct_|ch_saved|txn_saved|fixture\.mp4|receipt\./);
  const count = f.calls.filter(c => c.method === 'POST').length;
  await connectedTestRental(f.args);
  assert.equal(f.calls.filter(c => c.method === 'POST').length,count);
  assert.ok(f.calls.filter(c => c.path.includes('payment_intents')).every(c => c.recipient === 'acct_connected'));
});

test('requires saved ownership, unmodified original, a distinct test recipient, and current capabilities', async t => {
  const f = await fixture(t);
  await assert.rejects(connectedTestRental({ ...f.args, owner: 'Wrong owner' }), /rights/);
  await assert.rejects(connectedTestRental({ ...f.args, env: { STRIPE_CONNECT_SECRET_KEY: 'sk_live_fixture' } }), /sandbox key/);
  await assert.rejects(connectedTestRental({ ...f.args, env: { ...f.args.env, STRIPE_CONNECT_LIVE: '1' } }), /test mode/);
  await assert.rejects(connectedTestRental({ ...f.args, sourceFor: () => ({ head: async () => ({ revision: 'new' }) }) }), /changed/);
  assert.equal(f.calls.length,0);
  f.behavior.platform = f.cfg.accountId;
  await assert.rejects(connectedTestRental(f.args), /distinct/);
  f.behavior.platform = 'acct_platform';
  f.behavior.payouts = false;
  await assert.rejects(connectedTestRental(f.args), /charges and payouts/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length,0);
  f.store.saveStripe(f.args.owner,{ byMode: { test: { ...f.cfg, accountId: 'acct_unclaimed' } } });
  await assert.rejects(connectedTestRental(f.args), /verified sandbox connection/);
});

test('rejects inconsistent ledger, unexpected recipients, refunds, lost data and order metadata', async t => {
  const f = await fixture(t);
  for (const mutate of [
    p => { p.id = 'pi_other'; }, p => { p.metadata.order = 'other'; }, p => { p.metadata.scope = 'other'; },
    p => { p.latest_charge.balance_transaction.source = 'ch_other'; }, p => { p.latest_charge.balance_transaction.currency = 'eur'; },
    p => { p.latest_charge.balance_transaction.fee = 32; }, p => { p.latest_charge.balance_transaction.net = 67; },
    p => { p.latest_charge.balance_transaction.fee_details[0].amount = 34; }, p => { p.application_fee_amount = 4; },
    p => { p.latest_charge.paid = false; }, p => { p.livemode = true; }, p => { p.latest_charge.refunded = true; }
  ]) {
    f.behavior.modify = mutate;
    await assert.rejects(connectedTestRental(f.args));
  }
  assert.equal(f.methods.size,1);
  f.behavior.modify = () => {};
  f.behavior.withhold = 10;
  await assert.rejects(connectedTestRental(f.args), /balance transaction is pending/);
  f.behavior.withhold = 0;
  await connectedTestRental(f.args);
  f.behavior.recipient = 'acct_changed';
  f.store.claimAccount(f.args.owner,f.behavior.recipient,'test');
  f.store.saveStripe(f.args.owner,{ byMode: {test: {...f.cfg, accountId: f.behavior.recipient}} });
  await assert.rejects(connectedTestRental(f.args), /another recipient or revision/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length,1);
});


test('the connected USD ledger separates Stripe fees, pass-through fees and taxes', async t => {
  const f = await fixture(t);
  f.behavior.modify = intent => {
    intent.latest_charge.balance_transaction.fee_details = [
      { type: 'stripe_fee', currency: 'usd', amount: 20 },
      { type: 'payment_method_passthrough_fee', currency: 'usd', amount: 6 },
      { type: 'tax', currency: 'usd', amount: 4 },
      { type: 'tax', currency: 'usd', amount: 1 },
      { type: 'withheld_tax', currency: 'usd', amount: 2 }
    ];
  };
  const { evidence } = await connectedTestRental(f.args);
  assert.equal(evidence.gross - evidence.totalFees, evidence.net);
  assert.equal(evidence.totalFees, 33);
  assert.equal(evidence.stripeFees, 20);
  assert.deepEqual(evidence.feeBreakdown, { stripe_fee: 20, payment_method_passthrough_fee: 6, tax: 5, withheld_tax: 2 });
  for (const type of ['application_fee', 'unrecognized']) {
    f.behavior.modify = intent => { intent.latest_charge.balance_transaction.fee_details[0].type = type; };
    await assert.rejects(connectedTestRental(f.args), /Unexpected fee/);
  }
});

test('a hosted seller under post-submit Stripe review cannot create a rental charge', async t => {
  const f = await fixture(t);
  const account = f.cfg.accountId;
  f.store.saveStripe(f.args.owner, { byMode: { test: { ...f.cfg, channel: 'hosted' } } });
  const fetchImpl = async (href, options) => {
    if (new URL(href).pathname !== '/v2/core/accounts/' + account) return f.args.fetchImpl(href, options);
    return Response.json({ id: account, object: 'v2.core.account', livemode: false,
      configuration: { merchant: { capabilities: {
        card_payments: { status: 'restricted', status_details: [{ code: 'requirements_past_due', resolution: 'provide_info' }] },
        stripe_balance: { payouts: { status: 'pending', status_details: [{ code: 'requirements_pending_verification', resolution: 'no_resolution' }] } }
      } } },
      requirements: { summary: { minimum_deadline: { status: 'past_due' } },
        entries: [{ minimum_deadline: { status: 'past_due' }, awaiting_action_from: 'stripe', errors: [] }] }
    });
  };
  await assert.rejects(connectedTestRental({ ...f.args, fetchImpl }), /ready for both charges and payouts/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});
