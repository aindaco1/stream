import { randomUUID } from 'node:crypto';
import { randomToken, sha256Hex, timingSafeEqual } from '@dustwave/worker-core/crypto';
import { readBoundedJson } from '@dustwave/worker-core/response-body';

const API = 'https://api.stripe.com';
const CONNECT = 'https://connect.stripe.com';
const VERSION = '2026-10-28.endive';
const ACCOUNT_ID = /^acct_[a-zA-Z0-9]{3,100}$/;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const ACCOUNT_RETRY_WINDOW = 29 * 24 * 60 * 60 * 1000;

export class StripeSetupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'StripeSetupError';
    this.statusCode = statusCode;
  }
}
const unavailable = () => new StripeSetupError('Stripe could not verify the connection. Try again.', 503);
const restart = () => new StripeSetupError('This setup link has expired or was already used. Continue from the Stripe setup card.', 409);

function safeOrigin(value, live) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== value || url.username || url.password) return null;
    if (url.protocol === 'https:' || (!live && loopback && url.protocol === 'http:')) return url.origin;
  } catch {}
  return null;
}

// Keep test and live account IDs, pending callbacks and ready badges independent.
export function stripeSetupStateForMode(stored, mode) {
  if (!['test', 'live'].includes(mode)) throw new TypeError('Invalid Stripe mode.');
  if (!stored.byMode) {
    const previous = { ...stored };
    for (const field of Object.keys(stored)) delete stored[field];
    stored.byMode = {};
    if (['test', 'live'].includes(previous.mode)) stored.byMode[previous.mode] = previous;
  }
  return stored.byMode[mode] ??= { mode, status: 'unconnected' };
}

