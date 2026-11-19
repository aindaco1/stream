import { randomUUID } from 'node:crypto';
import { randomToken, sha256Hex, timingSafeEqual } from '@dustwave/worker-core/crypto';
import { readBoundedJson } from '@dustwave/worker-core/response-body';

const API = 'https://api.stripe.com';
const CONNECT = 'https://connect.stripe.com';
const VERSION = '2026-10-28.endive';
const ACCOUNT_ID = /^acct_[a-zA-Z0-9]{3,100}$/;
// Direct Stripe markets on stripe.com/global. Stripe checks the platform's actual
// cross-border eligibility and card-payment capability when it creates the account.
export const stripeBusinessCountries = Object.freeze(
  'AE AT AU BE BG BR CA CH CY CZ DE DK EE ES FI FR GB GI GR HK HR HU ID IE IN IT JP LI LT LU LV MT MX MY NL NO NZ PL PT RO SE SG SI SK TH US'.split(' ')
);
const countryRejections = new Set([
  'country_unsupported', 'country_not_supported', 'capability_not_available_in_country',
  'capability_not_available_in_platform_country', 'cross_border_connected_account_creation_not_allowed'
]);
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

function hostedPaymentStatus(account) {
  const caps = account.configuration?.merchant?.capabilities;
  const capabilities = [['card payments', caps?.card_payments], ['payouts', caps?.stripe_balance?.payouts]];
  const flags = { chargesEnabled: caps?.card_payments?.status === 'active',
    payoutsEnabled: caps?.stripe_balance?.payouts?.status === 'active', needsCards: Boolean(caps && !caps.card_payments) };
  for (const [name, cap] of capabilities) {
    if (cap?.status === 'unsupported' || cap?.status === 'rejected') {
      const reason = cap.status === 'unsupported' ? `Stripe does not support ${name} for this account.` :
        `Stripe rejected ${name} for this account. Review the decision in your Stripe Dashboard.`;
      return { ...flags, status: 'restricted', reason };
    }
    if (cap?.status_details?.some(detail => detail.resolution === 'contact_stripe')) {
      return { ...flags, status: 'restricted', reason: `Contact Stripe support about ${name} for this account.` };
    }
  }

  const isDue = deadline => ['currently_due', 'past_due'].includes(deadline?.status);
  const summary = account.requirements?.summary?.minimum_deadline;
  const entries = account.requirements?.entries || [];
  const dueEntries = entries.filter(entry => isDue(entry.minimum_deadline));
  const hasErrors = entries.some(entry => entry.errors?.length);
  const awaitingStripe = isDue(summary) && !hasErrors &&
    dueEntries.some(entry => entry.minimum_deadline.status === summary.status) &&
    dueEntries.every(entry => entry.awaiting_action_from === 'stripe');
  const restricted = capabilities.filter(([, cap]) => cap?.status === 'restricted');
  function needsUser(detail) {
    if (detail.resolution === 'no_resolution') return false;
    // Stripe can retain the past-due capability reason while it reviews every
    // submitted requirement. Other restrictions still require their own action.
    return !(awaitingStripe && detail.code === 'requirements_past_due' && detail.resolution === 'provide_info');
  }
  const requiresAction = restricted.some(([, cap]) => !cap.status_details?.length || cap.status_details.some(needsUser));
  const reason = flags.needsCards ? 'Continue setup to enable card payments for this business in Stripe.' : undefined;
  if (flags.needsCards || hasErrors || requiresAction || (isDue(summary) && !awaitingStripe)) {
    return { ...flags, status: 'action_required', reason };
  }
  if (awaitingStripe || restricted.length || capabilities.some(([, cap]) => cap?.status === 'pending')) {
    return { ...flags, status: 'pending', reason };
  }
  return { ...flags, status: flags.chargesEnabled && flags.payoutsEnabled ? 'ready' : 'action_required', reason };
}

