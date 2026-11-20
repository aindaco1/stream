import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSetupStore } from '../src/setup-store.js';
import { renderSettingsPage } from '../src/setup-view.js';
import assert from 'node:assert/strict';
import { createStripeSetup, StripeSetupError, stripeSetupStateForMode } from '../src/setup-stripe.js';

const origin = 'http://127.0.0.1:8787';
const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture', STRIPE_CONNECT_CLIENT_ID: 'ca_fixture' };
const id = 'acct_test123';
const oauthId = 'acct_existing123';

test('a mode reset fences stale forms, setup callbacks and concurrent saves, while retaining historical claims', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stream-stripe-reset-'));
  const db = openSetupStore(root), second = openSetupStore(root);
  t.after(async () => { db.close(); second.close(); await rm(root, {recursive:true,force:true}); });
  const owner = 'First filmmaker';
  db.invite(owner);
  const f = fixture();
  const ctx = () => db.stripeContext(owner, 'test');
  async function reconnect() {
    const url = new URL((await f.adapter.start(ctx(), 'existing')).redirect);
    return f.adapter.callback(ctx(), 'oauth', new URLSearchParams({code:'ac_fixture',state:url.searchParams.get('state')}));
  }
  const live = db.stripeContext(owner, 'live');
  Object.assign(live.state, {creatorId:owner, channel:'hosted', accountId:'acct_livefixture', status:'ready'});
  live.save();
  const oauth = new URL((await f.adapter.start(ctx(), 'existing')).redirect);
  const obsolete = ctx();
  const liveForm = db.stripeContext(owner, 'live').confirmation;
  const calls = f.calls.length;
  assert.equal(second.resetStripe(owner, 'test', liveForm), false);
  assert.equal(second.resetStripe(owner, 'test', obsolete.confirmation), true);
  assert.equal(f.calls.length, calls);
  assert.throws(() => obsolete.claimAccount('acct_unclaimed', 'test'), /changed/);
  assert.throws(() => obsolete.save(), /changed/);
  assert.equal(db.ownsTestAccount(owner, 'acct_unclaimed'), false);
  await assert.rejects(f.adapter.callback(ctx(), 'oauth', new URLSearchParams({code:'ac_fixture',state:oauth.searchParams.get('state')})), /expired/);
  assert.equal(f.calls.length, calls);
  assert.equal((await reconnect()).status, 'ready');
  const ready = ctx();
  assert.equal(db.resetStripe(owner, 'test', ready.confirmation), true);
  assert.equal(db.claimAccount('Different filmmaker',oauthId,'test'),false);
  assert.equal((await reconnect()).status, 'ready');
  assert.equal(ctx().state.accountId, oauthId);
  assert.equal(db.resetStripe(owner,'test',ready.confirmation),false);
  assert.equal(db.stripeContext(owner,'live').confirmation, liveForm);
  const latest = ctx();
  // Saving another mode concurrently must survive a later checkpoint in this mode.
  assert.equal(second.resetStripe(owner, 'live', liveForm),true);
  latest.save();
  assert.equal(ctx().state.accountId,oauthId);
  assert.equal(db.stripeContext(owner,'live').state.status,'unconnected');
});

