import { readBoundedJson, readBoundedText } from '@dustwave/worker-core/response-body';
import { stripeSecretMode, publishableKeyMode } from './stripe-mode.js';
import { importTaxFeeReport } from './tax-fee-report.js';
import { viewerWebhookEvents } from './viewer-checkout.js';

const reportType = 'all_fees.incurred_at.itemized.2';
const day = 86400;
const api = 'https://api.stripe.com/v1/';

async function response(key, url, fetchImpl, options = {}) {
  const result = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version':'2026-10-28.endive', ...options.headers } });
  if (!result.ok) {
    await result.body?.cancel();
    throw Error('Stripe ' + new URL(url).pathname + ' returned HTTP ' + result.status + '.');
  }
  return result;
}

async function get(key, path, fetchImpl) {
  return readBoundedJson(await response(key, api + path, fetchImpl), 512 * 1024);
}

async function downloadReport(key, id, fetchImpl) {
  if (!/^file_[A-Za-z0-9]+$/.test(id)) throw Error('Invalid Stripe report file.');
  const url = 'https://files.stripe.com/v1/files/' + id + '/contents';
  return readBoundedText(await response(key,url,fetchImpl),16 * 1024 * 1024);
}

async function list(key, path, fetchImpl) {
  const rows = [];
  let cursor;
  do {
    const url = new URL(api + path);
    url.searchParams.set('limit','100');
    if (cursor) url.searchParams.set('starting_after',cursor);
    const page = await readBoundedJson(await response(key, url, fetchImpl), 2 * 1024 * 1024);
    if (page?.object !== 'list' || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw Error('Unexpected Stripe list.');
    rows.push(...page.data);
    if (!page.has_more) return rows;
    const next = page.data.at(-1)?.id;
    if (!next || next === cursor || rows.length > 10000) throw Error('Incomplete Stripe list.');
    cursor = next;
  } while (cursor);
}

// Uses only GET requests. Signing secrets can be checked for presence here;
// a signed delivery must still exercise each endpoint in its own account scope.
export async function checkLiveStripe(env, fetchImpl = fetch) {
  const key = env.STRIPE_CONNECT_SECRET_KEY;
  if (stripeSecretMode(key) !== 'live' || publishableKeyMode(env.STRIPE_CONNECT_PUBLISHABLE_KEY) !== 'live') {
    throw Error('The live platform secret and publishable keys are required for readback.');
  }
  const origin = new URL(env.STREAM_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.STREAM_PUBLIC_ORIGIN) throw Error('Invalid public viewer origin.');
  const [account, settings, registrations, endpoints, fees] = await Promise.all([
    get(key,'account',fetchImpl), get(key,'tax/settings',fetchImpl), list(key,'tax/registrations?status=active',fetchImpl),
    list(key,'webhook_endpoints',fetchImpl), get(key,'reporting/report_types/' + reportType,fetchImpl)
  ]);
  const ready = path => endpoints.some(endpoint => endpoint.livemode === true && endpoint.status === 'enabled' &&
    endpoint.url === origin.origin + path && Array.isArray(endpoint.enabled_events) &&
    (endpoint.enabled_events.includes('*') || viewerWebhookEvents.every(type => endpoint.enabled_events.includes(type))));
  const connect = env.STRIPE_CONNECT_WEBHOOK_SECRET, platform = env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  return {
    platformAccount: account.object === 'account' ? account.id : null,
    chargesEnabled: account.charges_enabled === true, payoutsEnabled: account.payouts_enabled === true,
    taxSettingsActive: settings.object === 'tax.settings' && settings.livemode && settings.status === 'active',
    activeTaxLocations: registrations.filter(r => r.livemode && r.status === 'active')
      .map(r => r.country === 'US' && r.country_options?.us?.state ? 'US-' + r.country_options.us.state : r.country).sort(),
    connectWebhookEnabled: ready('/checkout/webhook'), platformWebhookEnabled: ready('/checkout/platform-webhook'),
    distinctSigningSecretsPresent: Boolean(connect?.startsWith('whsec_') && platform?.startsWith('whsec_') && connect !== platform),
    feesReportAvailable: fees.object === 'reporting.report_type' && fees.id === reportType && fees.livemode === true
  };
}

// A missing row remains pending. Stripe may take up to 96 hours to publish it.
// The daily idempotency key reuses one report per sales day across cold starts.
export async function syncTaxFeeReports(store, key, platform, {fetchImpl = fetch, now = Date.now()} = {}) {
  if (store.paymentMode !== 'live' || stripeSecretMode(key) !== 'live') throw Error('Live fee reporting requires the matching live ledger.');
  const days = [...new Set(store.pendingTaxFees(platform).map(order => Math.floor(order.paidAt / day) * day))].sort((a,b) => a-b);
  if (!days.length) return {checked:0, recorded:0};
  const type = await get(key,'reporting/report_types/' + reportType,fetchImpl);
  if (type.id !== reportType || type.livemode !== true || !Number.isSafeInteger(type.data_available_start) ||
      !Number.isSafeInteger(type.data_available_end)) throw Error('Unexpected Stripe Fees report availability.');
  const eligible = days.filter(start => start >= type.data_available_start && start + day <= type.data_available_end);
  let checked = 0, recorded = 0;
  // Rotate through unresolved dates so one missing or separately billed charge
  // cannot block reports for later sales. Keep each scheduled sweep bounded.
  for (let i = 0; i < Math.min(4,eligible.length); i++) {
    const start = eligible[(Math.floor(now / 3600000) + i) % eligible.length];
    const end = start + day;
    const body = new URLSearchParams({report_type: reportType, 'parameters[interval_start]': start,
      'parameters[interval_end]': end, 'parameters[timezone]': 'Etc/UTC'});
    for (const c of ['incurred_by','product','feature_name','amount','currency','balance_transaction_id']) body.append('parameters[columns][]',c);
    const run = await readBoundedJson(await response(key,api + 'reporting/report_runs',fetchImpl,{
      method:'POST',body,headers:{'Idempotency-Key':['stream-tax-fees',platform,start,Math.floor(now/(day*1000))].join('-')}
    }), 65536);
    if (!/^frr_[A-Za-z0-9]+$/.test(run.id)) throw Error('Unexpected Stripe report run.');
    const current = await get(key,'reporting/report_runs/' + run.id,fetchImpl);
    if (current.id !== run.id || current.object !== 'reporting.report_run' || current.report_type !== reportType ||
        current.livemode !== true || current.parameters?.interval_start !== start || current.parameters?.interval_end !== end) {
      throw Error('Stripe returned a different report than requested.');
    }
    if (current.status === 'pending') continue;
    if (current.status !== 'succeeded' || !/^file_[A-Za-z0-9]+$/.test(current.result?.id)) throw Error('Stripe could not finish the fee report.');
    const csv = await downloadReport(key,current.result.id,fetchImpl);
    recorded += importTaxFeeReport(store,platform,csv).recorded;
    checked++;
  }
  return {checked,recorded};
}

// The authenticated operator supplies Stripe's report ID. Fetch the evidence
// from the same platform. A pasted CSV, amount, or an unverified zero is never
// sufficient to release a filmmaker transfer through this path.
export async function reviewTaxFee({store,key,platform,chargeId,reportId,confirmZero,reviewer,fetchImpl=fetch}) {
  if (store.paymentMode !== 'live' || stripeSecretMode(key) !== 'live' || !reviewer ||
      !/^ch_[A-Za-z0-9]{1,100}$/.test(chargeId) || !/^frr_[A-Za-z0-9]{1,100}$/.test(reportId)) {
    throw Error('Choose a charge and enter the completed Stripe Fees report ID.');
  }
  const order = store.viewerOrderByPlatformPayment(platform,null,chargeId);
  if (!order?.paidAt || order.taxPolicy !== 'marketplace-v1' || order.nmQuote) throw Error('Choose a paid Stripe Tax charge.');
  const report = await get(key,'reporting/report_runs/' + reportId,fetchImpl);
  const params = report.parameters;
  if (report.id !== reportId || report.livemode !== true || report.object !== 'reporting.report_run' ||
      report.report_type !== reportType || report.status !== 'succeeded' || !Number.isSafeInteger(report.created) ||
      !Number.isSafeInteger(params?.interval_start) || !Number.isSafeInteger(params?.interval_end) ||
      order.paidAt < params.interval_start || order.paidAt >= params.interval_end ||
      Object.keys(params).some(field => !['interval_start','interval_end','timezone','columns','currency'].includes(field) && params[field] != null) ||
      (params.currency && params.currency !== 'usd')) throw Error('Choose a completed live itemized incurred-at Fees report that includes this charge.');
  const csv = await downloadReport(key,report.result?.id,fetchImpl);
  const result = importTaxFeeReport(store,platform,csv,{chargeId,reviewer});
  if (result.matched || order.taxBasicFeeCents !== null) return;
  if (confirmZero !== true || report.created < order.paidAt + 4 * day) {
    throw Error('No matching fee appeared. Confirm a zero fee in Stripe and use a report created at least four days after the payment.');
  }
  store.recordTaxFees(platform,[{chargeId,feeCents:0,reference:reportId}],reviewer);
}
