// Real player, HTTP routes, preview, encrypted HLS and browser navigation.
// Only the payment provider and catalog are fixtures. No Stripe credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openFilm } from '../src/media.js';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { makeServer } from '../src/server.js';
import { createFileSource } from '../src/source.js';

const source = createFileSource(fileURLToPath(new URL('../.local/clock.mp4', import.meta.url)));
const film = await openFilm(source);
const offers = new Map(['first', 'second'].map(id => [id, {
  id, title: 'Test film ' + id, scope: 'test/' + id, revision: film.revision, authority: createRentalAuthority(randomBytes(32))
}]));
const catalog = { get: id => offers.get(id), verify: id => offers.get(id), open: () => openFilm(source), list: () => [...offers.values()] };
const orders = new Map();
const hosted = new Map();
let interruptNextStart = false;
const checkout = {
  async start({ offer, token, origin }) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    if (interruptNextStart) {
      interruptNextStart = false;
      throw new Error('Simulated temporary checkout outage');
    }
    let order = orders.get(token);
    if (!order) {
      order = { offer, number: hosted.size + 1, status: 'pending' };
      orders.set(token, order);
      hosted.set(String(order.number), order);
    }
    assert.equal(order.offer.id, offer.id);
    return { url: order.status === 'paid' ? origin + '/checkout/return' : 'https://checkout.stripe.com/c/pay/' + order.number };
  },
  async status({ offer, token }) {
    const order = orders.get(token);
    return order?.offer.id === offer.id ? { status: order.status, receipt: order.receipt } : { status: 'pending' };
  }
};
async function confirm(order) {
  const { scope, revision, authority } = order.offer;
  const id = 'pi_fixture' + order.number;
  const intent = { object: 'payment_intent', id, status: 'succeeded', livemode: false, amount: 99, amount_received: 99, currency: 'usd',
    metadata: { product: 'stream-rental-prototype', scope: rentalScope({ film: scope, revision }) },
    latest_charge: { object: 'charge', status: 'succeeded', payment_intent: id, livemode: false, captured: true,
      paid: true, refunded: false, amount_refunded: 0, disputed: false, created: Math.floor(Date.now() / 1000) } };
  order.receipt = await authority.issueReceipt(intent, { film: scope, revision });
  order.status = 'paid';
}

const player = await makeServer(null, { catalog, checkout });
await new Promise(resolve => player.listen(0, '127.0.0.1', resolve));
const app = 'http://127.0.0.1:' + player.address().port;
const publisher = createServer(async (req, res) => {
  const confirmation = /^\/confirm\/(\d+)$/.exec(req.url);
  if (confirmation && req.method === 'POST') {
    await confirm(hosted.get(confirmation[1]));
    res.writeHead(303, { Location: app + '/checkout/return' }).end();
  } else if (req.url === '/') {
    const frames = ['first', 'second', 'first'].map(id => '<iframe allow="autoplay" src="' + app + '/embed/' + id + '"></iframe>');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(frames.join('\n'));
  } else res.writeHead(404).end();
});
await new Promise(resolve => publisher.listen(0, '127.0.0.1', resolve));
const host = 'http://localhost:' + publisher.address().port;

async function preview(frame) {
  assert.equal(await frame.locator('#purchase').isHidden(), true);
  await frame.getByRole('button', { name: 'Play 10-second preview' }).click();
  await frame.waitForFunction(() => document.querySelector('video').currentTime > .1);
  await frame.evaluate(() => {
    const video = document.querySelector('video');
    if (Math.abs(video.duration - 10) > .1) throw Error('Wrong preview duration');
    video.currentTime = 9.7;
  });
  await frame.locator('#rent').waitFor();
  assert.equal(await frame.locator('video').evaluate(v => v.ended), true);
}

async function openPayment(context, frame, { retry = false } = {}) {
  const [tab] = await Promise.all([context.waitForEvent('page'), frame.locator('#rent').click()]);
  if (retry) {
    const again = tab.getByRole('button', { name: 'Try checkout again' });
    await again.waitFor();
    assert.equal(new URL(tab.url()).hash, '');
    await again.click();
  }
  await tab.getByRole('button', { name: 'Pay test $0.99' }).waitFor();
  assert.equal(await tab.evaluate(() => window === top && !opener && !location.hash), true);
  return tab;
}

