import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createRentalAuthority, rentalScope } from '../src/rental.js';

const film = { film: 'clock', revision: 'first-cut' };
const purchasedAt = 1_780_000_000;
const rentalEnd = purchasedAt + 48 * 3600;
function purchase() {
  return {
    id: 'pi_fixture', object: 'payment_intent', status: 'succeeded',
    livemode: false, amount: 99, amount_received: 99, currency: 'usd',
    metadata: { product: 'stream-rental-prototype', scope: rentalScope(film) },
    latest_charge: {
      object: 'charge', payment_intent: 'pi_fixture', status: 'succeeded', livemode: false,
      captured: true, paid: true, refunded: false, amount_refunded: 0,
      disputed: false, created: purchasedAt
    }
  };
}

test('two independent embeds can redeem the same rental with distinct playback keys', async () => {
  const authority = createRentalAuthority(randomBytes(32), { now: () => purchasedAt * 1000 });
  const receipt = await authority.issueReceipt(purchase(), film);
  const [a, b] = await Promise.all([authority.exchange(receipt, film), authority.exchange(receipt, film)]);
  assert.notEqual(a.grant, b.grant);
  assert.equal(a.rentalExpiresAt, rentalEnd);
  assert.equal(a.expiresAt, purchasedAt + 600);
  const key = await authority.keyForGrant(a.grant, film);
  assert.equal(key.length, 16);
  assert.deepEqual(key, await authority.keyForGrant(a.grant, film));
  assert.notDeepEqual(key, await authority.keyForGrant(b.grant, film));
  assert.deepEqual(await authority.verifyGrant(a.grant, film), {
    ...film, expiresAt: purchasedAt + 600, rentalExpiresAt: rentalEnd
  });
});

test('receipt and grant bind film, revision and purpose; a modified grant fails', async () => {
  const authority = createRentalAuthority(randomBytes(32), { now: () => purchasedAt * 1000 });
  const receipt = await authority.issueReceipt(purchase(), film);
  const { grant } = await authority.exchange(receipt, film);
  for (const other of [{ ...film, film: 'other' }, { ...film, revision: 'other' }]) {
    await assert.rejects(authority.exchange(receipt, other));
    await assert.rejects(authority.keyForGrant(grant, other));
    await assert.rejects(authority.issueReceipt(purchase(), other));
  }
  await assert.rejects(authority.exchange(grant, film));
  await assert.rejects(authority.keyForGrant(receipt, film));
  await assert.rejects(authority.verifyGrant('A' + grant.slice(1), film));
  await assert.rejects(authority.exchange('', film));
});

test('retrieving a payment or refreshing a session never extends the purchase clock', async () => {
  let sec = purchasedAt;
  const authority = createRentalAuthority(randomBytes(32), { now: () => sec * 1000 });
  const receipt = await authority.issueReceipt(purchase(), film);
  const first = await authority.exchange(receipt, film);
  sec = first.expiresAt;
  await assert.rejects(authority.verifyGrant(first.grant, film));
  sec = rentalEnd - 1;
  const reissued = await authority.issueReceipt(purchase(), film);
  const last = await authority.exchange(reissued, film);
  assert.equal(last.expiresAt, rentalEnd);
  sec = rentalEnd;
  await assert.rejects(authority.exchange(receipt, film));
  await assert.rejects(authority.verifyGrant(last.grant, film));
  await assert.rejects(authority.issueReceipt(purchase(), film));
});

test('receipt issuance requires a captured matching undisputed sandbox payment', async () => {
  const authority = createRentalAuthority(randomBytes(32), { now: () => purchasedAt * 1000 });
  for (const override of [
    { livemode: true }, { currency: 'eur' }, { amount_received: 98 }, { amount: 100 },
    { status: 'processing' }, { latest_charge: null }, { metadata: {} }
  ]) {
    await assert.rejects(authority.issueReceipt({ ...purchase(), ...override }, film));
  }
  for (const override of [
    { refunded: true }, { amount_refunded: 1 }, { disputed: true }, { captured: false },
    { created: purchasedAt + 10 }, { payment_intent: 'pi_other' }
  ]) {
    const intent = purchase();
    Object.assign(intent.latest_charge, override);
    await assert.rejects(authority.issueReceipt(intent, film));
  }
  assert.throws(() => createRentalAuthority('short-secret'));
});

