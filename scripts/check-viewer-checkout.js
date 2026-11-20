// Real cross-site player, encrypted HLS and POST attachment; local provider doubles only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pictureSubtitles } from '../test/fixtures/picture-subtitles.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openFilm } from '../src/media.js';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { makeServer } from '../src/server.js';
import { createFileSource } from '../src/source.js';

const clock = fileURLToPath(new URL('../.local/clock.mp4', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'stream-subtitled-checkout-'));
const path = join(directory, 'screening.mkv');
const text = join(directory, 'words.srt'), picture = join(directory, 'picture.sup');
await Promise.all([
  writeFile(text, '1\n00:00:00,000 --> 00:00:11,000\nPreview caption\n\n2\n00:02:00,000 --> 00:02:10,000\nPaid caption\n'),
  writeFile(picture, pictureSubtitles())
]);
execFileSync('ffmpeg', ['-v', 'error', '-i', clock, '-i', text, '-itsoffset', '2', '-f', 'sup', '-i', picture,
  '-map', '0:v:0', '-map', '0:a:0', '-map', '1:s', '-map', '2:s', '-c', 'copy',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fra', path]);
const source = createFileSource(path);
const film = await openFilm(source);
const fileHead = await source.head();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHash = hash(await readFile(path));
const offers = new Map(['first', 'second', 'legacy'].map(id => [id, { id, title: 'Test film ' + id, scope: 'test/' + id,
  prices: { rent: 99, buy: 299 }, revision: film.revision, authority: createRentalAuthority(randomBytes(32)) }]));
const catalog = {
  get: id => offers.get(id), verify: id => offers.get(id), list: () => [...offers.values()],
  open: () => openFilm(source),
  async download(id) { return { title: offers.get(id).title, size: fileHead.size, extension: 'mkv', contentType: 'video/x-matroska', stream: (start, end, signal) => createReadStream(path, { start, end: end - 1, signal }) }; }
};
const orders = new Map();
const sessions = new Map();
let interruptNext = false;
let mismatchedTotal;
let opening;
let downloadChecks = 0;
const checkout = {
  async start({ offer, token, kind, tipPercent }) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(['rent', 'buy'].includes(kind));
    if (interruptNext) { interruptNext = false; throw Error('Simulated outage'); }
    if (opening) await opening.promise;
    if (!orders.has(token)) {
      const filmAmount = offer.prices[kind], tipAmount = Math.round(filmAmount * tipPercent / 100);
      const order = { offer, kind, id: 'session_' + (orders.size + 1), status: 'pending',
        filmAmount, tipPercent, tipAmount, amount: filmAmount + tipAmount, attempts: 0, submissions: 0, pendingChecks: 0 };
      orders.set(token, order);
      sessions.set(order.id, order);
    }
    const order = orders.get(token);
    assert.equal(order.offer, offer);
    assert.equal(order.kind, kind);
    assert.equal(order.tipPercent, tipPercent);
    return order.status === 'paid' ? { status: 'paid' } :
      { clientSecret: order.id, publishableKey: 'pk_test_fixture', account: 'acct_' + offer.id,
        uiMode: offer.id === 'legacy' ? 'embedded_page' : 'elements', orderId: order.id, amount: order.amount,
        filmAmount: order.filmAmount, tipPercent, tipAmount: order.tipAmount, currency: 'usd', title: offer.title, kind };
  },
  async abandon({ offer, token }) {
    const order = orders.get(token);
    if (!order) return { status: 'pending' };
    assert.equal(order.offer, offer);
    if (!order.submissions && order.status === 'pending') order.status = 'expired';
    return { status: order.status };
  },
  async status({ offer, token }) {
    const order = orders.get(token);
    if (!order || order.offer !== offer) return { status: 'pending' };
    if (order.submissions && order.status === 'pending') order.pendingChecks++;
    return { status: order.status, kind: order.kind, receipt: order.receipt };
  },
  accessAllowed({ offer, orderId, kind }) {
    const order = sessions.get(orderId);
    return order?.offer === offer && order.kind === kind && order.status === 'paid';
  },
  verifyPlayback(request) { return checkout.accessAllowed(request); },
  async verifyPurchase({ offer, orderId }) {
    downloadChecks++;
    const order = sessions.get(orderId);
    return order?.offer === offer && order.kind === 'buy' && order.status === 'paid';
  }
};
async function confirm(id) {
  const order = sessions.get(id);
  assert.ok(order);
  const { scope, revision, authority } = order.offer;
  const { amount } = order;
  const entitlement = { film: scope, revision };
  const pi = 'pi_' + id;
  const intent = { object: 'payment_intent', id: pi, status: 'succeeded', livemode: false, amount, amount_received: amount, currency: 'usd',
    metadata: { product: 'stream-rental-prototype', scope: rentalScope(entitlement), amount: String(amount), kind: order.kind, order: id },
    latest_charge: { object: 'charge', status: 'succeeded', payment_intent: pi, livemode: false, captured: true, amount,
      amount_captured: amount, currency: 'usd', paid: true, refunded: false, amount_refunded: 0, disputed: false,
      created: Math.floor(Date.now() / 1000) } };
  order.receipt = order.kind === 'buy' ? await authority.issuePurchaseReceipt(intent, entitlement, { amount, orderId: id }) :
    await authority.issueReceipt(intent, entitlement, { amount, orderId:id });
  order.status = 'paid';
}

const recovery = { request(offer, email) {
  assert.equal(offer.id, 'first');
  assert.equal(email, 'viewer@example.test');
} };
const player = await makeServer(null, { catalog, checkout, recovery });
const downloadResponses = [];
player.on('request', (req, res) => {
  if (req.url.endsWith('/download')) res.on('close', () => downloadResponses.push({
    method: req.method, status: res.statusCode, originMatched: req.headers.origin === 'http://' + req.headers.host
  }));
});
await new Promise(resolve => player.listen(0, '127.0.0.1', resolve));
const app = 'http://127.0.0.1:' + player.address().port;
const publisher = createServer((req, res) => {
  const frames = [['first', 320, 600], ['second', 375, 680], ['first', 300, 150], ['legacy', 900, 660]]
    .map(([id, width, height]) => '<iframe allow="autoplay; payment" width="' + width + '" height="' + height + '" src="' + app + '/embed/' + id + '"></iframe>');
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Publisher</title>' +
    '<style>body{margin:0;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px}iframe{border:0}</style>' + frames.join('\n'));
});
await new Promise(resolve => publisher.listen(0, '127.0.0.1', resolve));
const host = 'http://localhost:' + publisher.address().port;

