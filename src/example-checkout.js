import { createStripeClient } from '@dustwave/worker-core/stripe';
import { publishableKeyMode, stripeSecretMode, sessionMode } from './stripe-mode.js';
import { tipFor } from './checkout-tips.js';

export const examplePath = '/example/market-street';
export const exampleTitle = 'A Trip Down Market Street';
export const examplePrices = { rent: 500, buy: 1000 };
const archiveFilm = 'https://tile.loc.gov/storage-services/service/mbrs/ntscrm/00015143/00015143.mp4';

// The public-domain viewing copy stays at the archive. Streaming it from this
// fixed path also lets the purchase button download the file on the same origin.
export async function exampleResponse(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const fail = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === examplePath + '/film.mp4') {
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
    try {
      const mediaHeaders = new Headers();
      for (const name of ['Range', 'If-Range']) {
        if (request.headers.has(name)) mediaHeaders.set(name, request.headers.get(name));
      }
      const upstream = await fetchImpl(archiveFilm, {
        method: request.method, headers: mediaHeaders, redirect: 'error', signal: request.signal
      });
      if (![200, 206, 416].includes(upstream.status)) {
        await upstream.body?.cancel();
        return fail(502);
      }
      const headers = new Headers({ 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=86400',
        'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
      for (const name of ['Accept-Ranges', 'Content-Range', 'Content-Length', 'ETag', 'Last-Modified']) {
        if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name));
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch { return fail(502); }
  }

  if (url.pathname !== examplePath + '/checkout') return fail(404);
  if (request.method !== 'POST') return fail(405);
  if (request.headers.get('Origin') !== url.origin) return fail(403);
  const kind = url.searchParams.get('offer');
  const percent = url.searchParams.get('tip');
  if (!Object.hasOwn(examplePrices, kind) || !/^(?:[0-9]|1[0-5])$/.test(percent)) return fail(400);
  const amount = examplePrices[kind] + tipFor(examplePrices[kind], Number(percent));
  const key = env.STREAM_DEMO_STRIPE_SECRET_KEY;
  const publishableKey = env.STREAM_DEMO_STRIPE_PUBLISHABLE_KEY;
  if (stripeSecretMode(key) !== 'test' || publishableKeyMode(publishableKey) !== 'test') return fail(503);
  try {
    if (env.STREAM_DEMO_LIMIT) {
      const attempt = await env.STREAM_DEMO_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!attempt.success) return fail(429);
    }
    const stripe = createStripeClient(key, { fetchImplementation: (url, init) =>
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' }) });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', ui_mode: 'elements', allowed_payment_method_types: ['card'],
      adaptive_pricing: { enabled: false }, return_url: url.origin + examplePath,
      customer_email: 'demo@example.com',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount,
        product_data: { name: exampleTitle + (kind === 'rent' ? ' · Demo rental' : ' · Demo purchase') } } }]
    }, { stripeVersion: '2026-10-28.endive' });
    if (session.livemode !== false || sessionMode(session.id) !== 'test' ||
        !session.client_secret?.startsWith(session.id + '_secret_') || session.amount_total !== amount) return fail(502);
    return Response.json({ publishableKey, clientSecret: session.client_secret, amount, currency: 'usd' },
      { headers: { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  } catch { return fail(502); }
}