function fixture(options = {}) {
  let time = Date.now();
  const calls = [];
  const owners = new Map();
  const provider = {
    snapshot: { card: 'pending', payouts: 'pending', due: null },
    failCreateOnce: false, failOAuthOnce: false, denied: false, liveOAuth: false,
    nextOAuthId: oauthId, redirectHost: 'accounts.stripe.com'
  };
  function context(creatorId = 'creator-one') {
    return {
      creatorId, state: {}, checkpoints: [], verifiedEmail: 'filmmaker@example.test',
      async save() { this.checkpoints.push(structuredClone(this.state)); },
      async claimAccount(account, mode) {
        const key = mode + '/' + account;
        if (owners.has(key) && owners.get(key) !== creatorId) return false;
        owners.set(key, creatorId);
        return true;
      }
    };
  }
  async function fetchImpl(href, init) {
    const url = new URL(href);
    assert.equal(init.redirect, 'error');
    assert.ok(['api.stripe.com', 'connect.stripe.com'].includes(url.hostname));
    const body = init.body && (url.pathname === '/oauth/token' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body));
    calls.push({ path: url.pathname, query: url.searchParams, body, idempotency: init.headers['Idempotency-Key'] });
    switch (url.pathname) {
      case '/v2/core/accounts':
        if (provider.failCreateOnce) { provider.failCreateOnce = false; throw new Error('simulated disconnect'); }
        if (provider.createError) return Response.json({ error: { code: provider.createError } }, { status: 400 });
        if (!body.identity?.country && !provider.legacySucceeded) {
          return Response.json({ error: { code: 'identity_country_required' } }, { status: 400 });
        }
        return Response.json({ object: 'v2.core.account', id, livemode: false });
      case '/v2/core/account_links':
        return Response.json({
          account: body.account, object: 'v2.core.account_link', livemode: false,
          url: 'https://' + provider.redirectHost + '/r/private-account-link'
        });
      case '/v2/core/accounts/' + oauthId:
        if (init.method === 'POST' && body.configuration.recipient) provider.snapshot.receives=true;
        return Response.json({id:oauthId,object:'v2.core.account',livemode:false,configuration:{
          recipient:provider.snapshot.receives ? {capabilities:{stripe_balance:{stripe_transfers:{requested:true,status:'active'}}}} : null}});
      case '/v2/core/accounts/' + id: {
        if (provider.denied) return new Response(null, { status: 403 });
        const { card, payouts, due, entries, cardDetails, payoutDetails } = provider.snapshot;
        return Response.json({
          id, object: 'v2.core.account', livemode: false, display_name: 'Projection Studio', identity: { country: provider.snapshot.country },
          requirements: { entries, summary: { minimum_deadline: { status: due } } },
          configuration: { merchant: { capabilities: {
            card_payments: card ? { status: card, status_details: cardDetails } : null, stripe_balance: { payouts: { status: payouts, status_details: payoutDetails } }
          } } }
        });
      }
      case '/oauth/token':
        if (provider.failOAuthOnce) throw new Error('one-time code exchange uncertain');
        return Response.json({
          stripe_user_id: provider.nextOAuthId, livemode: provider.liveOAuth, scope: 'read_write',
          access_token: 'oauth-secret-fixture', refresh_token: 'refresh-secret-fixture'
        });
      case '/v1/accounts/' + oauthId:
        if (provider.denied) return new Response(null, { status: 403 });
        return Response.json({ id: oauthId, object: 'account', type: 'standard', charges_enabled: true, payouts_enabled: true });
      default: throw new Error('Unexpected Stripe request.');
    }
  }
  const adapter = createStripeSetup({ env, origin, now: () => time, fetchImpl, ...options });
  return { adapter, calls, context, owners, provider, fetchImpl, advance: ms => { time += ms; } };
}

test('hosted setup creates once across interruptions and collects currently due requirements without guessing identity', async () => {
  const { adapter, context, provider, calls } = fixture();
  const ctx = context();
  provider.failCreateOnce = true;
  await assert.rejects(adapter.start(ctx, 'new', 'US'), StripeSetupError);
  ctx.verifiedEmail = 'changed@example.test';
  const redirect = await adapter.start(ctx, 'resume');
  assert.equal(new URL(redirect.redirect).hostname, 'accounts.stripe.com');
  const creates = calls.filter(c => c.path === '/v2/core/accounts');
  assert.equal(creates.length, 2);
  assert.ok(ctx.checkpoints[0].createRequest.key);
  assert.equal(creates[0].idempotency, creates[1].idempotency);
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(creates[0].body.contact_email, 'filmmaker@example.test');
  assert.equal(creates[0].body.dashboard, 'full');
  assert.deepEqual(creates[0].body.configuration, { merchant: { capabilities: { card_payments: { requested: true } } } });
  assert.deepEqual(creates[0].body.identity, { country: 'us' });
  const link = calls.at(-1).body.use_case.account_onboarding;
  assert.equal(link.configurations, undefined);
  assert.deepEqual(link.collection_options, { fields: 'currently_due' });
  const params = new URL(link.return_url).searchParams;
  assert.equal(new URL(link.refresh_url).origin, origin);
  assert.ok(!JSON.stringify(ctx.state).includes(params.get('state')));
  assert.deepEqual(await adapter.callback(ctx, 'return', params), { status: 'pending' });
  await assert.rejects(adapter.callback(ctx, 'return', params), /already used/);
  Object.assign(provider.snapshot, { card: 'active', payouts: 'active', due: 'currently_due' });
  assert.deepEqual(await adapter.refresh(ctx), { status: 'action_required' });
  provider.snapshot.due = null;
  assert.deepEqual(await adapter.start(ctx, 'new'), { status: 'ready' });
  assert.ok(ctx.state.chargesEnabled && ctx.state.payoutsEnabled);
  provider.denied = true;
  await assert.rejects(adapter.refresh(ctx), StripeSetupError);
  assert.equal(ctx.state.status, 'unavailable');
  assert.equal(ctx.state.businessName, 'Projection Studio');
  assert.ok(!ctx.state.chargesEnabled && !ctx.state.payoutsEnabled);
});