// The player runs unchanged against a local double of Stripe's public client
// API. Synthetic card and contact fields live inside separate-origin frames.
const vendor = 'https://checkout.stripe.com';
const library = 'https://js.stripe.com/endive/stripe.js';
// This double never receives card or contact values. Each provider iframe
// sends only completeness, just as the merchant-facing Elements events do.
function stripeFixture(vendor) {
  window.Stripe = (key, { stripeAccount }) => {
    if (key !== 'pk_test_fixture' || stripeAccount !== 'acct_' + location.pathname.split('/')[2]) throw Error('Seller mismatch');
    return {
      initCheckoutElementsSdk({ clientSecret, elementsOptions }) {
        if (!elementsOptions?.appearance) throw Error('Checkout appearance missing');
        const complete = new Map();
        const change = new Set();
        let total, currency;
        const session = () => ({ currency, email: null, total: { total }, canConfirm: complete.get('contact') && complete.get('card') || false });
        function element(kind) {
          const frame = document.createElement('iframe');
          frame.title = kind === 'contact' ? 'Test contact details' : 'Test payment details';
          frame.src = vendor + '/' + kind;
          frame.style.cssText = 'border:0;display:block;width:100%;height:' + (kind === 'contact' ? 75 : 175) + 'px';
          const handlers = new Map();
          const notify = (name, event = {}) => handlers.get(name)?.forEach(callback => callback(event));
          function receive(e) {
            if (e.source !== frame.contentWindow || e.origin !== vendor || e.data.type !== 'complete') return;
            complete.set(kind, e.data.complete);
            notify('change', { complete: e.data.complete });
            change.forEach(callback => callback(session()));
          }
          frame.addEventListener('load', () => notify('ready'));
          return {
            on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
            mount(selector) { window.addEventListener('message', receive); (typeof selector === 'string' ? document.querySelector(selector) : selector).append(frame); },
            destroy() { window.removeEventListener('message', receive); frame.remove(); }
          };
        }
        return {
          changeAppearance(next) { if (next.variables.fontSizeBase !== '16px') throw Error('Unexpected field text size'); },
          on(event, callback) { if (event === 'change') change.add(callback); },
          off(event, callback) { if (event === 'change') change.delete(callback); },
          createContactDetailsElement: () => element('contact'),
          createPaymentElement(options) {
            if (options.paymentMethodOrder?.[0] !== 'card') throw Error('Card should be the first available method');
            if (options.layout?.defaultCollapsed === true) throw Error('Card fields should be open');
            return element('card');
          },
          async loadActions() {
            const quote = await fixtureOrder(clientSecret, 'read');
            currency = quote.currency;
            total = { amount: new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(quote.amount / 100), minorUnitsAmount: quote.amount };
            return { type: 'success', actions: {
              getSession: session,
              async confirm(options) {
                if (options?.redirect !== 'if_required') throw Error('Unexpected payment redirect');
                if (!session().canConfirm) return { type: 'error', error: { message: 'Complete your payment details.' } };
                return fixtureOrder(clientSecret, 'submit');
              }
            } };
          }
        };
      },
      async createEmbeddedCheckoutPage({ fetchClientSecret, onComplete }) {
        const id = await fetchClientSecret();
        const frame = document.createElement('iframe');
        frame.src = vendor + '/legacy';
        frame.title = 'Legacy test card form';
        frame.addEventListener('load', () => frame.contentWindow.postMessage(id, vendor));
        const complete = e => { if (e.origin === vendor && e.source === frame.contentWindow && e.data === 'complete') onComplete(); };
        return { mount(selector) { window.addEventListener('message', complete); document.querySelector(selector).append(frame); },
          destroy() { window.removeEventListener('message', complete); frame.remove(); } };
      }
    };
  };
}

