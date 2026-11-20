// Exercise the real setup routes, SQLite store, media inspection and forms with
// synthetic provider accounts. No Stripe or Cloudflare account is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicFilms } from '../src/public-films.js';
import { createRentalAuthority } from '../src/rental.js';
import { chromium } from 'playwright';
import { makeServer } from '../src/server.js';
import { createSetup } from '../src/setup.js';
import { createFileSource } from '../src/source.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'stream-setup-browser-'));
const evidence = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : null;
const fixture = path.join(temporary, 'clock.mp4');
const report = { providers: 'Synthetic Stripe and R2', scenarios: [] };
const savedKey = 'First cut/Short film.mp4';
const accountId = 'a'.repeat(32);
const bucket = 'screening-room-test';
const access = 'setup-test-access-only';
const secret = 'setup-test-secret-only';
const bucketUrl = `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${bucket}`;
const readToken = 'syntheticbucketreadtoken'.repeat(2);
let browser, server, viewer, setup;
let publishedEmbeds = '';
const trace = [];
const starts = [];
const callbacks = new Map();
let providerCalls = 0;
let guidedTokenAttempts = 0, guidedKeyAttempts = 0;
const stripe = {
  configured: true, existingOAuth: true, mode: 'test',
  async start(ctx, intent, country) {
    providerCalls++;
    assert.ok(['new', 'existing', 'reuse', 'resume'].includes(intent));
    if (['new', 'reuse'].includes(intent) && !ctx.state.accountId) {
      if (!country) return { countryRequired: true };
      assert.equal(country, 'US');
    }
    starts.push(intent);
    ctx.state.accountId ||= 'acct_qa' + intent + ctx.creatorId.replace(/[^a-z0-9]/gi, '');
    ctx.state.creatorId = ctx.creatorId;
    ctx.state.channel = intent === 'existing' ? 'oauth' : 'hosted';
    assert.ok(ctx.claimAccount(ctx.state.accountId, 'test'));
    ctx.state.status = 'action_required';
    await ctx.save();
    return { redirect: '/fixture/provider' };
  },
  async callback(ctx) {
    providerCalls++;
    const count = (callbacks.get(ctx.creatorId) || 0) + 1;
    callbacks.set(ctx.creatorId, count);
    ctx.state.status = ctx.creatorId === 'qa-new-new' && count === 1 ? 'action_required' : 'ready';
    ctx.state.chargesEnabled = ctx.state.payoutsEnabled = ctx.state.status === 'ready';
    ctx.state.businessName = 'Screening room test';
    await ctx.save();
    return { status: ctx.state.status };
  },
  async refresh(ctx) {
    providerCalls++;
    return { status: ctx.state.status };
  }
};

async function checkAppearance(page, origin) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(origin + '/setup/sign-in');
  const choice = page.getByRole('combobox', { name: 'Appearance' });
  const scheme = mode => page.waitForFunction(expected =>
    getComputedStyle(document.documentElement).colorScheme === expected, mode);
  assert.equal(await choice.inputValue(), 'system');
  await scheme('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await scheme('light');
  await choice.selectOption('dark');
  await scheme('dark');
  await page.reload();
  assert.equal(await choice.inputValue(), 'dark');
  const second = await page.context().newPage();
  try {
    await second.goto(origin + '/setup/sign-in');
    const there = second.getByRole('combobox', { name: 'Appearance' });
    assert.equal(await there.inputValue(), 'dark');
    await there.selectOption('light');
    await scheme('light');
    assert.equal(await choice.inputValue(), 'light');
    await choice.selectOption('system');
    await second.waitForFunction(() => document.querySelector('[data-appearance-select]').value === 'system');
    await choice.selectOption('dark');
  } finally { await second.close(); }
}

async function signIn(page, origin, owner) {
  await page.goto(origin + '/setup/sign-in');
  await page.getByLabel('Invitation code').fill(setup.store.invite(owner));
  await page.getByRole('button', { name: 'Open setup' }).click();
  await page.getByRole('heading', { name: 'Setup', exact: true }).waitFor();
}

async function openWorkspace(page, name) {
  if (await page.getByRole('heading', { name, exact: true, level: 1 }).isVisible()) return;
  const menu = page.locator('.workspace-nav select');
  await menu.waitFor({ state: 'attached' });
  if (await menu.isVisible()) await menu.selectOption(name === 'Dashboard' ? '/setup/dashboard' : '/setup');
  else await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
}

