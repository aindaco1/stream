// Exercise the real setup routes, SQLite store, media inspection and forms with
// synthetic provider accounts. No Stripe or Cloudflare account is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicFilms } from '../src/public-films.js';
import sharp from 'sharp';
import { createThumbnails } from '../src/thumbnails.js';
import { thumbnailBucket, testWriterId, testWriterSecret } from '../test/fixtures/thumbnail-r2.js';
import { filmUploadBucket } from '../test/fixtures/film-upload-r2.js';
import { createRentalAuthority } from '../src/rental.js';
import { chromium } from 'playwright';
import { makeServer } from '../src/server.js';
import { createSetup } from '../src/setup.js';
import { createFileSource, createR2Source } from '../src/source.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'stream-setup-browser-'));
const evidence = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : null;
const fixture = path.join(temporary, 'clock.mp4');
const report = { providers: 'Synthetic Stripe and R2', scenarios: [] };
const savedKey = 'First cut/Short film.mp4';
const extensionlessKey = 'Masters/Final without extension';
const accountId = 'a'.repeat(32);
const bucket = 'screening-room-test';
const access = testWriterId;
const secret = testWriterSecret;
const replacementId = '9'.repeat(32);
const bucketUrl = `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${bucket}`;
const readToken = 'syntheticbucketreadtoken'.repeat(2);
let browser, server, viewer, setup;
let publishedEmbeds = '';
const trace = [];
const emails = [];
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
      assert.equal(country, intent === 'new' ? 'CA' : 'FR');
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

async function checkSiteFrame(page, signOutPath, guestSignIn = false) {
  const banner = page.getByRole('banner');
  assert.deepEqual(await banner.getByRole('link').allTextContents(), guestSignIn ? ['Stream', 'FAQ', 'Sign in'] : ['Stream', 'FAQ']);
  assert.equal(await banner.getByRole('combobox').count(), 0);
  const appearance = page.getByRole('contentinfo').getByRole('combobox', { name: 'Appearance' });
  await appearance.waitFor();
  assert.ok(await appearance.evaluate(select => {
    const control = select.getBoundingClientRect();
    const footer = select.closest('.site-footer-inner');
    const logo = footer.querySelector('a').getBoundingClientRect();
    return Math.abs(control.right - footer.getBoundingClientRect().right) <= 1 &&
      Math.abs((control.top + control.bottom) - (logo.top + logo.bottom)) <= 2;
  }), 'Appearance stays on the right of the footer beside the logo');
  const logout = banner.getByRole('button', { name: 'Sign out', exact: true });
  if (signOutPath) {
    await logout.waitFor();
    assert.equal(await logout.evaluate(button => new URL(button.form.action).pathname), signOutPath);
  } else {
    assert.equal(await logout.count(), 0);
  }
}