test('refresh links rotate once for their original filmmaker, account and environment', async () => {
  const f = fixture();
  const ctx = f.context();
  await f.adapter.start(ctx, 'reuse', 'GB');
  const link = () => new URL(f.calls.at(-1).body.use_case.account_onboarding.refresh_url).searchParams;
  const first = link();
  await assert.rejects(f.adapter.callback({ ...ctx, creatorId: 'different' }, 'refresh', first), /setup link/);
  const other = createStripeSetup({ origin, env: { ...env, STRIPE_CONNECT_SECRET_KEY: 'sk_test_different' }, fetchImpl: f.fetchImpl });
  await assert.rejects(other.callback(ctx, 'refresh', first), /setup link/);
  await assert.rejects(f.adapter.callback(ctx, 'oauth', first), /setup link/);
  await f.adapter.callback(ctx, 'refresh', first);
  const next = link();
  assert.notEqual(first.get('state'), next.get('state'));
  await assert.rejects(f.adapter.callback(ctx, 'return', first), /setup link/);
  f.advance(2 * 3600_000);
  await assert.rejects(f.adapter.callback(ctx, 'return', next), /setup link/);
  assert.equal(f.calls.filter(c => c.path === '/v2/core/accounts').length, 1);
});

test('existing Standard OAuth binds only the provider-confirmed account, once and to one filmmaker', async () => {
  const f = fixture();
  const ctx = f.context();
  const redirect = new URL((await f.adapter.start(ctx, 'existing')).redirect);
  assert.equal(redirect.origin + redirect.pathname, 'https://connect.stripe.com/oauth/authorize');
  assert.equal(redirect.searchParams.get('redirect_uri'), origin + '/setup/stripe/oauth');
  assert.equal(redirect.searchParams.get('scope'), 'read_write');
  const params = new URLSearchParams({ state: redirect.searchParams.get('state'), code: 'ac_test_example', account: 'acct_wrong' });
  assert.deepEqual(await f.adapter.callback(ctx, 'oauth', params), { status: 'ready' });
  assert.equal(ctx.state.accountId, oauthId);
  assert.ok(!JSON.stringify(ctx.checkpoints).includes('oauth-secret-fixture'));
  assert.ok(!JSON.stringify(ctx.checkpoints).includes('refresh-secret-fixture'));
  await assert.rejects(f.adapter.callback(ctx, 'oauth', params), /already used/);
  assert.equal(f.calls.filter(c => c.path === '/oauth/token').length, 1);
  const other = f.context('creator-two');
  const another = new URL((await f.adapter.start(other, 'existing')).redirect);
  params.set('state', another.searchParams.get('state'));
  await assert.rejects(f.adapter.callback(other, 'oauth', params), /another filmmaker/);
  assert.equal(other.state.accountId, undefined);
  f.provider.denied = true;
  await assert.rejects(f.adapter.refresh(ctx), StripeSetupError);
  const reconnect = new URL((await f.adapter.start(ctx, 'resume')).redirect);
  assert.equal(reconnect.pathname, '/oauth/authorize');
  f.provider.nextOAuthId = 'acct_another';
  params.set('state', reconnect.searchParams.get('state'));
  await assert.rejects(f.adapter.callback(ctx, 'oauth', params), /already associated/);
  assert.equal(ctx.state.accountId, oauthId);
});