async function openSection(page, id) {
  await openWorkspace(page, 'Setup');
  const panel = page.locator('#' + id + '[role=tabpanel]');
  await panel.waitFor({ state: 'attached' });
  if (await panel.isVisible()) return;
  const select = page.locator('.workspace-sections select.dw-admin-mobile-tabs__control');
  if (await select.isVisible()) await select.selectOption(id);
  else await page.locator('#tab-' + id).click();
  await panel.waitFor();
}

async function finishStripe(page, mode, shouldResume) {
  await openSection(page, 'payments');
  const card = page.locator('#payments');
  const providerReturn = page.getByRole('link', { name: 'Return to Stream' });
  await card.locator(`button[name="mode"][value="${mode}"]`).click();
  if (mode !== 'existing') {
    const choice = page.getByLabel('Business country or region');
    assert.equal(await choice.inputValue(), '');
    await choice.selectOption('US');
    await page.getByRole('button', { name: 'Continue to Stripe' }).click();
  }
  await providerReturn.click();
  if (shouldResume) {
    await card.getByRole('button', { name: 'Continue Stripe setup' }).click();
    await providerReturn.click();
  }
  await card.locator('.provider-status').filter({ hasText: /^Connected$/ }).waitFor();
  await card.getByRole('button', { name: 'Check Stripe status' }).click();
}

async function resetAndReconnect(page, owner, otherOwner, previewPath) {
  await openSection(page, 'payments');
  const { store } = setup;
  const { stripe: connected, r2, draft } = store.maker(owner);
  // The app is running in test mode. Give this filmmaker a distinct live
  // connection so a reset that accidentally clears both modes is observable.
  const live = { mode: 'live', accountId: 'acct_qaliveonly', status: 'ready' };
  assert.ok(store.claimAccount(owner, live.accountId, live.mode));
  connected.byMode.live = live;
  store.saveStripe(owner, connected);
  const otherMaker = store.maker(otherOwner);
  assert.equal(otherMaker.stripe.byMode.test.status, 'ready');
  const previousCalls = providerCalls;
  const card = page.locator('#payments');
  const reset = card.getByRole('link', { name: 'Reset Stripe connection', exact: true });
  const confirm = page.getByRole('button', { name: 'Reset Stripe connection', exact: true });

  await reset.click();
  assert.equal(new URL(page.url()).pathname, '/setup/stripe/reset');
  assert.equal(await confirm.evaluate(button => button.form.method), 'post');
  assert.equal(await confirm.evaluate(button => button.form.action), page.url());
  assert.ok(await page.getByText(/for sandbox payments/).isVisible());
  assert.ok(await page.getByText(/Your Stripe account stays open/).isVisible());
  await page.reload();
  assert.deepEqual(store.maker(owner).stripe, connected);
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await card.locator('.provider-status').filter({ hasText: /^Connected$/ }).waitFor();
  assert.deepEqual(store.maker(owner).stripe, connected);

  await reset.click();
  const olderTab = await page.context().newPage();
  await olderTab.goto(page.url());
  await confirm.click();
  await card.locator('.provider-status').filter({ hasText: /^Not connected$/ }).waitFor();
  await page.reload();
  for (const mode of ['new', 'existing']) {
    assert.ok(await card.locator(`button[name="mode"][value="${mode}"]`).isVisible());
  }
  const afterReset = store.maker(owner);
  assert.ok(!afterReset.stripe.byMode.test?.accountId);
  assert.deepEqual(afterReset.stripe.byMode.live, live);
  assert.deepEqual(afterReset.draft, draft);
  assert.deepEqual(afterReset.r2, r2);
  assert.deepEqual(store.maker(otherOwner), otherMaker);
  assert.equal(providerCalls, previousCalls, 'Reset with no unfinished checkouts does not call the provider');
  assert.equal(await page.locator('#storage .provider-status').textContent(), 'Connected');
  await openWorkspace(page, 'Dashboard');
  const savedPreview = page.getByRole('link', { name: 'Watch private preview' });
  assert.equal(await savedPreview.getAttribute('href'), previewPath);
  await savedPreview.click();
  await page.waitForFunction(() => document.querySelector('video')?.duration === 10);
  await page.getByRole('link', { name: 'Back to film' }).click();

  await finishStripe(page, 'new', false);
  const reconnected = store.maker(owner).stripe.byMode;
  assert.equal(reconnected.test.status, 'ready');
  assert.notEqual(reconnected.test.accountId, connected.byMode.test.accountId);
  assert.deepEqual(reconnected.live, live);
  const [staleResponse] = await Promise.all([
    olderTab.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/setup/stripe/reset'),
    olderTab.getByRole('button', { name: 'Reset Stripe connection' }).click()
  ]);
  assert.equal(staleResponse.status(), 409, 'An older confirmation cannot reset the replacement seller');
  assert.deepEqual(store.maker(owner).stripe.byMode, reconnected);
  await olderTab.close();
  assert.deepEqual(store.maker(otherOwner), otherMaker);
  report.stripeReset = { confirmedAfterCancel: true, resetProviderCalls: 0, reconnected: true, staleConfirmationBlocked: true,
    preserved: ['live connection', 'other filmmaker', 'R2 connection', 'private film', 'draft'] };
}

