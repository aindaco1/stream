// Real cross-site player, encrypted HLS and POST attachment; local provider doubles only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openFilm } from '../src/media.js';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { makeServer } from '../src/server.js';
import { createFileSource } from '../src/source.js';

const path = fileURLToPath(new URL('../.local/clock.mp4', import.meta.url));
const source = createFileSource(path);
const film = await openFilm(source);
const fileHead = await source.head();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHash = hash(await readFile(path));
const offers = new Map(['first', 'second'].map(id => [id, { id, title: 'Test film ' + id, scope: 'test/' + id,
  prices: { rent: 99, buy: 299 }, revision: film.revision, authority: createRentalAuthority(randomBytes(32)) }]));
const catalog = {
  get: id => offers.get(id), verify: id => offers.get(id), open: () => openFilm(source), list: () => [...offers.values()],
  async download(id) { return { title: offers.get(id).title, size: fileHead.size, stream: (start, end, signal) => createReadStream(path, { start, end: end - 1, signal }) }; }
};
const orders = new Map();
const sessions = new Map();
let interruptNext = false;
let downloadChecks = 0;
const checkout = {
  async start({ offer, token, kind }) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(['rent', 'buy'].includes(kind));
    if (interruptNext) { interruptNext = false; throw Error('Simulated outage'); }
    if (!orders.has(token)) {
      const order = { offer, kind, id: 'session_' + (orders.size + 1), status: 'pending' };
      orders.set(token, order);
      sessions.set(order.id, order);
    }
    const order = orders.get(token);
    assert.equal(order.offer, offer);
    assert.equal(order.kind, kind);
    return order.status === 'paid' ? { status: 'paid' } :
      { clientSecret: order.id, publishableKey: 'pk_test_fixture', account: 'acct_' + offer.id };
  },
  async status({ offer, token }) {
    const order = orders.get(token);
    if (!order || order.offer !== offer) return { status: 'pending' };
    return { status: order.status, kind: order.kind, receipt: order.receipt };
  },
  async verifyPurchase({ offer, orderId }) {
    downloadChecks++;
    const order = sessions.get(orderId);
    return order?.offer === offer && order.kind === 'buy' && order.status === 'paid';
  }
};
async function confirm(id) {
  const order = sessions.get(id);
  assert.ok(order);
  const { scope, revision, authority, prices } = order.offer;
  const amount = prices[order.kind];
  const entitlement = { film: scope, revision };
  const pi = 'pi_' + id;
  const intent = { object: 'payment_intent', id: pi, status: 'succeeded', livemode: false, amount, amount_received: amount, currency: 'usd',
    metadata: { product: 'stream-rental-prototype', scope: rentalScope(entitlement), amount: String(amount), kind: order.kind, order: id },
    latest_charge: { object: 'charge', status: 'succeeded', payment_intent: pi, livemode: false, captured: true, amount,
      amount_captured: amount, currency: 'usd', paid: true, refunded: false, amount_refunded: 0, disputed: false,
      created: Math.floor(Date.now() / 1000) } };
  order.receipt = order.kind === 'buy' ? await authority.issuePurchaseReceipt(intent, entitlement, { amount, orderId: id }) :
    await authority.issueReceipt(intent, entitlement, { amount });
  order.status = 'paid';
}

const player = await makeServer(null, { catalog, checkout });
const downloadResponses = [];
player.on('request', (req, res) => {
  if (req.url.endsWith('/download')) res.on('close', () => downloadResponses.push({
    method: req.method, status: res.statusCode, originMatched: req.headers.origin === 'http://' + req.headers.host
  }));
});
await new Promise(resolve => player.listen(0, '127.0.0.1', resolve));
const app = 'http://127.0.0.1:' + player.address().port;
const publisher = createServer((req, res) => {
  const frames = ['first', 'second', 'first'].map(id => '<iframe allow="autoplay; payment" src="' + app + '/embed/' + id + '"></iframe>');
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(frames.join('\n'));
});
await new Promise(resolve => publisher.listen(0, '127.0.0.1', resolve));
const host = 'http://localhost:' + publisher.address().port;