const mockStripe = '(' + stripeFixture.toString() + ')(' + JSON.stringify(vendor) + ');';
function providerForm(kind) {
  const fields = kind === 'contact' ?
    '<label>Email<input type="email" autocomplete="email" required></label>' :
    '<label>Card number<input autocomplete="cc-number" pattern="[0-9]{16}" required></label>' +
    '<label>Expiry<input autocomplete="cc-exp" pattern="[0-9]{2}/[0-9]{2}" required></label>' +
    '<label>Security code<input autocomplete="cc-csc" pattern="[0-9]{3}" required></label>';
  return '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width">' +
    '<style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif}label,input{display:block;width:100%}input{font:inherit;min-height:32px}</style>' +
    '<form>' + fields + '</form><script>document.addEventListener("input",()=>parent.postMessage({type:"complete",complete:document.forms[0].checkValidity()},' +
    JSON.stringify(app) + '));</script></html>';
}
const legacyForm = `<button disabled>Submit legacy payment</button><script>
let id; const button = document.querySelector('button');
addEventListener('message', e => { if(e.origin === '${app}' && e.source === parent) { id = e.data; button.disabled = false; } });
button.onclick = async () => { await completeLegacy(id); parent.postMessage('complete', '${app}'); };
</script>`;

const requests = [];
async function install(context) {
  await context.exposeBinding('fixtureOrder', async ({ frame }, id, operation) => {
    assert.equal(new URL(frame.url()).origin, app);
    const order = sessions.get(id);
    assert.equal(new URL(frame.url()).pathname, '/embed/' + order.offer.id);
    if (operation === 'read') {
      const quote = { amount: order.amount, currency: 'usd', ...mismatchedTotal };
      mismatchedTotal = undefined;
      return quote;
    }
    assert.equal(operation, 'submit');
    order.attempts++;
    if (order.declineNext) {
      order.declineNext = false;
      return { type: 'error', error: { message: 'The test card was declined. Try another card.' } };
    }
    order.submissions++;
    return { type: 'success', session: { status: 'complete' } };
  });
  await context.exposeBinding('completeLegacy', ({ frame }, id) => {
    assert.equal(frame.url(), vendor + '/legacy');
    assert.equal(sessions.get(id).offer.id, 'legacy');
    return confirm(id);
  });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url: url.href, referrer: request.headers().referer || '', method: request.method() });
    if (url.origin === app) {
      const payload = request.url() + (request.postData() || '');
      assert.doesNotMatch(payload, /4242424242424242|5555555555554444|stream-viewer(?:@|%40)example[.]test/);
    }
    if (url.origin === app || url.origin === host) return route.continue();
    if (url.href === library) return route.fulfill({ contentType: 'text/javascript', body: mockStripe });
    if (url.origin === vendor && ['/card', '/contact'].includes(url.pathname)) return route.fulfill({ contentType: 'text/html', body: providerForm(url.pathname.slice(1)) });
    if (url.href === vendor + '/legacy') return route.fulfill({ contentType: 'text/html', body: legacyForm });
    return route.abort();
  });
}