async function checkSignup(page, origin) {
  const email = 'new-filmmaker@example.test';
  const openEmail = async (button, destination) => {
    const message = emails.at(-1);
    assert.deepEqual(message.to, [email]);
    await page.goto(message.text.match(/http:\S+/)[0]);
    await page.getByRole('button', {name:button, exact:true}).click();
    await page.getByRole('heading', {name:destination, exact:true}).waitFor();
    await page.getByText('Signed in as ' + email).waitFor();
  };
  await page.goto(origin);
  await page.getByRole('heading', {name:'Rent your film on your own site.'}).waitFor();
  await checkSiteFrame(page, null, true);
  assert.equal(await page.getByLabel('Email address').count(), 0);
  const sample = page.getByLabel('A Trip Down Market Street', {exact:true});
  await page.getByRole('button', {name:'Play excerpt'}).click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
  assert.equal(await sample.evaluate(video => video.duration), 10);
  await page.getByRole('link', {name:'Sign up for free'}).click();
  await page.waitForURL(origin + '/admin/sign-up');
  const agree = page.getByRole('checkbox', {name:'I agree to the filmmaker agreement.'});
  assert.equal(await agree.isChecked(), false);
  await page.getByLabel('Email address').fill(email);
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', {name:'filmmaker agreement',exact:true}).click();
  const agreement = await opened;
  await agreement.getByRole('heading', {name:'Your film stays yours'}).waitFor();
  await checkSiteFrame(agreement);
  await agreement.close();
  assert.equal(await page.getByLabel('Email address').inputValue(),email);
  await checkSiteFrame(page, null, true);
  await agree.check();
  await page.getByRole('button',{name:'Email me a sign-up link'}).click();
  await page.getByRole('status').filter({hasText:/Check your inbox/}).waitFor();
  await openEmail('Agree and create account', 'Settings');
  await checkSiteFrame(page, '/setup/sign-out');
  await page.goto(origin);
  await page.waitForURL(origin + '/setup/dashboard');
  for (const path of ['/faq', '/setup/agreement/pilot-v1', '/admin/sign-in']) {
    await page.goto(origin + path);
    await checkSiteFrame(page, '/setup/sign-out');
  }
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(origin);
  await page.getByRole('link',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button',{name:'Email me a sign-in link'}).click();
  await page.getByRole('status').filter({hasText:/sign-in link will arrive/}).waitFor();
  await openEmail('Continue to Stream', 'Dashboard');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();

  await page.goto(origin + '/admin/sign-in#' + setup.store.invite('Test operator', 'admin'));
  await page.getByRole('button', { name: 'Continue to Stream' }).click();
  await page.waitForURL(origin + '/setup/admin');
  await page.goto(origin);
  await page.waitForURL(origin + '/setup/admin');
  for (const path of ['/faq', '/setup/agreement/pilot-v1']) {
    await page.goto(origin + path);
    await checkSiteFrame(page, '/setup/admin/sign-out');
  }
  await page.getByRole('banner').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(origin + '/admin/sign-in');
  await checkSiteFrame(page);
}

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
  await choice.click();
  await choice.selectOption('dark');
  await scheme('dark');
  assert.ok(await choice.evaluate(select => document.activeElement === select && getComputedStyle(select).outlineStyle === 'none'));
  // selectOption commits the value but Linux Chrome can leave the native picker open.
  await page.keyboard.press('Escape');
  await choice.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.ok(await choice.evaluate(select => document.activeElement === select && getComputedStyle(select).outlineStyle === 'solid'));
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
  // Bookmarked invitation links still carry their fragment to the shared sign-in page.
  await page.goto(origin + '/setup/sign-in#' + setup.store.invite(owner));
  await page.getByRole('button', { name: 'Continue to Stream' }).click();
  await page.waitForURL(origin + '/setup/dashboard');
  await page.goto(origin + '/setup/settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
}

async function checkFieldHelp(section) {
  const missing = await section.locator('input:not([type=hidden]), textarea, select').evaluateAll(fields =>
    fields.filter(field => !(field.getAttribute('aria-describedby') || '').split(' ').some(id =>
      document.getElementById(id)?.getAttribute('role') === 'tooltip')).map(field => field.name || field.type));
  assert.deepEqual(missing, [], 'Every field, including optional fields, has its own description');
}

async function checkBillingWidth(frame) {
  const billing = frame.locator('.film-credits').first();
  await billing.waitFor();
  const fits = await billing.evaluate(block => {
    const width = element => element.getBoundingClientRect().width;
    return Math.abs(width(block) - width(block.closest('.program-entry, .details'))) <= 2 &&
      getComputedStyle(block).whiteSpace === 'normal';
  });
  assert.ok(fits, 'Credits wrap across the full available width of the film or program entry');
}

async function checkOverviewHelp(page) {
  const overview = page.locator('#overview');
  const breakdown = overview.locator('.analytics-breakdown');
  assert.ok(await breakdown.locator('[data-stat="taxCollected"]').isVisible(), 'Tax and fees are visible in Overview');
  await breakdown.locator('summary').click();
  const buttons = overview.getByRole('button', {name:/^Help for /});
  assert.deepEqual(await buttons.allTextContents(),
    ['Paid plays','Avg. watch time','Rentals','Purchases','Net Revenue'].map(label => 'Help for ' + label));
  const [card, toggle] = await Promise.all([overview.locator('.analytics-summary').boundingBox(), breakdown.locator('summary').boundingBox()]);
  assert.ok(Math.abs(card.width - toggle.width) < 1, 'The disclosure fills the available width');
  await breakdown.locator('summary').click({position:{x:toggle.width - 8, y:toggle.height / 2}});
  const grid = await breakdown.locator('.film-stats').boundingBox();
  assert.ok(Math.abs(grid.width - card.width) < 1, 'The expanded metrics fill the card');
  assert.equal(await buttons.count(), await overview.locator('dt').count());
  await breakdown.locator('summary').click();
  const iconGap = await overview.locator('.metric-label-end').first().evaluate(end => {
    const text = document.createRange();
    text.selectNodeContents(end.firstChild);
    return end.querySelector('svg').getBoundingClientRect().left - text.getBoundingClientRect().right;
  });
  assert.ok(iconGap >= 0 && iconGap <= 6, 'The info icon sits next to the final word');
  const button = overview.getByRole('button', {name:'Help for Net Revenue',exact:true});
  const tip = page.getByRole('tooltip');
  await button.hover();
  await tip.waitFor();
  assert.match(await tip.innerText(), /card fees/);
  await page.keyboard.press('Escape');
  await tip.waitFor({state:'hidden'});
  await button.click();
  await tip.waitFor();
  await page.getByRole('heading', {name:'Overview',exact:true}).click();
  await tip.waitFor({state:'hidden'});
  await overview.getByRole('button', {name:'Help for Purchases',exact:true}).focus();
  await page.keyboard.press('Tab');
  await tip.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-expanded')), 'true');
  await page.keyboard.press('Escape');
  await tip.waitFor({state:'hidden'});
  assert.equal(await overview.getByRole('link',{name:'How these numbers are calculated'}).getAttribute('href'), '/setup/faq#dashboard-analytics');
}

async function checkTouchHelp(page) {
  const context = await page.context().browser().newContext({hasTouch:true, viewport:{width:320,height:568},
    storageState:await page.context().storageState()});
  try {
    const phone = await context.newPage();
    await phone.goto(page.url());
    const overview = phone.locator('#overview');
    assert.ok(await overview.locator('[data-stat="processingFees"]').isVisible());
    const trigger = overview.getByRole('button', {name:'Help for Stripe fees',exact:true});
    const tip = phone.getByRole('tooltip');
    await trigger.tap();
    await tip.waitFor();
    const bounds = await tip.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 568);
    await trigger.tap();
    await tip.waitFor({state:'hidden'});
    await overview.getByRole('link', {name:'How these numbers are calculated'}).tap();
    await phone.locator('#dashboard-analytics h2').waitFor();
    assert.ok(phone.url().endsWith('/faq#dashboard-analytics'));
  } finally { await context.close(); }
}