async function submitKeyPair(form, key, buttonLabel) {
  await form.locator('[name="accessKeyId"]').fill(access);
  await form.locator('[name="secretAccessKey"]').fill(key);
  await form.locator('[name="privateConfirmed"]').check();
  await form.getByRole('button', { name: buttonLabel }).click();
}

async function connectBucket(page, method, recover) {
  await openSection(page, 'storage');
  const card = page.locator('#storage');
  if (method !== 'manual') {
    const dashboard = await card.getByRole('link', { name: 'Open Cloudflare R2' }).getAttribute('href');
    assert.equal(new URL(dashboard).origin, 'https://dash.cloudflare.com');
    await card.getByLabel('Bucket dashboard URL').fill(bucketUrl);
    await card.getByRole('button', { name: 'Continue with this bucket' }).click();
    const token = page.getByLabel('R2 token value');
    await token.waitFor();
    assert.ok((await page.locator('main').innerText()).includes(bucket));
    assert.equal(await token.getAttribute('type'), 'password');
    if (method === 'selected keys') {
      await page.getByText('Use an existing access key pair', { exact: true }).click();
      const form = page.locator('form').filter({ has: page.locator('[name="accessKeyId"]') });
      assert.equal(await form.locator('[name="bucketUrl"]').inputValue(), bucketUrl);
      await submitKeyPair(form, secret, 'Connect with access keys');
    } else {
      const form = page.locator('form').filter({ has: token });
      async function submitToken(value) {
        await token.fill(value);
        await form.locator('[name="privateConfirmed"]').check();
        await form.getByRole('button', { name: 'Connect private bucket' }).click();
      }
      if (recover) {
        await submitToken('invalidsyntheticbucketreadtoken'.repeat(2));
        await page.getByRole('alert').waitFor();
        assert.equal(await token.inputValue(), '');
        assert.ok((await page.locator('main').innerText()).includes(bucket));
      }
      await submitToken(readToken);
    }
  } else {
    async function fill(token) {
      if (!await card.locator('[name="accessKeyId"]').isVisible()) {
        await card.getByText('Enter connection details manually', { exact: true }).click();
      }
      await card.locator('[name="accountId"]').fill(accountId);
      await card.locator('[name="bucket"]').fill(bucket);
      await submitKeyPair(card, token, 'Connect private bucket');
    }
    if (recover) {
      await card.getByText('Enter connection details manually', { exact: true }).click();
      await card.getByText('Choose a Cloudflare account and bucket', { exact: true }).click();
      assert.ok(await card.getByText('New bucket.', { exact: true }).isVisible());
      assert.ok(await card.getByText('Existing bucket.', { exact: true }).isVisible());
      await card.getByText('Get a read-only key for this bucket', { exact: true }).click();
      assert.ok(await card.getByRole('link', { name: 'Cloudflare’s R2 token guide' }).isVisible());
      await fill('intentionally-wrong-fixture-key');
      await page.getByRole('alert').waitFor();
      assert.equal(await card.locator('[name="secretAccessKey"]').inputValue(), '');
      assert.equal(await card.locator('[name="accessKeyId"]').inputValue(), '');
      assert.equal(await card.locator('[name="bucket"]').inputValue(), bucket);
      assert.equal(await card.locator('[name="accountId"]').inputValue(), accountId);
    }
    await fill(secret);
  }
  await card.locator('.provider-status').filter({ hasText: /^Connected$/ }).waitFor();
  const markup = await page.content();
  assert.ok([secret, access, readToken].every(value => !markup.includes(value)), 'Credentials stay out of rendered HTML');
}