async function preview(frame, captions = false) {
  await frame.waitForFunction(() => document.querySelector('#download')?.target.startsWith('stream-file-'));
  assert.equal(await frame.locator('#purchase').isHidden(), true);
  await frame.locator('video').evaluate(video => { video.muted = true; });
  await frame.getByRole('button', { name: 'Play 10-second preview' }).click();
  await frame.locator('video').scrollIntoViewIfNeeded();
  try {
    await frame.waitForFunction(() => document.querySelector('video').currentTime > .1, null, { polling: 100, timeout: 12000 });
  } catch (cause) {
    const state = await frame.locator('video').evaluate(video => ({
      width: innerWidth, title: document.title, status: document.querySelector('#status').textContent,
      ready: video.readyState, duration: video.duration, paused: video.paused, error: video.error?.code
    }));
    throw new Error('Preview did not start: ' + JSON.stringify(state), { cause });
  }
  if (captions) {
    const menu = frame.getByRole('combobox', { name: 'Subtitles' });
    await menu.selectOption('s2');
    await frame.waitForFunction(() => [...document.querySelector('video').textTracks]
      .some(track => track.mode === 'showing' && track.cues?.length === 1 && track.cues[0].endTime === 10));
    await frame.locator('video').evaluate(video => { video.pause(); video.currentTime = 4; });
    await menu.selectOption('s3');
    await frame.waitForFunction(() => {
      const video = document.querySelector('video');
      return video.currentSrc.endsWith('?subtitle=s3') && video.readyState >= 2 && video.currentTime >= 4 && video.paused;
    });
    await menu.selectOption('');
    await frame.waitForFunction(() => {
      const video = document.querySelector('video');
      return video.currentSrc.endsWith('/preview.mp4') && video.readyState >= 2 && video.currentTime >= 4;
    });
    await menu.selectOption('s2');
    await frame.locator('video').evaluate(video => video.play());
  }
  const length = await frame.locator('video').evaluate(video => { video.currentTime = 9.7; return video.duration; });
  assert.ok(Math.abs(length - 10) < .1);
  await frame.locator('#rent').waitFor();
  assert.equal(await frame.locator('video').evaluate(video => video.ended), true);
}

async function waitFor(check, message) {
  const end = Date.now() + 15000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(check(), message);
}

async function checkoutFits(frame, [width, height]) {
  const element = await frame.frameElement();
  await element.evaluate((iframe, [w, h]) => { iframe.width = w; iframe.height = h; }, [width, height]);
  await frame.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  const bounds = await frame.locator('#payment').evaluate(node => {
    const scroll = node.querySelector('#checkout-scroll');
    const button = node.querySelector('#confirm-payment');
    const top = button.getBoundingClientRect().top;
    scroll.scrollTop = scroll.scrollHeight;
    const action = button.getBoundingClientRect();
    const lastField = node.querySelector('#payment-element iframe').getBoundingClientRect();
    const selectors = ['#checkout-heading', '#close-checkout', '#confirm-payment', '#contact-element iframe', '#payment-element iframe'];
    return {
      overflow: Math.max(document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight),
      hasNames: selectors.slice(0, 3).every(selector => node.querySelector(selector)?.innerText.trim()),
      visibleAction: action.top >= 0 && action.bottom <= innerHeight + 1 && action.height >= 44 &&
        document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2) === button,
      scrollsIndependently: Math.abs(action.top - top) <= 1 && lastField.bottom <= scroll.getBoundingClientRect().bottom + 1 &&
        scroll.getBoundingClientRect().bottom <= action.top + 1,
      fits: selectors.every(selector => {
        const box = node.querySelector(selector)?.getBoundingClientRect();
        return box && box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1;
      })
    };
  });
  assert.ok(bounds.overflow <= 1 && bounds.fits && bounds.visibleAction && bounds.scrollsIndependently && bounds.hasNames,
    width + '×' + height + ' checkout: ' + JSON.stringify(bounds));
}