// The official client's public methods are exercised inside the original player.
// The synthetic payment UI lives in a separate-origin child frame, like Stripe's.
const vendor = 'https://checkout.stripe.com';
const library = 'https://js.stripe.com/endive/stripe.js';
const mockStripe = `
window.Stripe = (key, {stripeAccount}) => {
  if (key !== 'pk_test_fixture' || stripeAccount !== 'acct_' + location.pathname.split('/')[2]) throw Error('Seller mismatch');
  return { async createEmbeddedCheckoutPage({fetchClientSecret, onComplete}) {
    const id = await fetchClientSecret();
    const frame = document.createElement('iframe');
    frame.src = '${vendor}/mock-form';
    frame.title = 'Test card form';
    frame.addEventListener('load', () => frame.contentWindow.postMessage(id, '${vendor}'));
    const complete = e => { if (e.origin === '${vendor}' && e.source === frame.contentWindow && e.data === 'complete') onComplete(); };
    return { mount(selector) { window.addEventListener('message', complete); document.querySelector(selector).append(frame); },
      destroy() { window.removeEventListener('message', complete); frame.remove(); } };
  } };
};`;
const mockForm = `<button id="pay" disabled>Submit test payment</button><button id="bank" hidden>Finish bank verification</button>
<script>
let session;
addEventListener('message', e => { if(e.origin === '${app}' && e.source === parent) { session = e.data; pay.disabled = false; } });
pay.onclick = () => { pay.hidden = true; bank.hidden = false; parent.postMessage('complete', '${app}'); };
bank.onclick = async () => { await confirmFixture(session); parent.postMessage('complete', '${app}'); };
</script>`;

const requests = [];
async function install(context) {
  await context.exposeBinding('confirmFixture', ({ frame }, id) => {
    assert.equal(new URL(frame.url()).origin, vendor);
    return confirm(id);
  });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url: url.href, referrer: request.headers().referer || '', method: request.method() });
    if (url.origin === app || url.origin === host) return route.continue();
    if (url.href === library) return route.fulfill({ contentType: 'text/javascript', body: mockStripe });
    if (url.href === vendor + '/mock-form') return route.fulfill({ contentType: 'text/html', body: mockForm });
    return route.abort();
  });
}

async function preview(frame) {
  assert.equal(await frame.locator('#purchase').isHidden(), true);
  await frame.locator('video').evaluate(video => { video.muted = true; });
  await frame.getByRole('button', { name: 'Play 10-second preview' }).click();
  await frame.waitForFunction(() => document.querySelector('video').currentTime > .1, null, { polling: 100 });
  const length = await frame.locator('video').evaluate(video => { video.currentTime = 9.7; return video.duration; });
  assert.ok(Math.abs(length - 10) < .1);
  await frame.locator('#rent').waitFor();
  assert.equal(await frame.locator('video').evaluate(video => video.ended), true);
}

async function complete(frame, kind, { blockAutoplay = false } = {}) {
  if (blockAutoplay) await frame.locator('video').evaluate(video => {
    video.play = () => {
      delete video.play;
      return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
    };
  });
  await frame.locator('#' + kind).click();
  const provider = frame.frameLocator('iframe[title="Test card form"]');
  await provider.getByRole('button', { name: 'Submit test payment' }).click();
  await frame.getByText('Payment is pending.', { exact: false }).waitFor();
  assert.equal(await frame.locator('#ownership').isHidden(), true);
  await provider.getByRole('button', { name: 'Finish bank verification' }).click();
  if (blockAutoplay) {
    await frame.getByText('Select Play film to watch.', { exact: true }).waitFor();
    await frame.getByRole('button', { name: 'Play film' }).click();
  }
  await frame.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.duration > 100 && video.currentTime > .25 && !video.paused;
  }, null, { polling: 100 });
}

