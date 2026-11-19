import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { operatorDirectory } from '../src/operator.js';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomToken } from '@dustwave/worker-core/crypto';
import { createStripeClient, StripeApiError } from '@dustwave/worker-core/stripe';
import { createRentalAuthority, rentalScope } from '../src/rental.js';
import { connectedTestRental } from '../src/connected-test-rental.js';
import { openSetupStore } from '../src/setup-store.js';

const directory = operatorDirectory();

// Publish complete private files. Two initializers adopt the same key and order.
function writePrivate(name, value, initial = false, folder = directory) {
  const destination = join(folder, name);
  const temporary = join(folder, '.' + randomUUID());
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  try {
    if (!initial) return renameSync(temporary, destination);
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const initialize = args.length === 1 && args[0] === '--init';
  const connected = args[0] === '--connected';
  if (connected ? args.length !== 3 : !initialize && (args.length !== 2 || args[0].startsWith('--'))) {
    throw new Error('Use rental:test -- --init, rental:test -- FILM REVISION or rental:test -- --connected OWNER SAVED_FILM_ID.');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivate('rental.env', 'STREAM_RENTAL_SECRET=' + randomToken(32) + '\n', true);
  const key = parseEnv(readFileSync(join(directory, 'rental.env'), 'utf8')).STREAM_RENTAL_SECRET;
  const authority = createRentalAuthority(key);
  if (initialize) {
    console.log('Private rental signing key ready.');
    return;
  }

  if (connected) {
    const [, owner, filmId] = args;
    const store = openSetupStore(join(directory, 'filmmakers'));
    try {
      const { receipt, evidence } = await connectedTestRental({ owner, filmId, store, env: process.env, signingKey: key });
      const folder = join(directory, 'connected-test-rentals', filmId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writePrivate('receipt.txt', receipt + '\n', false, folder);
      writePrivate('evidence.json', JSON.stringify(evidence, null, 2) + '\n', false, folder);
      console.log(JSON.stringify(evidence));
    } finally { store.close(); }
    return;
  }

  const credential = process.env.STRIPE_TEST_SECRET_KEY;
  if (!/^(?:sk|rk)_test_[a-zA-Z0-9]+$/.test(credential || '')) throw new Error('Set STRIPE_TEST_SECRET_KEY to a sandbox key.');
  const film = { film: args[0], revision: args[1] };
  const scope = rentalScope(film);
  const intentFile = 'test-order.json';
  writePrivate(intentFile, JSON.stringify({ requestId: randomUUID(), scope, createdAt: Date.now() }), true);
  const order = JSON.parse(readFileSync(join(directory, intentFile), 'utf8'));
  if (order.scope !== scope) throw new Error('This test order belongs to another film or source revision. Use a separate operator directory for a new test order.');

  const stripe = createStripeClient(credential);
  let intent;
  if (order.intentId) {
    intent = await stripe.paymentIntents.retrieve(order.intentId, { expand: ['latest_charge'] });
  } else {
    if (Date.now() - order.createdAt >= 23 * 3600_000) {
      throw new Error('Pending order is older than the safe Stripe retry window. Reconcile the sandbox before retrying.');
    }
    intent = await stripe.paymentIntents.create({
      amount: 99,
      currency: 'usd',
      confirm: true,
      payment_method_types: ['card'],
      payment_method: 'pm_card_visa',
      metadata: { product: 'stream-rental-prototype', scope },
      expand: ['latest_charge']
    }, { idempotencyKey: 'stream-test-' + order.requestId });
    if (!intent.id?.startsWith('pi_') || intent.livemode !== false) throw new Error('Unexpected sandbox response.');
    writePrivate(intentFile, JSON.stringify({ ...order, intentId: intent.id }));
  }
  const receipt = await authority.issueReceipt(intent, film);
  writePrivate('receipt.txt', receipt + '\n');
  console.log('Verified a USD 0.99 sandbox rental. Private receipt saved to receipt.txt in the operator directory.');
}

main().catch((error) => {
  // Stripe error messages can quote request values. Only report safe diagnostic fields.
  console.error(error instanceof StripeApiError
    ? 'Stripe sandbox request failed (HTTP ' + error.statusCode + ', ' + (error.code || error.type) + ').'
    : error.message);
  process.exitCode = 1;
});