test('an uncertain OAuth exchange, denied authorization or mismatched mode cannot create access', async () => {
  const f = fixture(), ctx = f.context();
  const begin = async () => {
    const url = new URL((await f.adapter.start(ctx, 'existing')).redirect);
    return new URLSearchParams({ state: url.searchParams.get('state'), code: 'ac_test_example' });
  };
  const first = await begin();
  f.provider.failOAuthOnce = true;
  await assert.rejects(f.adapter.callback(ctx, 'oauth', first), StripeSetupError);
  await assert.rejects(f.adapter.callback(ctx, 'oauth', first), /already used/);
  assert.equal(f.calls.filter(c => c.path === '/oauth/token').length, 1);
  assert.equal(ctx.checkpoints.at(-1).flow, undefined);
  f.provider.failOAuthOnce = false;
  const canceled = await begin();
  canceled.set('error', 'access_denied');
  assert.deepEqual(await f.adapter.callback(ctx, 'oauth', canceled), { status: 'unconnected' });
  f.provider.liveOAuth = true;
  await assert.rejects(f.adapter.callback(ctx, 'oauth', await begin()), StripeSetupError);
  assert.equal(ctx.state.accountId, undefined);
});

test('available paths and credentials match the operator’s configured environment', async () => {
  const noOAuth = fixture({ env: { STRIPE_CONNECT_SECRET_KEY: env.STRIPE_CONNECT_SECRET_KEY } });
  assert.ok(noOAuth.adapter.configured && !noOAuth.adapter.existingOAuth);
  const fallback = noOAuth.context();
  assert.deepEqual(await noOAuth.adapter.start(fallback, 'existing'), { countryRequired: true });
  await noOAuth.adapter.start(fallback, 'existing', 'CA');
  assert.equal(noOAuth.calls[0].path, '/v2/core/accounts');
  const insecure = fixture({ env: { STRIPE_CONNECT_SECRET_KEY: 'sk_live_fixture', STRIPE_CONNECT_LIVE: '1' } });
  assert.equal(insecure.adapter.configured, false);
  await assert.rejects(insecure.adapter.start(insecure.context(), 'new'), StripeSetupError);
  assert.equal(insecure.calls.length, 0);
  const expired = fixture(), ctx = expired.context();
  expired.provider.failCreateOnce = true;
  await assert.rejects(expired.adapter.start(ctx, 'new', 'CA'), StripeSetupError);
  expired.advance(30 * 24 * 3600_000);
  await assert.rejects(expired.adapter.start(ctx, 'resume'), /reconcile/);
  assert.equal(expired.calls.length, 1);
  const targets = fixture();
  targets.provider.redirectHost = 'example.test';
  await assert.rejects(targets.adapter.start(targets.context(), 'new', 'FR'), StripeSetupError);
});

test('older hosted accounts missing card capability use a provider-confirmed country on explicit Resume', async () => {
  const f = fixture(), ctx = f.context();
  const changes = () => f.calls.filter(c => c.path === '/v2/core/accounts/' + id && c.body);
  await f.adapter.start(ctx, 'new', 'GB');
  Object.assign(f.provider.snapshot, { card: null, payouts: 'active', country: null });
  await f.adapter.refresh(ctx);
  assert.equal(ctx.state.status, 'action_required');
  assert.ok(ctx.state.needsCards);
  await f.adapter.start(ctx, 'resume');
  assert.equal(changes().length, 0);
  f.provider.snapshot.country = 'gb';
  await f.adapter.refresh(ctx);
  assert.equal(changes().length, 0);
  await f.adapter.start(ctx, 'resume');
  assert.equal(changes().length, 1);
  assert.deepEqual(changes()[0].body, { configuration: { merchant: { capabilities: { card_payments: { requested: true } } } } });
  f.provider.snapshot.card = 'restricted';
  await f.adapter.start(ctx, 'resume');
  assert.equal(changes().length, 1);
});

