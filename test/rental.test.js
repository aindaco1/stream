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