const browser = await chromium.launch({ channel: process.env.STREAM_BROWSER_CHANNEL || 'chromium',
  args: ['--host-resolver-rules=MAP js.stripe.com 127.0.0.1, MAP checkout.stripe.com 127.0.0.1'] });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await install(context);
  const page = await context.newPage();
  await page.goto(host);
  const frames = async () => Promise.all((await page.locator('iframe').elementHandles()).map(e => e.contentFrame()));
  let [renter, buyer, neighbor] = await frames();
  await preview(renter);
  await preview(buyer);
  await preview(neighbor);
  assert.equal(requests.some(r => r.url === library), false, 'Preview must not contact Stripe');
  assert.equal(await renter.locator('#buy').evaluate(button => button.getBoundingClientRect().bottom <= innerHeight), true);
  interruptNext = true;
  await renter.locator('#rent').click();
  await renter.getByText('Checkout could not open.', { exact: false }).waitFor();
  await buyer.locator('#rent').click();
  await buyer.frameLocator('iframe[title="Test card form"]').getByRole('button', { name: 'Submit test payment' }).waitFor();
  await buyer.getByRole('button', { name: 'Back to film' }).click();
  await complete(renter, 'rent');
  await renter.locator('video').evaluate(video => { video.currentTime = 120; });
  await renter.waitForFunction(() => document.querySelector('video').currentTime > 120.25, null, { polling: 100 });
  assert.equal(await renter.locator('#ownership').isHidden(), true);
  await complete(buyer, 'buy');
  assert.equal(await neighbor.locator('video').evaluate(video => video.ended && video.duration < 10.1), true);
  assert.equal(context.pages().length, 1);
  assert.equal(page.url(), host + '/');
  assert.equal(orders.size, 3);
  assert.equal(new Set([...orders.values()].filter(o => o.offer.id === 'second').map(o => o.kind)).size, 2);

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }),
    buyer.getByRole('button', { name: 'Download film' }).click()]).catch(async error => {
    throw new Error('Download failed: ' + JSON.stringify({ downloadResponses, downloadChecks,
      status: await buyer.locator('#status').textContent() }), { cause: error });
  });
  assert.equal(hash(await readFile(await download.path())), expectedHash);
  assert.ok(downloadChecks > 0);
  assert.ok(requests.some(r => r.url === app + '/film/second/download' && r.method === 'POST'));
  await buyer.getByText('Save purchase link', { exact: true }).click();
  const recovery = await buyer.getByLabel('Private purchase link').inputValue();
  await page.reload();
  [renter, buyer, neighbor] = await frames();
  await buyer.getByRole('button', { name: 'Download film' }).waitFor();
  await renter.getByRole('button', { name: 'Play rental' }).waitFor();
  assert.equal(await neighbor.locator('#purchase').isHidden(), true);

  const isolated = await browser.newContext({ serviceWorkers: 'block' });
  await install(isolated);
  await isolated.addInitScript(() => {
    for (const key of ['sessionStorage', 'localStorage']) Object.defineProperty(window, key, { get() { throw Error('Storage disabled'); } });
  });
  const recovered = await isolated.newPage();
  await recovered.goto(recovery);
  await recovered.getByRole('button', { name: 'Download film' }).waitFor();
  assert.equal(new URL(recovered.url()).hash, '');
  const privatePage = await isolated.newPage();
  await privatePage.goto(host);
  const privateFrame = await (await privatePage.locator('iframe').first().elementHandle()).contentFrame();
  await preview(privateFrame);
  await complete(privateFrame, 'buy', { blockAutoplay: true });
  await privateFrame.getByRole('button', { name: 'Download film' }).waitFor();

  for (const [token, order] of orders) {
    assert.ok(!requests.some(({ url, referrer }) => [url, referrer].some(address =>
      address.includes(token) || (order.receipt && address.includes(order.receipt)))), 'A private credential appeared in a URL or referrer');
  }
  console.log('Inline checkout passed: independent rent and buy, same-frame playback, delayed bank confirmation, 120-second seek, exact MP4 download, refresh and private-link recovery with blocked storage.');
} finally {
  await browser.close();
  await Promise.all([player, publisher].map(server => new Promise(resolve => server.close(resolve))));
  film.close();
}