// Each ctx belongs to the authenticated creator. The persistent context guards
// its checkpoints, ownership claims and redirects against concurrent resets.
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
      const problem = unavailable();
      problem.providerStatus = response.status;
      // Provider text can contain private information. Only a machine code is
      // used to distinguish a definitive rejection from an uncertain create.
      const errorBody = await readBoundedJson(response, 16 * 1024).catch(() => null);
      const code = errorBody?.error?.code || errorBody?.error?.type;
      if (typeof code === 'string' && /^[a-z_]{1,100}$/.test(code)) problem.providerCode = code;
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

  async function ensureHostedAccount(ctx, country) {
    const state = ctx.state;
    if (state.accountId) return claim(ctx, state.accountId);
    const environment = await sha256Hex(JSON.stringify([base, mode, secret]));
    if (!state.createRequest) {
      const email = ctx.verifiedEmail;
      state.createRequest = { key: randomUUID(), environment, started: now(), country,
        ...(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}) };
      await ctx.save();
    }
    const op = state.createRequest;
    if (op.environment !== environment || now() - op.started >= ACCOUNT_RETRY_WINDOW) {
      throw new StripeSetupError('Ask the platform operator to reconcile the previous account creation before continuing.', 409);
    }
    if (op.country && country && op.country !== country) {
      throw new StripeSetupError('An account request is already in progress with a different country. Resume its original request.', 409);
    }
    // Older checkpoints predate country collection. Replay their original
    // parameters and key before issuing a new create under a different key.
    const merchant = op.country ? { capabilities: { card_payments: { requested: true } } } : {};
    let account;
    try {
      account = await request(API + '/v2/core/accounts', { idempotency: op.key, body: {
        dashboard: 'full', configuration: { merchant },
        defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        metadata: { application: 'dust-wave-stream', creator: await sha256Hex(ctx.creatorId) },
        ...(op.email ? { contact_email: op.email } : {}),
        ...(op.country ? { identity: { country: op.country } } : {})
      } });
    } catch (error) {
      const legacyRejected = !op.country && country && error.providerCode === 'identity_country_required';
      const countryRejected = op.country && countryRejections.has(error.providerCode);
      if (error.providerStatus !== 400 || (!legacyRejected && !countryRejected)) throw error;
      delete state.createRequest;
      await ctx.save();
      if (countryRejected) throw new StripeSetupError('Stripe cannot enable card payments for this account and business country. Check your selection or contact Dust Wave.', 422);
      return ensureHostedAccount(ctx, country);
    }
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

  async function hosted(ctx, country) {
    await ensureHostedAccount(ctx, country);
    const token = await issueState(ctx, 'hosted');
    const link = await request(API + '/v2/core/account_links', { idempotency: randomUUID(), body: {
      account: ctx.state.accountId, use_case: { type: 'account_onboarding', account_onboarding: {
        collection_options: { fields: 'currently_due' },
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
      if (hostedAccount) {
        Object.assign(state, hostedPaymentStatus(account));
      } else {
        if (account.type !== 'standard' && account.controller?.stripe_dashboard?.type !== 'full') throw unavailable();
        state.chargesEnabled = account.charges_enabled === true;
        state.payoutsEnabled = account.payouts_enabled === true;
        const req = account.requirements || {};
        const action = Boolean(req.currently_due?.length || req.past_due?.length ||
          (req.disabled_reason && req.disabled_reason !== 'requirements.pending_verification'));
        const pending = Boolean(req.pending_verification?.length || req.disabled_reason === 'requirements.pending_verification');
        if (action) state.status = 'action_required';
        else if (state.chargesEnabled && state.payoutsEnabled) state.status = 'ready';
        else state.status = pending ? 'pending' : 'action_required';
      }
      const name = hostedAccount ? account.display_name : account.business_profile?.name;
      state.businessName = typeof name === 'string' ? name.trim().slice(0, 150) : undefined;
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
    // Older bound accounts may lack the card capability. On explicit resume,
    // request it only when Stripe reports the account's country.
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

  async function start(ctx, intent, requestedCountry) {
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
    const chosen = typeof requestedCountry === 'string' ? requestedCountry.trim().toUpperCase() : '';
    if (chosen && !stripeBusinessCountries.includes(chosen)) {
      throw new StripeSetupError('Select your business country from the available countries.', 422);
    }
    if (!chosen && !ctx.state.createRequest?.country) return { countryRequired: true };
    return hosted(ctx, chosen ? chosen.toLowerCase() : ctx.state.createRequest.country);
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
      try {
        const result = await action(ctx, ...args);
        ctx.assertCurrent?.();
        return result;
      }
      catch (error) { throw error instanceof StripeSetupError ? error : unavailable(); }
    };
  }

  return { configured, existingOAuth, start: guarded(start), callback: guarded(callback), refresh: guarded(refresh) };
}
