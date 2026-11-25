import assert from 'node:assert/strict';
import test from 'node:test';
import { examplePath, exampleCheckout } from '../src/example-checkout.js';

const origin = 'https://stream.example';
const path = origin + examplePath;
const env = { STREAM_DEMO_STRIPE_SECRET_KEY: 'sk_test_fixture', STREAM_DEMO_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture' };
const order = (query = 'offer=rent&tip=10', source = origin) =>
  new Request(path + '/checkout?' + query, { method: 'POST', headers: { origin: source } });

test('demo checkout only opens same-origin test sessions for the two advertised offers', async () => {
  let calls = 0;
  const provider = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('customer_email'), 'demo@example.com');
    assert.equal(fields.get('allowed_payment_method_types[0]'), 'card');
    const amount = Number(fields.get('line_items[0][price_data][unit_amount]'));
    return Response.json({ id: 'cs_test_demo', client_secret: 'cs_test_demo_secret_example', livemode: false, amount_total: amount });
  };
  for (const [request, config, status] of [
    [order(), { ...env, STREAM_DEMO_STRIPE_SECRET_KEY: 'sk_live_fixture' }, 503],
    [order(), { ...env, STREAM_DEMO_STRIPE_PUBLISHABLE_KEY: 'pk_live_fixture' }, 503],
    [order('offer=rent&tip=10', 'https://elsewhere.example'), env, 403],
    [order('offer=rent&tip=16'), env, 400], [order('offer=other&tip=0'), env, 400],
    [order(), { ...env, STREAM_DEMO_LIMIT: { limit: async () => ({ success: false }) } }, 429]
  ]) assert.equal((await exampleCheckout(request, config, provider)).status, status);
  assert.equal(calls, 0);
  for (const [offer, tip, total] of [['rent', 10, 550], ['buy', 0, 1000]]) {
    const response = await exampleCheckout(order('offer=' + offer + '&tip=' + tip), env, provider);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).amount, total);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const mismatch = await exampleCheckout(order(), env, async () => Response.json({
    id: 'cs_live_demo', client_secret: 'cs_live_demo_secret_invalid', livemode: true, amount_total: 550
  }));
  assert.equal(mismatch.status, 502);
});