async function checkThumbnails(page, publicUrl, fixtureBucket) {
  const image = await sharp({ create: { width: 480, height: 480, channels: 3, background: '#526582' } }).png().toBuffer();
  const posterUrl = publicUrl.replace('/embed/', '/film/') + '/thumbnail.jpg';
  const privateRoute = '/setup/thumbnail/' + publicUrl.split('/').pop();
  const form = page.getByRole('form', { name: 'Thumbnail for Projection test <first cut>', exact: true });
  const section = form.locator('..');
  await checkFieldHelp(form);
  const save = form.getByRole('button', { name: 'Save thumbnail' });
  assert.equal(await form.locator('input[type=password]').count(), 0);
  assert.equal(await section.getByText(/1920 × 1080/).count(), 0);
  await form.getByRole('button', {name:'Help for Thumbnail image',exact:true}).click();
  assert.match(await page.getByRole('tooltip').innerText(), /1920 × 1080.*8 MB/);
  await page.keyboard.press('Escape');
  await form.getByLabel('Thumbnail image').setInputFiles({ name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(8 * 1024 ** 2 + 1) });
  await form.getByText('Choose a JPEG, PNG or WebP up to 8 MB.', { exact: true }).waitFor();
  assert.ok(await save.isDisabled());
  await form.getByLabel('Thumbnail image').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: image });
  await form.locator('canvas').waitFor();
  const desktopFile = await form.getByLabel('Thumbnail image').boundingBox();
  const desktopPreview = await form.locator('canvas').boundingBox();
  assert.ok(desktopPreview.x >= desktopFile.x + desktopFile.width && desktopPreview.width > desktopFile.width);
  await save.click();
  await form.getByText('Thumbnail saved.', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/setup/dashboard');
  const view = page.locator('.film-sharing iframe').contentFrame();
  await view.locator('video[poster]').waitFor();
  assert.ok(!(await view.locator('video').getAttribute('poster')).includes('cloudflare'));
  const first = await page.request.get(posterUrl);
  assert.equal(first.status(), 200);
  assert.equal((await sharp(await first.body()).metadata()).width, 480);
  await page.reload();
  await form.getByRole('button', { name: 'Adjust saved framing' }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  await form.locator('canvas').waitFor();
  const mobileFile = await form.getByLabel('Thumbnail image').boundingBox();
  const mobilePreview = await form.locator('canvas').boundingBox();
  const mobileZoom = await form.getByLabel('Zoom').boundingBox();
  assert.ok(mobilePreview.y >= mobileFile.y + mobileFile.height && mobileZoom.y >= mobilePreview.y + mobilePreview.height);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e =>
    e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + e.className));
  assert.deepEqual(overflow, [], 'No dashboard controls extend beyond the mobile viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (evidence) await section.screenshot({ path: path.join(evidence, 'thumbnail-editor-mobile.png') });
  await form.getByLabel('Zoom').fill('200');
  await save.click();
  await form.getByText('Thumbnail saved.', { exact: true }).waitFor();
  const cropped = await page.request.get(posterUrl);
  assert.equal((await sharp(await cropped.body()).metadata()).width, 240);
  await page.getByRole('button', { name: 'Unpublish film' }).click();
  await page.getByRole('button', { name: 'Publish film' }).waitFor();
  assert.equal((await page.request.get(posterUrl)).status(), 404);
  assert.equal((await page.request.get(new URL(privateRoute + '/source.jpg', page.url()).href)).status(), 200);
  await form.getByRole('button', { name: 'Adjust saved framing' }).click();
  await form.locator('canvas').waitFor();
  assert.equal(await form.getByLabel('Zoom').inputValue(), '200');
  page.once('dialog', dialog => dialog.accept());
  await form.getByRole('button', { name: 'Delete thumbnail' }).click();
  await form.getByText('Thumbnail deleted.', { exact: true }).waitFor();
  assert.equal(fixtureBucket.objects.size, 0);
  await page.getByRole('button', { name: 'Publish film' }).click();
  await view.locator('video:not([poster])').waitFor();
  assert.equal((await page.request.get(posterUrl)).status(), 404);
  report.thumbnail = { oversizedFileRejected: true, firstPosterWidth: 480, reframedPosterWidth: 240,
    preservedFramingAfterReload: true, publicPosterRemoved: true };
}
async function openWorkspace(page, name) {
  if (await page.getByRole('heading', { name, exact: true, level: 1 }).isVisible()) return;
  const menu = page.locator('.workspace-nav select');
  await menu.waitFor({ state: 'attached' });
  if (await menu.isVisible()) await menu.selectOption({ Dashboard: '/setup/dashboard', Settings: '/setup/settings' }[name]);
  else await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
}