async function fillCard(frame) {
  const contact = frame.frameLocator('iframe[title="Test contact details"]');
  const payment = frame.frameLocator('iframe[title="Test payment details"]');
  const email = contact.getByLabel('Email', { exact: true });
  const number = payment.getByLabel('Card number', { exact: true });
  await number.waitFor({ state: 'visible' });
  assert.equal(await email.getAttribute('autocomplete'), 'email');
  assert.equal(await number.getAttribute('autocomplete'), 'cc-number');
  assert.equal(await frame.locator('#card-form input[autocomplete^="cc-"]').count(), 0);
  await email.fill('stream-viewer@example.test');
  await number.fill('4242424242424242');
  await payment.getByLabel('Expiry').fill('12/34');
  await payment.getByLabel('Security code').fill('123');
  return { email, number };
}

async function payByCard(frame, order, { retry = false, sizes = [] } = {}) {
  const amount = '$' + (order.amount / 100).toFixed(2);
  const submit = frame.getByRole('button', { name: 'Pay ' + amount, exact: true });
  await submit.waitFor();
  for (const size of sizes) await checkoutFits(frame, size);
  const { email, number } = await fillCard(frame);
  if (retry) {
    // Model a publisher resizing its iframe while the keyboard is up and CVC is focused.
    const cvc = frame.frameLocator('iframe[title="Test payment details"]').getByLabel('Security code');
    await cvc.focus();
    // Mobile engines can shrink the visual viewport without resizing the iframe.
    const actionBottom = await frame.locator('#confirm-payment').evaluate(button => {
      const viewport = window.visualViewport;
      Object.defineProperty(viewport, 'height', { configurable: true, value: 150 });
      try {
        viewport.dispatchEvent(new Event('resize'));
        return button.getBoundingClientRect().bottom;
      } finally {
        delete viewport.height;
        viewport.dispatchEvent(new Event('resize'));
      }
    });
    assert.ok(actionBottom <= 150, 'Pay must remain in the keyboard-reduced viewport.');
    await checkoutFits(frame, [390, 150]);
    assert.ok(await cvc.evaluate(input => document.activeElement === input));
    order.declineNext = true;
    await submit.click();
    const error = frame.getByRole('alert').filter({ hasText: 'The test card was declined. Try another card.' });
    await error.waitFor();
    assert.ok(await error.evaluate(node => {
      const box = node.getBoundingClientRect();
      return document.activeElement === node && box.top >= document.querySelector('#checkout-scroll').getBoundingClientRect().top - 1 &&
        box.bottom <= document.querySelector('#confirm-payment').getBoundingClientRect().top;
    }));
    assert.equal(await number.inputValue(), '4242424242424242');
    assert.equal(await email.inputValue(), 'stream-viewer@example.test');
    assert.equal(order.submissions, 0);
    await number.fill('5555555555554444');
  }
  const before = order.attempts;
  await submit.click({ trial: true });
  // Consecutive submit events simulate a click and keyboard submit together.
  await frame.locator('#card-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await waitFor(() => order.pendingChecks > 0, 'A submitted payment must be checked with Stream.');
  assert.equal(order.attempts, before + 1, 'Concurrent submits must confirm once.');
  assert.equal(order.submissions, 1);
  assert.equal(await frame.locator('#ownership').isHidden(), true);
  assert.ok(await frame.locator('video').evaluate(video => video.duration <= 10.1));
  await confirm(order.id);
  // Bank settlement happens independently after the merchant submits.
  if (await frame.getByRole('button', { name: 'Check payment' }).isVisible()) {
    await frame.getByRole('button', { name: 'Check payment' }).click();
  }
}

async function complete(frame, kind, { blockAutoplay = false, retry = false, sizes = [], beforeEntry } = {}) {
  if (blockAutoplay) await frame.locator('video').evaluate(video => {
    video.play = () => {
      delete video.play;
      return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
    };
  });
  await frame.locator('#' + kind).click();
  const id = new URL(frame.url()).pathname.split('/').at(-1);
  if (id === 'legacy') {
    const provider = frame.frameLocator('iframe[title="Legacy test card form"]');
    await provider.getByRole('button', { name: 'Submit legacy payment' }).click({ timeout: 15000 }).catch(async cause => {
      const state = await frame.evaluate(() => ({
        status: document.querySelector('#status').textContent, checkout: !document.querySelector('#payment').hidden,
        children: [...document.querySelectorAll('iframe')].map(child => child.title),
        providerLoaded: typeof window.Stripe === 'function'
      }));
      throw new Error('Legacy form unavailable: ' + JSON.stringify(state), { cause });
    });
  } else {
    await frame.frameLocator('iframe[title="Test payment details"]').getByLabel('Card number').waitFor();
    const order = [...orders.values()].findLast(order => order.offer.id === id && order.kind === kind && order.status === 'pending');
    assert.ok(order);
    if (beforeEntry) await beforeEntry(order);
    await payByCard(frame, order, { retry, sizes });
  }
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
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1280, height: 1440 } });
  await install(context);
  const page = await context.newPage();
  await page.goto(host);
  const frames = async () => Promise.all((await page.locator('iframe').elementHandles()).map(e => e.contentFrame()));
  let [renter, buyer, neighbor, legacy] = await frames();
  await renter.getByText('Restore access', { exact: true }).click();
  const email = renter.getByLabel('Email used at checkout');
  const send = renter.getByRole('button', { name: 'Send access link' });
  await email.fill('viewer@example.test');
  await send.click();
  const feedback = renter.locator('#restore-feedback');
  await feedback.getByText(/If this email has access/).waitFor();
  const [fieldBox, sendBox, feedbackBox] = await Promise.all([email, send, feedback].map(item => item.boundingBox()));
  assert.ok(sendBox.y - (fieldBox.y + fieldBox.height) >= 8);
  assert.ok(feedbackBox.y - (sendBox.y + sendBox.height) >= 8);
  await renter.getByText('Restore access', { exact: true }).click();
  await preview(renter, true);
  await preview(buyer);
  await preview(neighbor);
  await preview(legacy);
  assert.equal(requests.some(r => r.url === library), false, 'Preview must not contact Stripe');
  assert.equal(await neighbor.locator('#buy').evaluate(button => button.getBoundingClientRect().bottom <= innerHeight), true);
  for (const frame of [renter, buyer]) {
    assert.equal(await frame.locator('#tip-choice summary').textContent(), 'Optional Dust Wave tip · 10%');
    assert.equal(await frame.locator('#rent').textContent(), 'Rent · $1.09');
    assert.equal(await frame.locator('#buy').textContent(), 'Buy · $3.29');
  }
  await renter.locator('#tip-choice summary').click();
  await renter.getByRole('slider').fill('0');
  assert.equal(await renter.locator('#rent').textContent(), 'Rent · $0.99');
  assert.equal(await buyer.locator('#tip-value').textContent(), '10%');
  interruptNext = true;
  await renter.locator('#rent').click();
  await renter.getByText('Checkout could not open.', { exact: false }).waitFor();
  await buyer.locator('#rent').click();
  await buyer.frameLocator('iframe[title="Test contact details"]').getByLabel('Email').waitFor();
  await buyer.getByRole('button', { name: 'Back to film' }).click();
  assert.match(await renter.locator('#rent').textContent(), /0[.]99/);
  // Offer markup shows 99 cents. A newly opened order holds $1.49, and
  // reopening it must keep that total even after the seller changes to $1.89.
  offers.get('first').prices.rent = 149;
  opening = Promise.withResolvers();
  try {
    await renter.locator('#rent').click();
    await renter.getByText('Opening secure test checkout…', { exact: true }).waitFor();
    assert.equal(await renter.locator('#order-price').textContent(), '');
  } finally {
    opening.resolve();
    opening = undefined;
  }
  await renter.getByRole('button', { name: 'Pay $1.49', exact: true }).waitFor();
  await renter.getByRole('button', { name: 'Back to film' }).click();
  offers.get('first').prices.rent = 189;
  const held = [...orders.values()].find(order => order.offer.id === 'first');
  for (const altered of [{ currency: 'eur' }, { amount: held.amount + 1 }]) {
    mismatchedTotal = altered;
    await renter.locator('#rent').click();
    await renter.getByRole('alert').filter({ hasText: 'price has changed' }).waitFor();
    await fillCard(renter);
    assert.ok(await renter.locator('#confirm-payment').isDisabled());
    await renter.locator('#card-form').evaluate(form => form.requestSubmit());
    await renter.getByRole('button', { name: 'Back to film' }).click();
    assert.equal(held.attempts, 0);
  }
  await complete(renter, 'rent', { retry: true, sizes: [[320, 200], [375, 211], [390, 300], [900, 660], [390, 300]], beforeEntry(order) { assert.equal(order.amount, 149); } });
  await renter.locator('video').evaluate(video => { video.currentTime = 120; });
  await renter.waitForFunction(() => document.querySelector('video').currentTime > 120.25, null, { polling: 100 });
  const subtitleMenu = renter.getByRole('combobox', { name: 'Subtitles' });
  await subtitleMenu.selectOption('s2');
  await renter.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.activeCues?.[0]?.text === 'Paid caption'));
  await subtitleMenu.selectOption('s3');
  await waitFor(() => requests.some(request => request.url.endsWith('.ts?subtitle=s3')), 'Paid player requested the captioned segment');
  await renter.waitForFunction(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime >= 120; }, null, {timeout: 10000})
    .catch(async cause => { throw new Error('Captioned rental seek: ' + JSON.stringify(await renter.evaluate(() => {
      const v = document.querySelector('video');
      return { time: v.currentTime, duration: v.duration, paused: v.paused, ready: v.readyState, selection: document.querySelector('#subtitles').value,
        status: document.querySelector('#status').textContent, modes: [...v.textTracks].map(t => [t.label, t.mode]) };
    })), { cause }); });
  await subtitleMenu.selectOption('');
  assert.equal(await renter.locator('#ownership').isHidden(), true);
  await buyer.locator('#tip-choice summary').click();
  await buyer.getByRole('slider').fill('5');
  interruptNext = true;
  await buyer.locator('#buy').click();
  await buyer.getByText('Checkout could not open.', { exact: false }).waitFor();
  await buyer.getByRole('slider').fill('10');
  assert.match(await buyer.locator('#buy').textContent(), /3\.29/);
  await complete(buyer, 'buy', { sizes: [[375, 211]], async beforeEntry(order) {
    assert.deepEqual([order.filmAmount, order.tipAmount, order.amount], [299, 30, 329]);
    assert.equal(await buyer.locator('#order-tip').textContent(), 'Film $2.99 + Dust Wave tip $0.30');
  } });
  await buyer.getByRole('combobox', { name: 'Subtitles' }).selectOption('s2');
  await buyer.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.mode === 'showing' && track.cues?.length === 2));
  assert.equal(await legacy.locator('video').evaluate(video => video.ended && video.duration < 10.1), true);
  await (await legacy.frameElement()).evaluate(iframe => { iframe.width = 320; iframe.height = 200; });
  await legacy.locator('#rent').click();
  await legacy.frameLocator('iframe[title="Legacy test card form"]').getByRole('button', { name: 'Submit legacy payment' }).waitFor();
  await legacy.getByRole('button', { name: 'Back to film' }).click();
  await legacy.locator('#tip-choice summary').click();
  await legacy.getByRole('slider').fill('15');
  await complete(legacy, 'rent');
  assert.equal(await legacy.locator('#ownership').isHidden(), true);
  assert.equal(await neighbor.locator('video').evaluate(video => video.ended && video.duration < 10.1), true);
  assert.equal(context.pages().length, 1);
  assert.equal(page.url(), host + '/');
  assert.equal(orders.size, 6);
  assert.deepEqual([...orders.values()].filter(o => o.tipAmount && o.status === 'paid').map(o => [o.kind, o.tipAmount]), [['buy', 30], ['rent', 15]]);
  assert.equal([...orders.values()].filter(o => o.status === 'expired').length, 2);
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
  assert.equal(await renter.locator('#tip-percent').inputValue(), '0', 'Reload retains the viewer’s opt-out');
  assert.equal(await buyer.locator('#tip-percent').inputValue(), '10');

  const [legacyToken] = [...orders].find(([, order]) => order.offer.id === 'legacy' && order.status === 'paid');
  const bookmark = await context.newPage();
  await bookmark.goto(app + '/pay/legacy#' + legacyToken);
  await bookmark.getByRole('button', { name: 'Play rental' }).waitFor();
  assert.equal(bookmark.url(), app + '/embed/legacy');
  assert.equal(await bookmark.locator('#ownership').isHidden(), true);
  await bookmark.close();

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
  console.log('Inline checkout passed at 320×200, 375×211, 390×300, keyboard-sized 390×150, and 900×660: visible Pay, reachable fields, held prices, correction, duplicate submit, delayed settlement, legacy checkout, independent embeds, 120-second seek, download and recovery.');
} finally {
  await browser.close();
  await Promise.all([player, publisher].map(server => new Promise(resolve => server.close(resolve))));
  film.close();
  await rm(directory, { recursive: true, force: true });
}