test('a delayed rental starts at verified settlement and still expires exactly 48 hours later', async () => {
  const paidAt = purchasedAt + 3 * 86400;
  let current = paidAt + 1;
  const authority = createRentalAuthority(randomBytes(32), { now: () => current * 1000 });
  const payment = purchase();
  await assert.rejects(authority.issueReceipt(payment, film));
  for (const invalid of [null, 'later', NaN, paidAt + 0.5, purchasedAt - 1, current + 1]) {
    await assert.rejects(authority.issueReceipt(payment, film, { paidAt: invalid }));
  }
  const receipt = await authority.issueReceipt(payment, film, { paidAt });
  const expires = paidAt + 48 * 3600;
  assert.equal((await authority.exchange(receipt, film)).rentalExpiresAt, expires);
  await assert.rejects(authority.issueReceipt({ ...payment, status: 'processing' }, film, { paidAt }));
  current = expires;
  await assert.rejects(authority.exchange(receipt, film));
  await assert.rejects(authority.issueReceipt(payment, film, { paidAt }));
});

function pricedIntent(kind, amount, order) {
  const intent = purchase();
  Object.assign(intent, { amount, amount_received: amount });
  Object.assign(intent.metadata, { kind, amount: String(amount), order });
  Object.assign(intent.latest_charge, { amount, amount_captured: amount, currency: 'usd' });
  return intent;
}

test('buy receipts renew from the same confirmed order and authorize scoped original downloads', async () => {
  let now = purchasedAt + 30 * 86400;
  const authority = createRentalAuthority(randomBytes(32), { now: () => now * 1000 });
  const payment = pricedIntent('buy', 299, 'order_1');
  const order = { amount: 299, orderId: 'order_1' };
  const receipt = await authority.issuePurchaseReceipt(payment, film, order);
  const first = await authority.exchange(receipt, film);
  assert.equal(first.access, 'buy');
  assert.equal(first.rentalExpiresAt, null);
  assert.deepEqual(await authority.verifyDownloadGrant(first.grant, film), { orderId: order.orderId, expiresAt: now + 600 });
  const second = await authority.exchange(receipt, film);
  assert.notDeepEqual(await authority.keyForGrant(first.grant, film), await authority.keyForGrant(second.grant, film));
  await assert.rejects(authority.verifyDownloadGrant(receipt, film));
  await assert.rejects(authority.verifyDownloadGrant(first.grant, { ...film, revision: 'changed' }));
  now += 3600;
  await assert.rejects(authority.verifyDownloadGrant(first.grant, film));
  await assert.rejects(authority.exchange(receipt, film));
  const renewed = await authority.issuePurchaseReceipt(payment, film, order);
  assert.equal((await authority.exchange(renewed, film)).orderId, order.orderId);
  payment.latest_charge.amount_refunded = 1;
  await assert.rejects(authority.issuePurchaseReceipt(payment, film, order));
});

test('the order, amount, offer type and capture must match before either entitlement can be issued', async () => {
  const authority = createRentalAuthority(randomBytes(32), { now: () => purchasedAt * 1000 });
  const order = { amount: 299, orderId: 'order_1' };
  const bought = pricedIntent('buy', 299, order.orderId);
  await assert.rejects(authority.issuePurchaseReceipt(bought, film, { ...order, orderId: 'another' }));
  await assert.rejects(authority.issuePurchaseReceipt(bought, film, { ...order, amount: 99 }));
  await assert.rejects(authority.issueReceipt(bought, film, order));
  bought.latest_charge.amount_captured = 99;
  await assert.rejects(authority.issuePurchaseReceipt(bought, film, order));
  const rent = pricedIntent('rent', 299, order.orderId);
  await assert.rejects(authority.issuePurchaseReceipt(rent, film, order));
  const receipt = await authority.issueReceipt(rent, film, { amount: 299 });
  const access = await authority.exchange(receipt, film);
  assert.equal(access.rentalExpiresAt, rentalEnd);
  await assert.rejects(authority.verifyDownloadGrant(access.grant, film));
  rent.metadata.amount = '99';
  await assert.rejects(authority.issueReceipt(rent, film, { amount: 299 }));
  await assert.rejects(authority.issuePurchaseReceipt(purchase(), film, { ...order, amount: 99 }));
});