test('the card, status and callbacks use an independent state per Stripe mode', async () => {
  const stored = { mode: 'test', status: 'ready', accountId: id, creatorId: 'creator-one', flow: { digest: 'oldtestflow' } };
  const liveState = stripeSetupStateForMode(stored, 'live');
  assert.deepEqual(liveState, { mode: 'live', status: 'unconnected' });
  const testState = stripeSetupStateForMode(stored, 'test');
  assert.equal(testState.accountId, id);
  assert.equal(testState.status, 'ready');
  assert.equal(testState.flow.digest, 'oldtestflow');
  liveState.status = 'pending';
  assert.equal(stripeSetupStateForMode(stored, 'test').status, 'ready');
  assert.equal(stripeSetupStateForMode(stored, 'live').flow, undefined);
  assert.equal(stripeSetupStateForMode({ status: 'ready', accountId: id }, 'live').accountId, undefined);
  assert.throws(() => stripeSetupStateForMode(stored, 'other'));
});


test('a hosted create requires an explicit supported business country and persists its immutable request', async () => {
  const f = fixture(), ctx = f.context();
  for (const mode of ['new', 'reuse']) assert.deepEqual(await f.adapter.start(ctx, mode), { countryRequired: true });
  await assert.rejects(f.adapter.start(ctx, 'new', 'XX'), /Select your business country/);
  assert.equal(f.calls.length, 0);
  f.provider.failCreateOnce = true;
  await assert.rejects(f.adapter.start(ctx, 'new', 'Us'), StripeSetupError);
  const original = structuredClone(ctx.state.createRequest);
  assert.equal(original.country, 'us');
  await assert.rejects(f.adapter.start(ctx, 'new', 'GB'), /different country/);
  assert.deepEqual(ctx.state.createRequest, original);
  assert.equal(f.calls.length, 1);
  await f.adapter.start(ctx, 'resume');
  assert.equal(f.calls[1].idempotency, original.key);
  assert.deepEqual(f.calls[1].body.identity, { country: 'us' });
});

test('old create checkpoints replay their exact request and only replace a definitive no-country rejection', async () => {
  const environment = createHash('sha256').update(JSON.stringify([origin, 'test', env.STRIPE_CONNECT_SECRET_KEY])).digest('hex');
  for (const outcome of ['rejected', 'uncertain', 'already_created']) {
    const f = fixture(), ctx = f.context();
    ctx.state.createRequest = { key: 'legacy-operation', started: Date.now(), environment, email: 'original@example.test' };
    f.provider.failCreateOnce = outcome === 'uncertain';
    f.provider.legacySucceeded = outcome === 'already_created';
    const work = f.adapter.start(ctx, 'new', 'CA');
    if (outcome === 'uncertain') {
      await assert.rejects(work, StripeSetupError);
      assert.equal(ctx.state.createRequest.key, 'legacy-operation');
    } else {
      assert.ok((await work).redirect);
    }
    const creates = f.calls.filter(c => c.path === '/v2/core/accounts');
    assert.equal(creates[0].idempotency, 'legacy-operation');
    assert.equal(creates[0].body.contact_email, 'original@example.test');
    assert.deepEqual(creates[0].body.configuration, { merchant: {} });
    assert.equal(creates[0].body.identity, undefined);
    assert.equal(creates.length, outcome === 'rejected' ? 2 : 1);
    if (outcome === 'rejected') {
      assert.notEqual(creates[1].idempotency, creates[0].idempotency);
      assert.deepEqual(creates[1].body.identity, { country: 'ca' });
    }
  }
});

test('Stripe country-specific card restrictions leave a retryable workspace', async () => {
  const f = fixture(), ctx = f.context();
  f.provider.createError = 'capability_not_available_in_country';
  await assert.rejects(f.adapter.start(ctx, 'new', 'ID'), error => error.statusCode === 422);
  assert.equal(ctx.state.accountId, undefined);
  assert.equal(ctx.state.createRequest, undefined);
  f.provider.createError = null;
  assert.deepEqual(await f.adapter.start(ctx, 'new'), { countryRequired: true });
  await f.adapter.start(ctx, 'new', 'GB');
  assert.notEqual(f.calls[0].idempotency, f.calls[1].idempotency);
});