async function openSection(page, id) {
  await openWorkspace(page, 'Settings');
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
    await choice.selectOption(mode === 'new' ? 'CA' : 'FR');
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
  await page.locator('.dashboard-film > summary').click();
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

async function confirmStorageAccess(form) {
  assert.equal(await form.locator('[name="storageAccess"]').inputValue(), 'uploads');
  await form.locator('[name="privateConfirmed"]').check();
  await form.locator('[name="uploadConsent"]').check();
}

async function submitKeyPair(form, key, buttonLabel, keyId = access) {
  await form.locator('[name="accessKeyId"]').fill(keyId);
  await form.locator('[name="secretAccessKey"]').fill(key);
  await confirmStorageAccess(form);
  await form.getByRole('button', { name: buttonLabel }).click();
}

async function checkBucketTokenLinks(page) {
  for (const [type, label] of [['account', 'Create an account token'], ['user', 'Create a user token']]) {
    const href = await page.getByRole('link', { name: label, exact: true }).getAttribute('href');
    assert.equal(href, `https://dash.cloudflare.com/${accountId}/r2/api-tokens/create?type=${type}`);
  }
  const instructions = await page.locator('main ol').innerText();
  assert.ok(instructions.includes('Object Read & Write') && instructions.includes('Apply to specific buckets only') && instructions.includes(bucket));
}

async function connectBucket(page, method, recover) {
  await openSection(page, 'storage');
  const card = page.locator('#storage');
  await checkFieldHelp(card);
  if (method !== 'manual') {
    const dashboard = await card.getByRole('link', { name: 'Open Cloudflare R2' }).getAttribute('href');
    assert.equal(new URL(dashboard).origin, 'https://dash.cloudflare.com');
    await card.getByLabel('Bucket dashboard URL').fill(bucketUrl);
    await card.getByRole('button', { name: 'Continue with this bucket' }).click();
    const token = page.getByLabel('R2 token value');
    await token.waitFor();
    await checkBucketTokenLinks(page);
    await checkFieldHelp(page.locator('main'));
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
        await confirmStorageAccess(form);
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
      const form = card.locator('form').filter({ has: page.locator('[name="accessKeyId"]') });
      await submitKeyPair(form, token, 'Connect private bucket');
    }
    if (recover) {
      await card.getByText('Enter connection details manually', { exact: true }).click();
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

async function replaceBucketKey(page, owner) {
  const storage = page.locator('#storage');
  await storage.getByRole('link', { name: 'Use a different bucket' }).click();
  assert.ok(await storage.getByLabel('Bucket dashboard URL').isVisible());
  await page.reload();
  await storage.getByRole('link', { name: 'Cancel bucket change' }).click();
  assert.equal(await storage.getByLabel('Bucket dashboard URL').count(), 0);
  await storage.getByRole('link', { name: 'Replace R2 key' }).click();
  await page.getByRole('heading', { name: 'Replace R2 key' }).waitFor();
  await checkBucketTokenLinks(page);
  const token = page.getByLabel('R2 token value');
  const form = page.locator('form').filter({ has: token });
  assert.equal(await form.locator('[name=bucketUrl]').inputValue(), bucketUrl);
  assert.equal(await page.locator('[name=accountId], input[type=url]').count(), 0);
  const active = setup.store.maker(owner).r2;
  const previous = setup.store.uploadCredentials(owner, active);
  await token.fill('invalidsyntheticreplacementtoken'.repeat(2));
  await confirmStorageAccess(form);
  await form.getByRole('button', { name: 'Save replacement key' }).click();
  await page.getByRole('alert').waitFor();
  assert.deepEqual(setup.store.uploadCredentials(owner, active), previous);
  assert.equal(await token.inputValue(), '');
  await page.getByText('Use an existing access key pair', { exact: true }).click();
  const pair = page.locator('form').filter({ has: page.locator('[name=accessKeyId]') });
  await submitKeyPair(pair, secret, 'Save replacement key', replacementId);
  await storage.getByRole('link', { name: 'Replace R2 key' }).waitFor();
  assert.deepEqual(setup.store.maker(owner).r2, active);
  assert.deepEqual(setup.store.uploadCredentials(owner, active), { ...previous, accessKeyId: replacementId });
  report.keyReplacement = { keptBucket: true, rejectedKeyPreservedAccess: true, savedKeyPair: true, separateBucketChoice: true };
}

async function registerFilm(page, shouldRecover, origin, owner) {
  await openWorkspace(page, 'Dashboard');
  await page.getByRole('link', { name: 'Add a film' }).click();
  const section = page.locator('#film');
  assert.equal(await section.getByLabel('Video file').count(), 0);
  assert.equal(await section.locator('[name="objectKey"]').count(), 0);
  await section.locator('[name="rightsAccepted"]').check();
  await section.getByRole('button', { name: 'Confirm rights and continue' }).click();
  async function chooseBucketVideo(key) {
    const object = section.getByLabel('Video in your bucket');
    if (!await object.isVisible()) await section.getByText('Use an existing file', { exact: true }).click();
    if (key === savedKey && !await object.locator('option').evaluateAll((options, key) => options.some(o => o.value === key), key)) {
      await section.getByRole('button', {name:'Load more files'}).click();
    }
    await object.selectOption(key);
  }
  await section.getByLabel('Film title').fill('Projection test <first cut>');
  if (shouldRecover) {
    await section.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, origin, owner);
    await openWorkspace(page, 'Dashboard');
    await page.getByRole('link', { name: 'Continue film draft' }).click();
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    await chooseBucketVideo('Incorrect/Short film.mp4');
    await section.getByRole('button', { name: 'Check film and create preview' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await section.getByLabel('Film title').inputValue(), 'Projection test <first cut>');
    assert.equal(await section.getByLabel('Video in your bucket').inputValue(), 'Incorrect/Short film.mp4');
  }
  await chooseBucketVideo(savedKey);
  if (shouldRecover) {
    const picker = section.getByLabel('Video in your bucket');
    assert.equal(await picker.locator('option[value="art/poster.jpg"]').count(),0);
    await section.getByLabel('Show all files').check();
    await chooseBucketVideo('art/poster.jpg');
    await section.getByRole('button', {name:'Preview selected video'}).click();
    await section.locator('[data-file-status]').filter({hasText:'This preview could not be prepared'}).waitFor();
    await chooseBucketVideo(extensionlessKey);
    await section.getByRole('button', {name:'Preview selected video'}).click();
    await section.locator('[data-file-preview]').waitFor({ state:'visible' });
    await page.waitForFunction(() => document.querySelector('[data-file-preview]')?.readyState >= 2);
    assert.ok(await section.locator('[data-file-preview]').evaluate(video => video.duration > 0 && video.duration <= 3.1));
  }
  await section.getByRole('button', { name: 'Check film and create preview' }).click();
  const preview = page.getByRole('link', { name: 'Watch private preview' });
  await preview.waitFor();
  assert.ok(await page.getByText('Projection test <first cut>', { exact: true }).isVisible());
  return preview.getAttribute('href');
}

async function checkFilmUpload(page, movies) {
  await page.getByRole('link', { name: 'Add a film' }).click();
  const section = page.locator('#film');
  const video = section.getByLabel('Video file');
  assert.equal(await video.count(), 0);
  await section.locator('[name="rightsAccepted"]').check();
  await section.getByRole('button', { name: 'Confirm rights and continue' }).click();
  const title = 'Uploaded second screening';
  await section.getByLabel('Film title').fill(title);
  const clip = await readFile(fixture);
  // A standard MP4 free-space box lets the tiny synthetic film exercise two
  // upload parts without changing its tracks or generating a longer film.
  const padding = Buffer.alloc(Math.max(8, 8 * 1024 ** 2 + 4096 - clip.length));
  padding.writeUInt32BE(padding.length);
  padding.write('free', 4);
  const original = Buffer.concat([clip, padding]);
  await video.setInputFiles({ name: 'second screening.mp4', mimeType: 'video/mp4', buffer: original });
  await section.getByRole('button', { name: 'Check film and create preview' }).click();
  const card = page.locator('.dashboard-film').filter({ has: page.getByText(title, { exact: true }) });
  await card.waitFor();
  assert.equal(movies.objects.size, 1);
  const [[key, object]] = movies.objects;
  assert.match(key, /^stream-films\/[a-f\d-]{36}\.mp4$/);
  assert.ok(original.equals(object.data), 'The private bucket contains the exact selected MP4');
  assert.deepEqual(movies.calls.filter(call => call.method === 'PUT').map(call => call.query.get('partNumber')), ['1', '2']);
  await card.getByRole('link', { name: 'Watch private preview' }).click();
  await page.waitForFunction(() => document.querySelector('video')?.duration === 10);
  await page.getByRole('link', { name: 'Back to film' }).click();
  const editor = card.locator('.thumbnail-editor');
  const otherCard = page.locator('.dashboard-film').filter({ hasText: 'Projection test <first cut>' });
  const other = otherCard.locator('.thumbnail-editor');
  await editor.waitFor();
  assert.equal(await page.locator('.thumbnail-editor').count(), 2);
  const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#896c50' } }).png().toBuffer();
  await editor.getByLabel('Thumbnail image').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: image });
  await editor.locator('canvas').waitFor();
  await editor.getByRole('button', { name: 'Save thumbnail' }).click();
  await editor.getByText('Thumbnail saved.', { exact: true }).waitFor();
  assert.equal(await otherCard.getAttribute('open'), null);
  assert.ok(await card.locator('.thumbnail-poster').isVisible());
  await otherCard.locator('summary').first().click();
  assert.equal(await card.getAttribute('open'), null);
  assert.ok(await other.getByRole('button', { name: 'Save thumbnail' }).isDisabled());
  assert.ok(await otherCard.locator('.thumbnail-poster').isHidden());
  assert.ok(original.equals(object.data), 'A poster edit leaves the uploaded film intact');
  report.filmUpload = { parts: 2, bytes: object.data.length, privatePreviewSeconds: 10, thumbnailIsolated: true };
}

async function checkProgramEditor(page) {
  assert.equal(await page.locator('#films').getByRole('button', {name:'Create program'}).count(), 0);
  await page.locator('#programs button.primary').filter({hasText:'Create program'}).click();
  const form = page.locator('.program-editor');
  await checkFieldHelp(form);
  const previewLength = form.getByLabel('Free preview (seconds)');
  assert.equal(await previewLength.getAttribute('max'), '180');
  await previewLength.fill('180');
  await form.getByLabel('Program title').fill('Two projections');
  await page.setViewportSize({width:320,height:780});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'program editor fits a narrow phone');
  await page.setViewportSize({width:1024,height:840});
  const first = 'Projection test <first cut>', second = 'Uploaded second screening';
  await form.getByRole('checkbox', {name:first,exact:true}).check();
  await form.getByRole('checkbox', {name:second,exact:true}).check();
  await form.getByRole('button', {name:'Move ' + second + ' up'}).click();
  const source = form.locator('[data-slot=films] li').first();
  assert.equal(await source.locator('label span').innerText(), second);
  const max = Math.min(180, Math.floor(Number(await source.getAttribute('data-duration'))) - 1);
  assert.equal(await previewLength.getAttribute('max'), String(max));
  assert.equal(await form.locator('.price-fields [data-preview-max]').textContent(), String(max));
  assert.ok(Number(await previewLength.inputValue()) <= max);
  await form.getByLabel('Rental price (USD)').fill('4');
  await form.getByLabel('Download purchase').fill('');
  await form.getByLabel('Free preview (seconds)').fill('4');
  await form.getByRole('button', {name:'Add a new opening video'}).click();
  await page.getByRole('heading', {name:'Add opening video'}).waitFor();
  await page.locator('[name=rightsAccepted]').check();
  await page.getByRole('button', {name:'Confirm rights and continue'}).click();
  await page.getByRole('link', {name:'Back to program'}).click();
  await form.getByRole('button', {name:'Add a new opening video'}).click();
  await page.getByLabel('Video title').fill('Meet the director');
  await page.getByLabel('Video file').setInputFiles({name:'opening.mp4',mimeType:'video/mp4',buffer:await readFile(fixture)});
  await page.getByRole('button', {name:'Add video to program'}).click();
  await form.waitFor();
  assert.equal(await form.locator('select[name=opening] option:checked').textContent(), 'Meet the director');
  assert.deepEqual(await form.locator('[data-slot]').evaluateAll(slots => slots.map(slot => slot.dataset.slot)), ['opening','films','closing']);
  const intro = await form.locator('select[name=opening]').inputValue();
  assert.equal(await form.locator('.program-library li:visible').filter({hasText:'Meet the director'}).count(), 0);
  // Reassign an extra. It should appear in exactly one slot and never as a selectable main film.
  await form.getByLabel('Opening video', {exact:true}).selectOption('');
  assert.equal(await form.locator('.program-choices').getByText('Meet the director').count(),0);
  await form.getByLabel('Closing video', {exact:true}).selectOption(intro);
  assert.equal(await form.locator('select[name=closing] option:checked').textContent(), 'Meet the director');
  assert.equal(await form.locator('.program-library li:visible').filter({hasText:'Meet the director'}).count(), 0);
  await form.getByLabel('Closing video', {exact:true}).selectOption('');
  await form.getByLabel('Opening video', {exact:true}).selectOption(intro);
  await form.getByLabel('Preview video').selectOption({label:'Meet the director'});
  await form.getByLabel('Opening title in this program').fill('Before the screening');
  await form.getByLabel('Curated by').fill('Maya & Lee');
  const img = await sharp({create:{width:320,height:180,channels:3,background:'#898989'}}).jpeg().toBuffer();
  await page.getByLabel('Thumbnail image').setInputFiles({name:'program.jpg',mimeType:'image/jpeg',buffer:img});
  await page.locator('.thumbnail-editor canvas').waitFor();
  await page.getByRole('button',{name:'Save thumbnail'}).click();
  await page.getByText('Thumbnail saved.',{exact:true}).waitFor();
  await form.getByRole('button', {name:'Save and preview'}).click();
  await page.waitForFunction(() => document.querySelector('video')?.duration === 4);
  const entry = page.locator('.private-lineup li').first();
  assert.equal(await entry.locator('h3').innerText(), 'Before the screening');
  assert.match(await entry.locator('.program-runtime').innerText(), /^Opening · /);
  assert.equal(await page.locator('.private-lineup details').count(),0);
  await page.getByRole('link',{name:'Back to program'}).click();
  await form.getByLabel('I own these videos', {exact:false}).check();
  await form.getByRole('button',{name:'Publish program',exact:true}).click();
  const card = page.locator('#programs details.dashboard-film').first();
  await card.getByRole('heading',{name:'Embed this program'}).waitFor();
  for (const header of [page.locator('#films .dashboard-film > summary').first(), card.locator(':scope > summary')]) {
    await header.hover();
    const corners = await header.evaluate(el => {
      const style = getComputedStyle(el), parent = getComputedStyle(el.parentElement);
      return { top:parseFloat(style.borderTopLeftRadius), bottom:parseFloat(style.borderBottomLeftRadius),
        inside:parseFloat(parent.borderTopLeftRadius) - parseFloat(parent.borderLeftWidth), open:el.parentElement.open };
    });
    assert.ok(corners.inside > 0);
    assert.equal(corners.top,corners.inside);
    assert.equal(corners.bottom,corners.open ? 0 : corners.inside);
  }
  const preview = card.locator('.film-sharing iframe');
  assert.deepEqual(new URL(await preview.getAttribute('src')).searchParams.get('show').split(','), ['synopsis','byline','credits','message']);
  const posterStyle = card.getByLabel('Poster style');
  assert.equal(await posterStyle.inputValue(), 'broadside');
  const programFrame = preview.contentFrame();
  await programFrame.locator('body[data-poster=broadside] .poster-head #film-title').waitFor();
  await programFrame.getByText('Curated by Maya & Lee', {exact:true}).waitFor();
  await programFrame.getByText('A film by Ada & Jo', {exact:true}).waitFor();
  await checkBillingWidth(programFrame);
  await card.getByRole('checkbox', {name:'Bylines'}).uncheck();
  await programFrame.getByText('Curated by Maya & Lee', {exact:true}).waitFor({state:'detached'});
  assert.equal(await programFrame.locator('.member-byline').count(), 0);
  const embedUrl = await preview.getAttribute('src');
  const publishedBuy = async () => {
    const response = await page.request.get(embedUrl);
    assert.equal(response.status(),200);
    return /data-buy="([^"]*)"/.exec(await response.text())[1];
  };
  const pricing = card.getByRole('complementary',{name:'Unpublished pricing'});
  assert.equal(await publishedBuy(),'');
  await card.getByRole('link',{name:'Edit program'}).click();
  await form.getByLabel('Download purchase').fill('10');
  await form.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByRole('link',{name:'Back to Dashboard'}).click();
  await pricing.waitFor();
  assert.equal(await pricing.locator('p').first().innerText(),'Published Rent $4.00 for 48 hours');
  assert.match(await pricing.locator('p').nth(1).innerText(),/Buy for \$10\.00 with ZIP download/);
  assert.equal(await publishedBuy(),'','a draft cannot start a public purchase');
  await pricing.getByRole('link',{name:'Preview saved draft'}).click();
  await page.getByText(/Buy for \$10\.00 with ZIP download/).waitFor();
  await page.getByRole('link',{name:'Back to program'}).click();
  await form.getByRole('button',{name:'Publish changes'}).click();
  await card.getByRole('heading',{name:'Published embed preview'}).waitFor();
  assert.equal(await publishedBuy(),'1000','an existing embed gets the published download price');
  assert.equal(await pricing.count(),0,'no pending prices after publication');
  for (const input of await card.getByRole('checkbox').all()) await input.uncheck();
  await checkFieldHelp(card);
  assert.match(await card.getByLabel('Embed code').inputValue(),/show=none/);
  for (const width of [320, 1024]) {
    await page.setViewportSize({width,height:840});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.equal(await page.locator('#films .film-title').allTextContents().then(names => names.includes('Meet the director')), false);
  await page.getByRole('button',{name:'Add a film',exact:true}).waitFor();
  await card.getByRole('link',{name:'Edit program'}).click();
  assert.equal(await form.getByLabel('Opening title in this program').inputValue(), 'Before the screening');
  await form.getByRole('button',{name:'Replace opening video'}).click();
  await page.locator('[name=rightsAccepted]').check();
  await page.getByRole('button',{name:'Confirm rights and continue'}).click();
  await page.getByLabel('Video title').fill('Replacement introduction');
  await page.getByLabel('Video file').setInputFiles({name:'replacement.mp4',mimeType:'video/mp4',buffer:await readFile(fixture)});
  await page.getByRole('button',{name:'Add video to program'}).click();
  await form.waitFor();
  assert.equal(await form.getByLabel('Preview video').locator('option:checked').textContent(), 'Replacement introduction');
  assert.equal(await form.getByLabel('Opening video',{exact:true}).locator('option').filter({hasText:'Meet the director'}).count(),0);
  await form.getByRole('button',{name:'Remove opening'}).click();
  await page.getByText('Video removed from the draft. The original stays in your bucket.',{exact:true}).waitFor();
  assert.equal(await form.getByLabel('Opening video',{exact:true}).inputValue(),'');
  assert.equal(await form.getByLabel('Preview video').inputValue(),'');
  assert.equal(await form.getByLabel('Opening video',{exact:true}).locator('option').filter({hasText:'Replacement introduction'}).count(),0);
  await page.getByRole('link',{name:'Back to Dashboard'}).click();
  await card.locator(':scope > summary').filter({hasText:'Published'}).waitFor();
  await card.getByRole('button',{name:'Unpublish program'}).click();
  await card.getByText(/Draft · 2 films/).waitFor();
  report.programEditor = { orderedFilms:2, privateOpeningUpload:true, renameReplaceRemove:true, roundedHover:true, privatePreviewSeconds:4, programArtwork:true, publishedAndWithdrawn:true };
}

