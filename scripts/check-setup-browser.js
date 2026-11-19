// Exercise the real setup routes, SQLite store, media inspection and forms with
// synthetic provider accounts. No Stripe or Cloudflare account is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
let browser, server, setup;
const trace = [];
const starts = [];
const callbacks = new Map();
const stripe = {
  configured: true, existingOAuth: true, mode: 'test',
  async start(ctx, intent) {
    assert.ok(['new', 'existing', 'reuse', 'resume'].includes(intent));
    starts.push(intent);
    ctx.state.accountId = 'acct_qa' + ctx.creatorId.replace(/[^a-z0-9]/gi, '');
    ctx.state.status = 'action_required';
    await ctx.save();
    return { redirect: '/fixture/provider' };
  },
  async callback(ctx) {
    const count = (callbacks.get(ctx.creatorId) || 0) + 1;
    callbacks.set(ctx.creatorId, count);
    ctx.state.status = ctx.creatorId === 'qa-new-new' && count === 1 ? 'action_required' : 'ready';
    ctx.state.businessName = 'Screening room test';
    await ctx.save();
    return { status: ctx.state.status };
  },
  async refresh(ctx) { return { status: ctx.state.status }; }
};

async function signIn(page, origin, owner) {
  await page.goto(origin + '/setup/sign-in');
  await page.getByLabel('Invitation code').fill(setup.store.invite(owner));
  await page.getByRole('button', { name: 'Open filmmaker setup' }).click();
  await page.getByRole('heading', { name: 'Filmmaker setup', exact: true }).waitFor();
}

async function finishStripe(page, mode, shouldResume) {
  const card = page.locator('#payments');
  const providerReturn = page.getByRole('link', { name: 'Return to Stream' });
  await card.locator(`button[name="mode"][value="${mode}"]`).click();
  await providerReturn.click();
  if (shouldResume) {
    await card.getByRole('button', { name: 'Continue Stripe setup' }).click();
    await providerReturn.click();
  }
  await card.locator('.provider-status').filter({ hasText: /^Connected$/ }).waitFor();
  await card.getByRole('button', { name: 'Check Stripe status' }).click();
}

async function connectBucket(page, cloudflare, recover) {
  const card = page.locator('#storage');
  if (cloudflare === 'new') {
    await card.getByText('Choose a Cloudflare account and bucket', { exact: true }).click();
    assert.ok(await card.getByText('New bucket.', { exact: true }).isVisible());
    assert.ok(await card.getByText('Existing bucket.', { exact: true }).isVisible());
    await card.getByText('Get a read-only key for this bucket', { exact: true }).click();
    assert.ok(await card.getByRole('link', { name: 'Cloudflare’s R2 token guide' }).isVisible());
  }
  async function fill(token) {
    await card.locator('[name="accountId"]').fill(accountId);
    await card.locator('[name="bucket"]').fill(bucket);
    await card.locator('[name="accessKeyId"]').fill(access);
    await card.locator('[name="secretAccessKey"]').fill(token);
    await card.locator('[name="privateConfirmed"]').check();
    await card.getByRole('button', { name: 'Connect private bucket' }).click();
  }
  if (recover) {
    await fill('intentionally-wrong-fixture-key');
    await page.getByRole('alert').waitFor();
    assert.equal(await card.locator('[name="secretAccessKey"]').inputValue(), '');
    assert.equal(await card.locator('[name="accessKeyId"]').inputValue(), '');
    assert.equal(await card.locator('[name="bucket"]').inputValue(), bucket);
    assert.equal(await card.locator('[name="accountId"]').inputValue(), accountId);
  }
  await fill(secret);
  await card.locator('.provider-status').filter({ hasText: /^Connected$/ }).waitFor();
  const markup = await page.content();
  assert.ok(!markup.includes(secret) && !markup.includes(access), 'Credentials stay out of rendered HTML');
}

async function registerFilm(page, shouldRecover, origin, owner) {
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
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    await section.getByLabel('Object key').fill('Incorrect/Short film.mp4');
    await section.getByRole('button', { name: 'Check film and create preview' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    assert.equal(await section.getByLabel('Object key').inputValue(), 'Incorrect/Short film.mp4');
  }
  await section.getByLabel('Object key').fill(savedKey);
  await section.getByRole('button', { name: 'Check film and create preview' }).click();
  const preview = section.getByRole('link', { name: 'Watch private preview' });
  await preview.waitFor();
  assert.ok(await section.getByRole('heading', { name: 'Projection test <first cut>' }).isVisible());
  return preview.getAttribute('href');
}

try {
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 });
  const generated = spawnSync(process.execPath, ['scripts/fixture.js', fixture], { stdio: 'pipe' });
  assert.equal(generated.status, 0, 'Generate the synthetic clip using FFmpeg');
  setup = await createSetup({
    directory: path.join(temporary, 'state'), stripe,
    async checkBucket(settings) { if (settings.secretAccessKey !== secret) throw Error('Test credential rejected'); },
    sourceFor(settings) {
      if (settings.objectKey !== savedKey) throw Error('Unknown test object');
      return createFileSource(fixture);
    }
  });
  const app = await makeServer(() => { throw Error('Setup fixture is private'); }, { setup });
  server = createServer((req, res) => {
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
        if (url.origin === origin) return route.continue();
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
      await signIn(page, origin, owner);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (evidence && (first || mode === 'reuse')) {
        await page.screenshot({ path: path.join(evidence, first ? 'setup-mobile.png' : 'setup-desktop.png'), fullPage: true });
      }
      if (storage === 'existing') await connectBucket(page, storage, false);
      const previewWithoutPayments = mode === 'new' && storage === 'existing';
      if (!previewWithoutPayments) await finishStripe(page, mode, first);
      if (storage === 'new') await connectBucket(page, storage, first);
      const privatePath = await registerFilm(page, first, origin, owner);
      if (previewWithoutPayments) {
        assert.equal(await page.locator('#payments .provider-status').textContent(), 'Not connected');
        await finishStripe(page, mode, false);
      }
      await page.getByRole('link', { name: 'Watch private preview' }).click();
      await page.waitForFunction(() => document.querySelector('video')?.duration === 10);
      await page.getByRole('link', { name: 'Back to filmmaker setup' }).click();
      await page.getByRole('button', { name: 'Add another film' }).click();
      await page.getByRole('heading', { name: 'Saved films' }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Projection test <first cut>' }).getAttribute('href'), privatePath);
      assert.equal(await page.locator('#film [name="rightsAccepted"]').isChecked(), false);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.goto(origin + privatePath);
      assert.equal(await page.locator('video').count(), 0);
      await signIn(page, origin, owner);
      assert.ok(await page.getByRole('heading', { name: 'Saved films' }).isVisible());
      report.scenarios.push({ stripe: mode, cloudflare: storage, savedPreviewSeconds: 10, resumed: true, previewWithoutPayments });
    } finally { await context.close(); }
  }
  assert.deepEqual(starts, ['new', 'resume', 'existing', 'new', 'existing', 'reuse']);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.lastNavigations = trace.slice(-5);
  report.error = String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/[\w.-]{28,}/g, '[redacted]').slice(0, 400);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  setup?.close();
  await rm(temporary, { recursive: true, force: true });
  if (evidence) await writeFile(path.join(evidence, 'setup-browser.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