test('mixed required capabilities surface the next action before a pending review', async () => {
  const f = fixture(), ctx = f.context();
  await f.adapter.start(ctx, 'new', 'US');
  for (const [snapshot, expected, reason] of [
    [{ card: 'unsupported', payouts: 'pending' }, 'restricted', /does not support card payments/],
    [{ card: 'pending', payouts: 'rejected' }, 'restricted', /rejected payouts/],
    [{ card: 'pending', payouts: 'restricted', payoutDetails: [{ resolution: 'contact_stripe' }] }, 'restricted', /Contact Stripe support about payouts/],
    [{ card: 'restricted', cardDetails: [{ resolution: 'provide_info' }], payouts: 'pending' }, 'action_required'],
    [{ card: 'restricted', cardDetails: [{ resolution: 'no_resolution' }], payouts: 'pending' }, 'pending'],
    [{ card: 'active', payouts: 'active', due: 'currently_due',
      entries: [{ awaiting_action_from: 'stripe', minimum_deadline: { status: 'currently_due' } }] }, 'pending'],
    [{ card: 'active', payouts: 'active', due: 'past_due',
      entries: [{ awaiting_action_from: 'user', minimum_deadline: { status: 'past_due' } }] }, 'action_required'],
    [{ card: 'active', payouts: 'active' }, 'ready']
  ]) {
    f.provider.snapshot = snapshot;
    assert.deepEqual(await f.adapter.refresh(ctx), { status: expected });
    if (reason) assert.match(ctx.state.reason, reason);
    else assert.equal(ctx.state.reason, undefined);
  }
});


test('post-submit Stripe review overrides a stale past-due capability instruction only for Stripe-owned requirements', async () => {
  const f = fixture(), ctx = f.context();
  await f.adapter.start(ctx, 'new', 'US');
  const entry = (deadline, actor, errors = []) => ({ minimum_deadline: { status: deadline }, awaiting_action_from: actor, errors });
  const submitted = { card: 'restricted', payouts: 'pending', due: 'past_due',
    cardDetails: [{ code: 'requirements_past_due', resolution: 'provide_info' }],
    payoutDetails: [{ code: 'requirements_pending_verification', resolution: 'no_resolution' }],
    entries: [entry('past_due', 'stripe'), entry('currently_due', 'stripe'), entry('eventually_due', 'user')] };
  f.provider.snapshot = submitted;
  assert.deepEqual(await f.adapter.refresh(ctx), { status: 'pending' });
  assert.equal(ctx.state.chargesEnabled, false);
  assert.equal(ctx.state.payoutsEnabled, false);
  const stripe = { ...ctx.state, configured: true, hasAccount: true };
  const html = renderSettingsPage({ csrf: 'token', stripe });
  assert.match(html, /Under review/);
  assert.match(html, /Check Stripe status/);
  assert.doesNotMatch(html, /Continue on Stripe to review|Continue Stripe setup|action="\/setup\/stripe\/start"/);
  for (const [update, status] of [
    [{ entries: [entry('past_due', 'stripe'), entry('currently_due', 'user')] }, 'action_required'],
    [{ entries: [entry('past_due', 'stripe', [{ code: 'document_invalid' }])] }, 'action_required'],
    [{ entries: undefined }, 'action_required'],
    [{ entries: [entry('currently_due', 'stripe')] }, 'action_required'],
    [{ cardDetails: [{ code: 'restricted_other', resolution: 'provide_info' }] }, 'action_required'],
    [{ card: 'rejected' }, 'restricted']
  ]) {
    f.provider.snapshot = { ...submitted, ...update };
    assert.equal((await f.adapter.refresh(ctx)).status, status);
  }
});

test('marketplace filmmakers can enable transfers during new setup and on a previously connected account',async () => {
  const envWithTax={...env,STREAM_STRIPE_TAX_MODE:'marketplace'};
  const fresh=fixture({env:envWithTax});
  await fresh.adapter.start(fresh.context(),'new','US');
  assert.equal(fresh.calls.find(call=>call.path==='/v2/core/accounts').body.configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested,true);
  const f=fixture({env:envWithTax}), ctx=f.context();
  const auth=new URL((await f.adapter.start(ctx,'existing')).redirect);
  assert.deepEqual(await f.adapter.callback(ctx,'oauth',new URLSearchParams({code:'ac_test',state:auth.searchParams.get('state')})),{status:'action_required'});
  assert.equal(ctx.state.needsTransfers,true);
  assert.deepEqual(await f.adapter.start(ctx,'resume'),{status:'ready'});
  assert.equal(ctx.state.needsTransfers,false);
  assert.equal(f.calls.filter(call=>call.body?.configuration?.recipient).length,1);
});