async function checkLegacyBucketUpgrade(page, owner) {
  // Before uploads, a saved bucket configuration had no upload flag.
  setup.store.saveBucket(owner, { accountId, bucket, jurisdiction: 'default',
    accessKeyId: '5'.repeat(32), secretAccessKey: '6'.repeat(64) });
  await openWorkspace(page, 'Dashboard');
  const card = page.locator('.dashboard-film');
  await card.locator('summary').first().click();
  assert.equal(await card.locator('.thumbnail-editor').count(), 0);
  await card.getByRole('link', { name: 'Enable uploads for this bucket' }).click();
  const token = page.getByLabel('R2 token value');
  const form = page.locator('form').filter({ has: token });
  assert.equal(await form.locator('[name="bucketUrl"]').inputValue(), bucketUrl);
  await token.fill(readToken);
  await confirmStorageAccess(form);
  await form.getByRole('button', { name: 'Connect private bucket' }).click();
  await card.getByLabel('Thumbnail image').waitFor();
  assert.equal(new URL(page.url()).hash, '#thumbnail-' + await card.getAttribute('id'));
  assert.equal(await card.locator('input[type=password]').count(), 0);
  report.legacyBucketUpgrade = true;
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
  const env = { STRIPE_CONNECT_SECRET_KEY: 'sk_test_localfixture', RESEND_API_KEY: 'fixture',
    STREAM_RECOVERY_FROM: 'workspace@example.test', STREAM_TURNSTILE_SITE_KEY: 'fixture', STREAM_TURNSTILE_SECRET_KEY: 'fixture' };
  const artwork = thumbnailBucket();
  const movies = filmUploadBucket();
  setup = await createSetup({ thumbnailFetch: artwork.fetcher, uploadFetch: async request => {
    const params = new URL(request.url).searchParams;
    if (params.get('list-type') !== '2') return movies.fetcher(request);
    const hasMore = !params.has('continuation-token');
    const files = hasMore ? ['Incorrect/Short film.mp4', 'art/poster.jpg', extensionlessKey] : [savedKey];
    return new Response('<ListBucketResult><IsTruncated>' + hasMore + '</IsTruncated>' +
      files.map(key => '<Contents><Key>' + encodeURIComponent(key) + '</Key><Size>100000</Size></Contents>').join('') +
      (hasMore ? '<NextContinuationToken>next-page</NextContinuationToken>' : '') + '</ListBucketResult>');
  },
    directory: path.join(temporary, 'state'), stripe, env,
    verifyChallenge: async (_req, _env, token, {action}) => token === 'fixture-' + action ? {ok:true} : {ok:false,status:400},
    mailFetch: async (_url, req) => { emails.push(JSON.parse(req.body)); return new Response('{}'); },
    async resolveBucket({ bucketUrl: location, privateConfirmed, tokenValue, accessKeyId, secretAccessKey, uploadConsent, storageAccess }) {
      assert.equal(location, bucketUrl);
      assert.equal(privateConfirmed, 'yes');
      assert.equal(uploadConsent, 'yes');
      assert.equal(storageAccess, 'uploads');
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
      if (![access, replacementId].includes(settings.accessKeyId) || settings.secretAccessKey !== secret) throw Error('Test credential rejected');
    },
    sourceFor(settings) {
      if (movies.objects.has(settings.objectKey)) return createR2Source(settings, movies.fetcher);
      if (![savedKey, extensionlessKey].includes(settings.objectKey)) throw Error('Unknown test object');
      return createFileSource(fixture);
    }
  });
  const catalog = createPublicFilms({ store: setup.store, env, thumbnails: createThumbnails(setup.store, artwork.fetcher), authority: createRentalAuthority(randomBytes(32)) });
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
        if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/api.js') {
          return route.fulfill({contentType:'text/javascript', body:`{ const widget = document.querySelector('.cf-turnstile');
            const field = document.createElement('input'); field.type='hidden'; field.name='cf-turnstile-response';
            field.value='fixture-' + widget.dataset.action; widget.append(field); }`});
        }
        if (url.origin === origin || url.origin === env.STREAM_VIEWER_ORIGIN) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', e => trace.push({ problem: e.message }));
      page.on('response', response => {
        if (response.request().isNavigationRequest()) {
          const url = new URL(response.url());
          trace.push({ page: url.origin === origin ? url.pathname : url.hostname, status: response.status() });
        }
      });
      page.on('console', event => { if (event.type() === 'error' && event.text().includes('Content Security Policy')) trace.push({ problem: 'Page reported a Content Security Policy error' }); });
      page.setDefaultTimeout(8000);
      if (first) {
        await checkSignup(page, origin);
        await checkAppearance(page, origin);
        await page.goto(origin + '/setup/sign-in');
        await page.locator('header').getByRole('link', { name: 'FAQ', exact: true }).click();
        await page.getByRole('heading', { name: 'What does it cost?' }).waitFor();
        await page.locator('#countries + #embed + #payouts:has(+ #costs)').getByRole('heading', {name:'Who owns my film and how do I get paid?'}).waitFor();
        await checkSiteFrame(page);
        assert.equal(await page.getByRole('combobox', {name:'Appearance'}).inputValue(), 'dark');
        assert.ok(await page.evaluate(() => Math.abs(document.querySelector('.faq-intro').offsetWidth - document.querySelector('main').clientWidth) <= 1));
        const footer = page.getByRole('contentinfo');
        assert.equal(await footer.getByRole('link').count(), 1);
        assert.ok(await footer.getByText(/DUST WAVE/).isVisible());
        await footer.locator('img').evaluate(image => image.decode());
        assert.ok(await page.getByRole('link', { name: 'Cloudflare R2 pricing' }).isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await signIn(page, origin, owner);
      await page.locator('#storage[role=tabpanel]').waitFor();
      assert.equal(await page.locator('#payments').isVisible(), false);
      assert.deepEqual(await page.locator('.subtabs [role=tab]').allTextContents(), ['Storage', 'Payments']);
      if (first) assert.equal(await page.getByRole('combobox', { name: 'Appearance' }).inputValue(), 'dark');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (evidence && (first || mode === 'reuse')) {
        await page.screenshot({ path: path.join(evidence, first ? 'setup-mobile.png' : 'setup-desktop.png'), fullPage: true });
      }
      if (first) {
        for (const topic of ['payments', 'storage']) {
          await openSection(page, topic);
          await page.locator('#' + topic + ' a[href="/setup/faq#' + topic + '"]').click();
          assert.equal(new URL(page.url()).hash, '#' + topic);
          await page.locator('section:target h2').waitFor({state:'visible'});
          assert.ok(await page.getByRole('button',{name:'Sign out'}).isVisible());
          await page.goBack();
        }
        await page.goto(origin + '/setup#payments');
        await page.locator('#payments[role=tabpanel]').waitFor();
        assert.equal(new URL(page.url()).pathname, '/setup/settings');
        assert.deepEqual(await page.locator('.workspace-nav .tab-bar a').allTextContents(), ['Dashboard', 'Settings']);
        report.pricing = { publicFaq: true, settingsDeepLinks: true, oldSetupLink: true };
      }
      if (storage === 'existing') await connectBucket(page, mode === 'reuse' ? 'selected keys' : 'manual', mode === 'existing');
      const previewWithoutPayments = mode === 'new' && storage === 'existing';
      if (!previewWithoutPayments) await finishStripe(page, mode, first);
      if (storage === 'new') await connectBucket(page, 'token', first);
      if (first) await replaceBucketKey(page, owner);
      const privatePath = await registerFilm(page, first, origin, owner);
      if (previewWithoutPayments) {
        await openSection(page, 'payments');
        assert.equal(await page.locator('#payments .provider-status').textContent(), 'Not connected');
        await finishStripe(page, mode, false);
      }
      await openWorkspace(page, 'Dashboard');
      const filmRow = page.locator('details.dashboard-film');
      if (!await filmRow.evaluate(el => el.open)) await filmRow.locator('summary').first().click();
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
        await checkOverviewHelp(page);
        await checkTouchHelp(page);
        await checkFieldHelp(page.locator('#films'));
        assert.equal(await page.locator('.dashboard-film[open]').count(), 0);
        const mainWidth = await page.locator('main').boundingBox();
        assert.ok(mainWidth.width > 920, 'Use the desktop width for the dashboard');
        const summary = page.locator('.dashboard-film > summary');
        await summary.focus();
        await summary.press('Enter');
        const billing = page.locator('.credit-editor');
        const rows = billing.locator('.credit-row');
        const credits = rows.first().getByRole('textbox', { name: 'Name or credit', exact: true });
        await credits.fill('Directed by <Ada>');
        await summary.press('Space');
        assert.ok(await credits.isHidden());
        await summary.press('Enter');
        assert.equal(await credits.inputValue(), 'Directed by <Ada>');
        await page.getByRole('textbox', { name: 'Synopsis', exact: true }).fill('A short film.');
        await page.getByRole('button', { name: 'Save film details' }).click();
        await page.getByRole('button', { name: 'Publish film' }).click();
        const code = page.getByLabel('Embed code');
        await code.waitFor();
        const sharing = page.locator('.film-sharing');
        const frame = sharing.frameLocator('iframe');
        const publicUrl = env.STREAM_VIEWER_ORIGIN + '/embed/' + privatePath.split('/').pop();
        await checkThumbnails(page, publicUrl, artwork);
        assert.equal(await sharing.locator('iframe').getAttribute('src'), publicUrl + '?poster=broadside');
        assert.equal(await frame.locator('.film-info').count(), 0);
        const blankField = sharing.getByRole('checkbox', { name: 'Filmmaker message' });
        await blankField.check();
        assert.equal(await sharing.locator('iframe').getAttribute('height'), '610');
        await blankField.uncheck();
        await page.setViewportSize({ width: 1024, height: 844 });
        const controlOffsets = () => sharing.evaluate(section => {
          const top = section.getBoundingClientRect().top;
          return ['h3', 'form', '.embed-code', '.copy-embed'].map(selector =>
            Math.round(section.querySelector(selector).getBoundingClientRect().top - top));
        });
        const stylePicker = sharing.getByLabel('Poster style');
        await stylePicker.selectOption('broadside');
        await frame.locator('body[data-poster=broadside] .poster-head #film-title').waitFor();
        const defaultOffsets = await controlOffsets();
        await sharing.getByRole('checkbox', { name: 'Credits' }).check();
        assert.equal(await sharing.locator('iframe').getAttribute('height'), '658');
        assert.deepEqual(await controlOffsets(), defaultOffsets, 'Growing the preview must preserve control spacing');
        await frame.getByText('Directed by <Ada>', { exact: true }).waitFor();
        assert.equal(await frame.getByText('A short film.').count(), 0);
        const embedUrl = await sharing.locator('iframe').getAttribute('src');
        const creditsCode = await code.inputValue();
        assert.equal(embedUrl, publicUrl + '?poster=broadside&show=credits');
        assert.equal(await sharing.locator('.public-player').getAttribute('href'), embedUrl);
        assert.ok(creditsCode.includes(embedUrl.replace('&', '&amp;')));
        assert.ok(!(await code.inputValue()).includes(savedKey));
        await page.getByRole('button', { name: 'Copy embed code' }).click();
        await page.locator('.copy-status').filter({ hasText: /copied|selected/ }).waitFor();
        await page.getByRole('textbox', { name: 'A film by', exact: true }).fill('Ada & Jo');
        await credits.fill('Bea');
        await rows.first().getByLabel('Role').fill('Camera and sound by');
        await billing.getByRole('button', {name:'Add credit'}).click();
        await rows.last().getByLabel('Role').fill('Desert field recordings');
        await rows.last().getByLabel('Name or credit').fill('Mesa & Co.');
        await rows.last().getByRole('button', {name:'Move credit up'}).click();
        assert.equal(await credits.inputValue(), 'Mesa & Co.');
        await billing.getByRole('button', {name:'Add credit'}).click();
        await rows.last().getByRole('button', {name:'Remove'}).click();
        assert.equal(await rows.count(), 2);
        await page.getByRole('button', { name: 'Save film details' }).click();
        await frame.getByText('Mesa & Co.', {exact:true}).waitFor();
        assert.deepEqual(await frame.locator('.credit-role').allTextContents(), ['Desert field recordings','Camera and sound by']);
        assert.deepEqual(await rows.locator('input[name=creditName]').evaluateAll(inputs => inputs.map(i => i.value)), ['Mesa & Co.','Bea']);
        assert.equal(await sharing.locator('iframe').getAttribute('src'), embedUrl);
        await sharing.getByRole('checkbox', {name:'A film by'}).check();
        await frame.getByText('A film by Ada & Jo', {exact:true}).waitFor();
        await sharing.getByRole('checkbox', {name:'A film by'}).uncheck();
        await stylePicker.selectOption('marquee');
        await frame.locator('body[data-poster=marquee] .details #film-title').waitFor();
        await checkBillingWidth(frame);
        if (evidence) await sharing.screenshot({ path: path.join(evidence, 'film-embed-builder.png') });
        await sharing.getByRole('checkbox', { name: 'Credits' }).uncheck();
        await frame.locator('.film-credits').waitFor({state:'detached'});
        assert.equal(await sharing.locator('iframe').getAttribute('src'), publicUrl + '?poster=marquee');
        const host = await context.newPage();
        try {
          publishedEmbeds = creditsCode + (await code.inputValue());
          await host.goto(origin + '/fixture/embed-host');
          const copies = host.locator('iframe');
          assert.ok((await copies.first().boundingBox()).height >= 478, 'Copied code has a usable poster height');
          assert.equal(await copies.first().contentFrame().locator('body').getAttribute('data-poster'), 'broadside');
          assert.equal(await copies.last().contentFrame().locator('body').getAttribute('data-poster'), 'marquee');
          await copies.nth(0).contentFrame().getByText('Mesa & Co.', { exact: true }).waitFor();
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
        const savedDashboard = origin + '/setup/dashboard#' + privatePath.split('/').pop();
        await Promise.all([
          page.waitForURL(savedDashboard, { waitUntil: 'load' }),
          page.getByRole('button', { name: 'Save settings' }).click()
        ]);
        await page.reload();
        assert.equal(await editor.getByLabel('Free preview (seconds)').inputValue(), '0');
        assert.equal(await editor.getByLabel('Rental duration (hours)').inputValue(), '12');
        await page.getByRole('button', { name: 'Unpublish film' }).click();
        await page.getByRole('button', { name: 'Publish film' }).waitFor();
        assert.equal(await page.getByLabel('Embed code').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        report.filmmakerDashboard = 'create film, private preview, publish, copy independent embed selections, update saved details, change prices, unpublish';
        await checkFilmUpload(page, movies);
        await checkProgramEditor(page);
      }
      if (mode === 'reuse') await checkLegacyBucketUpgrade(page, owner);
      report.scenarios.push({ stripe: mode, cloudflare: storage, savedPreviewSeconds: 10, resumed: true, previewWithoutPayments });
    } finally { await context.close(); }
  }
  assert.deepEqual(starts, ['new', 'resume', 'existing', 'new', 'new', 'existing', 'reuse']);
  assert.equal(outboundRequests, 0);
  assert.equal(guidedTokenAttempts, 5, 'Two guided connections, one legacy upgrade, two unsuccessful attempts');
  assert.equal(guidedKeyAttempts, 2);
  assert.equal(artwork.probes.size, 7, 'Every accepted setup or upgrade credential passed a write-and-delete check');
  for (const key of artwork.probes) assert.ok(!artwork.objects.has(key));
  report.cloudflareSetup = { guidedTokenConnections: 2, selectedBucketWithKeyPair: 1, manualConnections: 2, handledWrongTokenAndKey: true };
  report.passed = true;
} catch (error) {
  report.at = error.stack?.match(/check-setup-browser\.js:\d+:\d+/)?.[0];
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