// Each ctx belongs to the authenticated creator. The caller serializes its
// mutations, checkpoints save() atomically and enforces uniqueness in claimAccount().
export function createStripeSetup({ env = process.env, origin, fetchImpl = fetch, now = Date.now }) {
  const secret = env.STRIPE_CONNECT_SECRET_KEY || '';
  const mode = env.STRIPE_CONNECT_LIVE === '1' ? 'live' : 'test';
  const live = mode === 'live';
  const base = safeOrigin(origin, live);
  const configured = Boolean(base && /^(sk|rk)_(test|live)_[a-zA-Z0-9]+$/.test(secret) && secret.split('_')[1] === mode);
  const clientId = env.STRIPE_CONNECT_CLIENT_ID || '';
  const existingOAuth = configured && /^ca_[a-zA-Z0-9]+$/.test(clientId);
  const callbackUrl = kind => base + '/setup/stripe/' + kind;

  async function request(url, { body, idempotency, oauth = false } = {}) {
    const headers = { Authorization: oauth ? 'Basic ' + btoa(secret + ':') : 'Bearer ' + secret };
    if (!oauth) headers['Stripe-Version'] = VERSION;
    if (body) headers['Content-Type'] = oauth ? 'application/x-www-form-urlencoded' : 'application/json';
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: body ? (oauth ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined
    });
    if (!response.ok) {
      await response.body?.cancel();
      const problem = unavailable();
      problem.providerStatus = response.status;
      throw problem;
    }
    return readBoundedJson(response, 256 * 1024);
  }

  async function claim(ctx, id) {
    if (await ctx.claimAccount(id, mode) === false) {
      throw new StripeSetupError('This Stripe account is associated with another filmmaker.', 409);
    }
  }

  async function bind(ctx, id, channel) {
    if (!ACCOUNT_ID.test(id) || (ctx.state.accountId && ctx.state.accountId !== id)) {
      throw new StripeSetupError('Choose the Stripe account already associated with this filmmaker.', 409);
    }
    await claim(ctx, id);
    Object.assign(ctx.state, { accountId: id, channel, status: channel === 'hosted' ? 'action_required' : 'pending', needsReconnect: false });
    delete ctx.state.createRequest;
    await ctx.save();
  }

  async function ensureHostedAccount(ctx) {
    const state = ctx.state;
    if (state.accountId) return claim(ctx, state.accountId);
    const environment = await sha256Hex(JSON.stringify([base, mode, secret]));
    if (!state.createRequest) {
      const email = ctx.verifiedEmail;
      state.createRequest = { key: randomUUID(), environment, started: now(),
        ...(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}) };
      await ctx.save();
    }
    const op = state.createRequest;
    if (op.environment !== environment || now() - op.started >= ACCOUNT_RETRY_WINDOW) {
      throw new StripeSetupError('Ask the platform operator to reconcile the previous account creation before continuing.', 409);
    }
    const account = await request(API + '/v2/core/accounts', { idempotency: op.key, body: {
      dashboard: 'full', configuration: { merchant: {} },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      metadata: { application: 'dust-wave-stream', creator: await sha256Hex(ctx.creatorId) },
      ...(op.email ? { contact_email: op.email } : {})
    } });
    if (account?.object !== 'v2.core.account' || account.livemode !== live || !ACCOUNT_ID.test(account.id)) throw unavailable();
    await bind(ctx, account.id, 'hosted');
  }

  function flowDigest(ctx, kind, raw) {
    return sha256Hex(JSON.stringify([ctx.creatorId, mode, base, secret, kind, raw]));
  }

  async function issueState(ctx, kind) {
    const raw = randomToken(32);
    // A Stripe key rotation invalidates outstanding redirects. Connected account
    // IDs survive rotation and are subsequently verified using the new key.
    const digest = await flowDigest(ctx, kind, raw);
    ctx.state.flow = { kind, digest, expires: now() + TWO_HOURS, account: ctx.state.accountId || null };
    await ctx.save();
    return raw;
  }

  async function hosted(ctx) {
    await ensureHostedAccount(ctx);
    const token = await issueState(ctx, 'hosted');
    const link = await request(API + '/v2/core/account_links', { idempotency: randomUUID(), body: {
      account: ctx.state.accountId, use_case: { type: 'account_onboarding', account_onboarding: {
        configurations: ['merchant'], collection_options: { fields: 'currently_due' },
        return_url: callbackUrl('return') + '?state=' + token,
        refresh_url: callbackUrl('refresh') + '?state=' + token
      } }
    } });
    if (link?.object !== 'v2.core.account_link' || link.account !== ctx.state.accountId || link.livemode !== live) throw unavailable();
    const target = new URL(link.url);
    if (target.origin !== 'https://accounts.stripe.com' && target.origin !== 'https://connect.stripe.com') throw unavailable();
    if (target.username || target.password) throw unavailable();
    return { redirect: target.href };
  }

  async function oauthStart(ctx) {
    const url = new URL('/oauth/authorize', CONNECT);
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: 'read_write',
      redirect_uri: callbackUrl('oauth'), state: await issueState(ctx, 'oauth') }).toString();
    return { redirect: url.href };
  }

  async function refresh(ctx) {
    const state = ctx.state;
    if (!state.accountId) return { status: 'unconnected' };
    if (!ACCOUNT_ID.test(state.accountId) || !['oauth', 'hosted'].includes(state.channel)) throw unavailable();
    // Recheck the unique ownership claim before reading or operating the account.
    await claim(ctx, state.accountId);
    const hostedAccount = state.channel === 'hosted';
    const href = hostedAccount
      ? '/v2/core/accounts/' + state.accountId + '?include[0]=configuration.merchant&include[1]=requirements'
      : '/v1/accounts/' + state.accountId;
    try {
      const account = await request(API + href);
      const object = hostedAccount ? 'v2.core.account' : 'account';
      if (account?.id !== state.accountId || account.object !== object || account.deleted === true ||
          (hostedAccount ? account.livemode !== live : account.livemode !== undefined && account.livemode !== live)) throw unavailable();
      let action, pending;
      if (hostedAccount) {
        const caps = account.configuration?.merchant?.capabilities;
        state.chargesEnabled = caps?.card_payments?.status === 'active';
        state.payoutsEnabled = caps?.stripe_balance?.payouts?.status === 'active';
        state.needsCards = Boolean(caps && !caps.card_payments);
        state.reason = state.needsCards ? 'Continue setup to enable card payments for this business in Stripe.' : undefined;
        if (caps?.card_payments?.status === 'unsupported') state.reason = 'Stripe reports this account does not support card payments.';
        const due = account.requirements?.summary?.minimum_deadline?.status;
        action = ['currently_due', 'past_due'].includes(due);
        pending = [caps?.card_payments?.status, caps?.stripe_balance?.payouts?.status].includes('pending');
      } else {
        if (account.type !== 'standard' && account.controller?.stripe_dashboard?.type !== 'full') throw unavailable();
        state.chargesEnabled = account.charges_enabled === true;
        state.payoutsEnabled = account.payouts_enabled === true;
        const req = account.requirements || {};
        action = Boolean(req.currently_due?.length || req.past_due?.length ||
          (req.disabled_reason && req.disabled_reason !== 'requirements.pending_verification'));
        pending = Boolean(req.pending_verification?.length || req.disabled_reason === 'requirements.pending_verification');
      }
      const name = hostedAccount ? account.display_name : account.business_profile?.name;
      state.businessName = typeof name === 'string' ? name.trim().slice(0, 150) : undefined;
      if (action || state.needsCards) state.status = 'action_required';
      else if (state.chargesEnabled && state.payoutsEnabled) state.status = 'ready';
      else state.status = pending ? 'pending' : 'action_required';
      state.checkedAt = new Date(now()).toISOString();
      state.needsReconnect = false;
    } catch (error) {
      Object.assign(state, { status: 'unavailable', chargesEnabled: false, payoutsEnabled: false });
      state.needsReconnect = !hostedAccount && [403, 404].includes(error.providerStatus);
      await ctx.save();
      throw unavailable();
    }
    await ctx.save();
    return { status: state.status };
  }

  async function requestMissingCards(ctx) {
    // The creator explicitly resumed payment setup. Let Stripe collect the
    // country first; requesting a capability earlier would lock country choice.
    const path = '/v2/core/accounts/' + ctx.state.accountId;
    const account = await request(API + path + '?include[0]=identity&include[1]=configuration.merchant');
    if (account?.id !== ctx.state.accountId || account.object !== 'v2.core.account' || account.livemode !== live) throw unavailable();
    const caps = account.configuration?.merchant?.capabilities;
    if (!caps || caps.card_payments || !/^[a-z]{2}$/i.test(account.identity?.country || '')) return;
    const updated = await request(API + path, {
      idempotency: 'stream-card-payments-' + account.id,
      body: { configuration: { merchant: { capabilities: { card_payments: { requested: true } } } } }
    });
    if (updated?.id !== account.id || updated.object !== 'v2.core.account' || updated.livemode !== live) throw unavailable();
  }

  async function start(ctx, intent) {
    if (!['new', 'existing', 'resume', 'reuse'].includes(intent)) throw new StripeSetupError('Choose an available Stripe setup option.');
    if (ctx.state.accountId) {
      if (ctx.state.needsReconnect && ctx.state.channel === 'oauth' && existingOAuth) return oauthStart(ctx);
      const status = await refresh(ctx);
      if (status.status === 'ready') return status;
      if (ctx.state.channel === 'oauth') return { redirect: 'https://dashboard.stripe.com/' };
      if (intent === 'resume' && ctx.state.needsCards) await requestMissingCards(ctx);
      return hosted(ctx);
    }
    if (!ctx.state.createRequest && intent === 'existing' && existingOAuth) return oauthStart(ctx);
    return hosted(ctx);
  }

  async function callback(ctx, kind, params) {
    const flow = ctx.state.flow;
    const raw = params.get('state') || '';
    if (!['return', 'refresh', 'oauth'].includes(kind) || !flow || flow.expires <= now() || !/^[A-Za-z0-9_-]{43}$/.test(raw) ||
        flow.kind !== (kind === 'oauth' ? 'oauth' : 'hosted') || flow.account !== (ctx.state.accountId || null)) throw restart();
    const digest = await flowDigest(ctx, flow.kind, raw);
    if (!timingSafeEqual(digest, flow.digest)) throw restart();
    // OAuth code exchange is NOT idempotent at Stripe: replay can revoke the
    // connection. Persist consumption before I/O and reauthorize on uncertainty.
    delete ctx.state.flow;
    await ctx.save();
    if (kind === 'refresh') return hosted(ctx);
    if (kind === 'return') return refresh(ctx);
    if (params.get('error') === 'access_denied') return { status: ctx.state.status };
    const code = params.get('code') || '';
    if (!existingOAuth || !/^[a-zA-Z0-9_-]{1,512}$/.test(code) || params.has('error')) throw restart();
    const token = await request(CONNECT + '/oauth/token', {
      oauth: true, body: { grant_type: 'authorization_code', code }
    });
    if (token?.scope !== 'read_write' || token.livemode !== live || !ACCOUNT_ID.test(token.stripe_user_id)) throw restart();
    // Stripe-Account plus the platform key is sufficient. Discard OAuth tokens.
    await bind(ctx, token.stripe_user_id, 'oauth');
    return refresh(ctx);
  }

  function guarded(action) {
    return async (ctx, ...args) => {
      if (!configured) throw new StripeSetupError('Stripe Connect setup is unavailable. Ask the platform operator to enable it.', 503);
      const state = ctx?.state;
      if (typeof ctx?.creatorId !== 'string' || !ctx.creatorId || !state || typeof state !== 'object') throw restart();
      if ((state.creatorId && state.creatorId !== ctx.creatorId) || (state.mode && state.mode !== mode) ||
          (state.accountId && (!state.creatorId || !state.mode))) throw restart();
      state.creatorId = ctx.creatorId;
      state.mode = mode;
      state.status ??= 'unconnected';
      try { return await action(ctx, ...args); }
      catch (error) { throw error instanceof StripeSetupError ? error : unavailable(); }
    };
  }

  return { configured, existingOAuth, start: guarded(start), callback: guarded(callback), refresh: guarded(refresh) };
}
