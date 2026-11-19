import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeSetup, StripeSetupError, stripeSetupStateForMode } from '../src/setup-stripe.js';

const origin = 'http://127.0.0.1:8787';
const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_fixture', STRIPE_CONNECT_CLIENT_ID: 'ca_fixture' };
const id = 'acct_test123';
const oauthId = 'acct_existing123';

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
        return Response.json({ object: 'v2.core.account', id, livemode: false });
      case '/v2/core/account_links':
        return Response.json({
          account: body.account, object: 'v2.core.account_link', livemode: false,
          url: 'https://' + provider.redirectHost + '/r/private-account-link'
        });
      case '/v2/core/accounts/' + id: {
        if (provider.denied) return new Response(null, { status: 403 });
        const { card, payouts, due } = provider.snapshot;
        return Response.json({
          id, object: 'v2.core.account', livemode: false, display_name: 'Projection Studio', identity: { country: provider.snapshot.country },
          requirements: { summary: { minimum_deadline: { status: due } } },
          configuration: { merchant: { capabilities: {
            card_payments: card ? { status: card } : null, stripe_balance: { payouts: { status: payouts } }
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
  await assert.rejects(adapter.start(ctx, 'new'), StripeSetupError);
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
  assert.deepEqual(creates[0].body.configuration, { merchant: {} });
  assert.equal(creates[0].body.identity, undefined);
  const link = calls.at(-1).body.use_case.account_onboarding;
  assert.deepEqual(link.configurations, ['merchant']);
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
  await f.adapter.start(ctx, 'reuse');
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
  await noOAuth.adapter.start(noOAuth.context(), 'existing');
  assert.equal(noOAuth.calls[0].path, '/v2/core/accounts');
  const insecure = fixture({ env: { STRIPE_CONNECT_SECRET_KEY: 'sk_live_fixture', STRIPE_CONNECT_LIVE: '1' } });
  assert.equal(insecure.adapter.configured, false);
  await assert.rejects(insecure.adapter.start(insecure.context(), 'new'), StripeSetupError);
  assert.equal(insecure.calls.length, 0);
  const expired = fixture(), ctx = expired.context();
  expired.provider.failCreateOnce = true;
  await assert.rejects(expired.adapter.start(ctx, 'new'), StripeSetupError);
  expired.advance(30 * 24 * 3600_000);
  await assert.rejects(expired.adapter.start(ctx, 'resume'), /reconcile/);
  assert.equal(expired.calls.length, 1);
  const targets = fixture();
  targets.provider.redirectHost = 'example.test';
  await assert.rejects(targets.adapter.start(targets.context(), 'new'), StripeSetupError);
});

test('hosted card capability waits for the country Stripe collected and an explicit Resume', async () => {
  const f = fixture(), ctx = f.context();
  const changes = () => f.calls.filter(c => c.path === '/v2/core/accounts/' + id && c.body);
  await f.adapter.start(ctx, 'new');
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