const browser = await chromium.launch({ channel: process.env.STREAM_BROWSER_CHANNEL || 'chromium',
  args: ['--host-resolver-rules=MAP checkout.stripe.com 127.0.0.1'] });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const seen = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    seen.push(url.href, route.request().headers().referer || '');
    if (url.origin === app || url.origin === host) return route.continue();
    if (url.origin !== 'https://checkout.stripe.com') return route.abort();
    const order = hosted.get(url.pathname.split('/').at(-1));
    if (!order) return route.abort();
    return route.fulfill({ contentType: 'text/html', body:
      '<form method="post" action="' + host + '/confirm/' + order.number + '"><button>Pay test $0.99</button></form>' +
      '<a href="' + app + '/checkout/cancel">Cancel checkout</a>' });
  });

  const page = await context.newPage();
  await page.goto(host);
  const children = () => page.mainFrame().childFrames();
  let [first, second, duplicate] = children();
  await preview(first);
  await preview(second);
  await preview(duplicate);

  assert.equal(await first.locator('#rent').evaluate(button => {
    const { top, bottom } = button.getBoundingClientRect();
    return top >= 0 && bottom <= innerHeight;
  }), true, 'A 300 × 150 embed should expose the rental action when the preview ends');
  interruptNextStart = true;
  const cancelled = await openPayment(context, first, { retry: true });
  await cancelled.getByRole('link', { name: 'Cancel checkout' }).click();
  await cancelled.getByRole('heading', { name: 'Checkout cancelled' }).waitFor();
  await cancelled.close();
  await first.getByRole('button', { name: 'Check payment' }).click();
  await first.getByText('Payment is pending.', { exact: false }).waitFor();
  await page.reload();
  [first, second, duplicate] = children();
  await first.getByRole('button', { name: 'Reopen test checkout' }).waitFor();
  assert.equal(await duplicate.locator('#purchase').isHidden(), true);
  await preview(duplicate);
  const separate = await openPayment(context, duplicate);
  await separate.close();
  assert.equal(orders.size, 2);
  const checkoutTab = await openPayment(context, first);
  assert.equal(orders.size, 2);
  await checkoutTab.getByRole('button', { name: 'Pay test $0.99' }).click();
  await checkoutTab.getByRole('heading', { name: 'Return to your film' }).waitFor();
  await checkoutTab.getByRole('link', { name: 'Return to film in this tab' }).click();
  await checkoutTab.getByRole('button', { name: 'Play rental' }).waitFor();
  assert.equal(new URL(checkoutTab.url()).hash, '');
  await checkoutTab.close();

  const paid = first.getByRole('button', { name: 'Play rental' });
  await paid.waitFor();
  await paid.click();
  await first.waitForFunction(() => document.querySelector('video').currentTime > .25);
  await first.locator('video').evaluate(v => { v.currentTime = 120; });
  await first.waitForFunction(() => document.querySelector('video').currentTime > 120.25);
  assert.equal(await duplicate.getByRole('button', { name: 'Play rental' }).count(), 0);
  hosted.get('2').status = 'expired';
  await duplicate.getByRole('button', { name: 'Check payment' }).click();
  await duplicate.getByRole('button', { name: 'Start test rental' }).waitFor();
  const renewed = await openPayment(context, duplicate);
  await renewed.close();
  assert.equal(orders.size, 3);
  await preview(second);
  assert.equal(await second.getByRole('button', { name: 'Play rental' }).count(), 0);

  // Simulate the browser's popup blocker and unavailable third-party storage.
  await context.addInitScript(() => {
    if (window !== top) Object.defineProperty(window, 'sessionStorage', { get() { throw Error('Storage is unavailable'); } });
  });
  await page.reload();
  [, second] = children();
  await preview(second);
  await second.evaluate(() => { window.open = () => null; });
  await second.getByRole('button', { name: 'Start test rental' }).click();
  await second.getByRole('link', { name: 'Use this tab for checkout' }).click();
  await page.getByRole('button', { name: 'Pay test $0.99' }).click();
  await page.getByRole('link', { name: 'Return to film in this tab' }).click();
  await page.getByRole('button', { name: 'Play rental' }).waitFor();
  for (const [token, order] of orders) {
    assert.ok(!seen.some(url => url.includes(token) || (order.receipt && url.includes(order.receipt))),
      'A private checkout value appeared in a request URL or referrer');
  }
  console.log('Viewer checkout passed: 10-second previews, two films, independent duplicate embeds, checkout retry, expiry, cancel/reopen, publisher refresh, paid 120-second seek, blocked popup and private storage.');
} finally {
  await browser.close();
  await Promise.all([player, publisher].map(server => new Promise(resolve => server.close(resolve))));
  film.close();
}