async function registerFilm(page, shouldRecover, origin, owner) {
  await openWorkspace(page, 'Dashboard');
  await page.getByRole('link', { name: 'Add a film' }).click();
  const section = page.locator('#film');
  assert.equal(await section.getByRole('link', { name: /Open your R2 bucket/ }).count(), 0);
  assert.equal(await section.locator('[name="objectKey"]').count(), 0);
  await section.locator('[name="rightsAccepted"]').check();
  await section.getByRole('button', { name: 'Confirm rights and continue' }).click();
  await section.getByText('Upload a new film to Cloudflare', { exact: true }).click();
  const dashboard = new URL(await section.getByRole('link', { name: /Open your R2 bucket/ }).getAttribute('href'));
  assert.equal(dashboard.origin, 'https://dash.cloudflare.com');
  assert.ok(dashboard.pathname.includes(bucket));
  await section.getByLabel('Film title').fill('Projection test <first cut>');
  if (shouldRecover) {
    await section.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, origin, owner);
    await openWorkspace(page, 'Dashboard');
    await page.getByRole('link', { name: 'Continue film draft' }).click();
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    await section.getByLabel('Object key').fill('Incorrect/Short film.mp4');
    await section.getByRole('button', { name: 'Check film and create preview' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    assert.equal(await section.getByLabel('Object key').inputValue(), 'Incorrect/Short film.mp4');
  }
  await section.getByLabel('Object key').fill(savedKey);
  await section.getByRole('button', { name: 'Check film and create preview' }).click();
  const preview = page.getByRole('link', { name: 'Watch private preview' });
  await preview.waitFor();
  assert.ok(await page.getByRole('heading', { name: 'Projection test <first cut>' }).isVisible());
  return preview.getAttribute('href');
}

try {
  // All provider behavior in this rehearsal is injected. Fail on any attempt
  // to call a provider directly, including one whose failure the app handles.
  let outboundRequests = 0;
  globalThis.fetch = async () => {
    outboundRequests++;
    throw new Error('Outbound network calls are disabled in the setup rehearsal');
  };
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 });
  const generated = spawnSync(process.execPath, ['scripts/fixture.js', fixture], { stdio: 'pipe' });
  assert.equal(generated.status, 0, 'Generate the synthetic clip using FFmpeg');
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_localfixture' };
  setup = await createSetup({
    directory: path.join(temporary, 'state'), stripe, env,
    async resolveBucket({ bucketUrl: location, privateConfirmed, tokenValue, accessKeyId, secretAccessKey }) {
      assert.equal(location, bucketUrl);
      assert.equal(privateConfirmed, 'yes');
      const config = { accountId, bucket, jurisdiction: 'default' };
      if (tokenValue) {
        guidedTokenAttempts++;
        return { ...config, accessKeyId: access, secretAccessKey: tokenValue === readToken ? secret : 'rejected-fixture-secret' };
      }
      guidedKeyAttempts++;
      return { ...config, accessKeyId, secretAccessKey };
    },
    async checkBucket(settings) {
      assert.equal(settings.bucket, bucket);
      assert.equal(settings.accountId, accountId);
      if (settings.accessKeyId !== access || settings.secretAccessKey !== secret) throw Error('Test credential rejected');
    },
    sourceFor(settings) {
      if (settings.objectKey !== savedKey) throw Error('Unknown test object');
      return createFileSource(fixture);
    }
  });
  const catalog = createPublicFilms({ store: setup.store, env, authority: createRentalAuthority(randomBytes(32)) });
  viewer = await makeServer(null, { catalog });
  await new Promise(resolve => viewer.listen(0, '127.0.0.1', resolve));
  env.STREAM_VIEWER_ORIGIN = 'http://127.0.0.1:' + viewer.address().port;
  const app = await makeServer(() => { throw Error('Setup fixture is private'); }, { setup });
  server = createServer((req, res) => {
    if (req.url === '/fixture/embed-host' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Two screenings</title>' + publishedEmbeds);
    }
    if (req.url === '/fixture/provider' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><a href="/setup/stripe/return">Return to Stream</a>');
    }
    app.emit('request', req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.STREAM_BROWSER_CHANNEL || 'chromium' });
  report.chromium = browser.version();
  for (const [mode, storage] of [['new', 'new'], ['existing', 'existing'], ['new', 'existing'], ['existing', 'new'], ['reuse', 'existing']]) {
    const first = !report.scenarios.length;
    const owner = 'qa-' + mode + '-' + storage;
    stripe.existingOAuth = mode !== 'reuse';
    const context = await browser.newContext({ viewport: first ? { width: 390, height: 844 } : { width: 1240, height: 850 } });
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || url.origin === env.STREAM_VIEWER_ORIGIN) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      page.on('response', response => {
        if (response.request().isNavigationRequest()) {
          const url = new URL(response.url());
          trace.push({ page: url.origin === origin ? url.pathname : url.hostname, status: response.status() });
        }
      });
      page.on('console', event => { if (event.type() === 'error' && event.text().includes('Content Security Policy')) trace.push({ problem: 'Page reported a Content Security Policy error' }); });
      page.setDefaultTimeout(8000);
      if (first) await checkAppearance(page, origin);
      await signIn(page, origin, owner);
      if (first) assert.equal(await page.getByRole('combobox', { name: 'Appearance' }).inputValue(), 'dark');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (evidence && (first || mode === 'reuse')) {
        await page.screenshot({ path: path.join(evidence, first ? 'setup-mobile.png' : 'setup-desktop.png'), fullPage: true });
      }
      if (storage === 'existing') await connectBucket(page, mode === 'reuse' ? 'selected keys' : 'manual', mode === 'existing');
      const previewWithoutPayments = mode === 'new' && storage === 'existing';
      if (!previewWithoutPayments) await finishStripe(page, mode, first);
      if (storage === 'new') await connectBucket(page, 'token', first);
      const privatePath = await registerFilm(page, first, origin, owner);
      if (previewWithoutPayments) {
        await openSection(page, 'payments');
        assert.equal(await page.locator('#payments .provider-status').textContent(), 'Not connected');
        await finishStripe(page, mode, false);
      }
      await openWorkspace(page, 'Dashboard');
      await page.getByRole('link', { name: 'Watch private preview' }).click();
      await page.waitForFunction(() => document.querySelector('video')?.duration === 10);
      await page.getByRole('link', { name: 'Back to film' }).click();
      assert.equal(await page.getByRole('link', { name: 'Watch private preview' }).getAttribute('href'), privatePath);
      await page.getByRole('button', { name: 'Add a film' }).click();
      await page.getByRole('heading', { name: 'Add a film' }).waitFor();
      assert.equal(await page.locator('#film [name="rightsAccepted"]').isChecked(), false);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.goto(origin + privatePath);
      assert.equal(await page.locator('video').count(), 0);
      await signIn(page, origin, owner);
      assert.equal(await page.getByRole('tab', { name: 'Film', exact: true }).count(), 0);
      if (mode === 'existing' && storage === 'existing') {
        await resetAndReconnect(page, owner, 'qa-new-new', privatePath);
      }
      if (first) {
        await openWorkspace(page, 'Dashboard');
        assert.equal(await page.getByRole('combobox', { name: 'Appearance' }).inputValue(), 'dark');
        assert.equal(await page.getByRole('tab').count(), 0);
        for (const width of [390, 1024]) {
          await page.setViewportSize({ width, height: 844 });
          const overview = await page.getByRole('heading', { name: 'Overview' }).boundingBox();
          const films = await page.getByRole('heading', { name: 'Films' }).boundingBox();
          assert.ok(overview && films && overview.y < films.y);
        }
        await page.getByRole('textbox', { name: 'Credits', exact: true }).fill('Directed by <Ada>');
        await page.getByRole('textbox', { name: 'Synopsis', exact: true }).fill('A short film.');
        await page.getByRole('button', { name: 'Save film details' }).click();
        await page.getByRole('button', { name: 'Publish film' }).click();
        const code = page.getByLabel('Embed code');
        await code.waitFor();
        const sharing = page.locator('.film-sharing');
        const frame = sharing.frameLocator('iframe');
        const publicUrl = env.STREAM_VIEWER_ORIGIN + '/embed/' + privatePath.split('/').pop();
        assert.equal(await sharing.locator('iframe').getAttribute('src'), publicUrl);
        assert.equal(await frame.locator('.film-info').count(), 0);
        const blankField = sharing.getByRole('checkbox', { name: 'Filmmaker message' });
        await blankField.check();
        assert.equal(await sharing.locator('iframe').getAttribute('height'), '480');
        await blankField.uncheck();
        await sharing.getByRole('checkbox', { name: 'Credits' }).check();
        assert.equal(await sharing.locator('iframe').getAttribute('height'), '576');
        await frame.getByText('Directed by <Ada>', { exact: true }).waitFor();
        assert.equal(await frame.getByText('A short film.').count(), 0);
        const embedUrl = await sharing.locator('iframe').getAttribute('src');
        const creditsCode = await code.inputValue();
        assert.equal(embedUrl, publicUrl + '?show=credits');
        assert.ok((await code.inputValue()).includes(embedUrl));
        assert.ok(!(await code.inputValue()).includes(savedKey));
        await page.getByRole('button', { name: 'Copy embed code' }).click();
        await page.locator('.copy-status').filter({ hasText: /copied|selected/ }).waitFor();
        await page.getByRole('textbox', { name: 'Credits', exact: true }).fill('Camera and sound by Bea');
        await page.getByRole('button', { name: 'Save film details' }).click();
        await frame.getByText('Camera and sound by Bea', { exact: true }).waitFor();
        assert.equal(await sharing.locator('iframe').getAttribute('src'), embedUrl);
        if (evidence) await sharing.screenshot({ path: path.join(evidence, 'film-embed-builder.png') });
        await sharing.getByRole('checkbox', { name: 'Credits' }).uncheck();
        await frame.getByText('Camera and sound by Bea').waitFor({state:'detached'});
        assert.equal(await sharing.locator('iframe').getAttribute('src'), publicUrl);
        const host = await context.newPage();
        try {
          publishedEmbeds = creditsCode + (await code.inputValue());
          await host.goto(origin + '/fixture/embed-host');
          const copies = host.locator('iframe');
          await copies.nth(0).contentFrame().getByText('Camera and sound by Bea', { exact: true }).waitFor();
          await copies.nth(1).contentFrame().getByRole('heading', { name: 'Projection test <first cut>' }).waitFor();
          assert.equal(await copies.nth(1).contentFrame().locator('.film-info').count(), 0);
        } finally { await host.close(); }
        const editor = page.getByRole('form', { name: 'Edit prices and playback for Projection test <first cut>' });
        for (const [width, columns] of [[320, 2], [390, 2], [1024, 4]]) {
          await page.setViewportSize({ width, height: 844 });
          const inputs = await editor.locator('input[type=number]').all();
          const bounds = await Promise.all(inputs.map(input => input.boundingBox()));
          assert.equal(bounds.length, 4);
          assert.ok(bounds.every(box => box && box.width <= 160 && box.height >= 44));
          assert.equal(new Set(bounds.map(box => box.y)).size, 4 / columns);
          assert.equal(bounds[0].y, bounds[1].y, 'Keep rental price and duration together');
          const fieldset = await editor.getByRole('group').boundingBox();
          const save = await editor.getByRole('button', { name: 'Save settings' }).boundingBox();
          const share = await page.getByRole('link', { name: 'Open public player' }).boundingBox();
          assert.ok(save.y - (fieldset.y + fieldset.height) >= 12);
          assert.ok(share.y - (save.y + save.height) >= 16);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.getByLabel('Free preview (seconds)').fill('0');
        await page.getByLabel('Rental duration (hours)').fill('12');
        await page.getByRole('button', { name: 'Save settings' }).click();
        assert.equal(new URL(page.url()).hash, '#' + privatePath.split('/').pop());
        await page.reload();
        await page.getByRole('form', { name: 'Edit prices and playback for Projection test <first cut>' }).waitFor();
        await page.getByRole('button', { name: 'Unpublish film' }).click();
        await page.getByRole('button', { name: 'Publish film' }).waitFor();
        assert.equal(await page.getByLabel('Embed code').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        report.filmmakerDashboard = 'create film, private preview, publish, copy independent embed selections, update saved details, change prices, unpublish';
      }
      report.scenarios.push({ stripe: mode, cloudflare: storage, savedPreviewSeconds: 10, resumed: true, previewWithoutPayments });
    } finally { await context.close(); }
  }
  assert.deepEqual(starts, ['new', 'resume', 'existing', 'new', 'new', 'existing', 'reuse']);
  assert.equal(outboundRequests, 0);
  assert.equal(guidedTokenAttempts, 3, 'Two guided connections and one unsuccessful token attempt');
  assert.equal(guidedKeyAttempts, 1);
  report.cloudflareSetup = { guidedTokenConnections: 2, selectedBucketWithKeyPair: 1, manualConnections: 2, handledWrongTokenAndKey: true };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.lastNavigations = trace.slice(-5);
  report.error = String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/[\w.-]{28,}/g, '[redacted]').slice(0, 400);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (viewer?.listening) await new Promise(resolve => viewer.close(resolve));
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  setup?.close();
  await rm(temporary, { recursive: true, force: true });
  if (evidence) await writeFile(path.join(evidence, 'setup-browser.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
