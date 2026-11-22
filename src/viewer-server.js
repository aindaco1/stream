import { stripeMode, stripeSecretMode, publishableKeyMode } from './stripe-mode.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { localPreviewPort } from './config.js';
import { operatorDirectory } from './operator.js';
import { createPublicFilms } from './public-films.js';
import { createRentalAuthority } from './rental.js';
import { makeServer } from './server.js';
import { openRuntimeStore } from './runtime-store.js';
import { createMaintenanceServer } from './viewer-maintenance.js';
import { syncTaxFeeReports } from './stripe-live-operations.js';
import { createViewerRecovery } from './viewer-recovery.js';
import { liveSalesTerritory, marketplaceEnabled } from './marketplace-checkout.js';
import { createViewerCheckout } from './viewer-checkout.js';

const container = process.env.STREAM_STORE_TRANSPORT === 'durable-object';
const directory = operatorDirectory();
const mode = stripeMode(process.env);
const live = mode === 'live';
const acceptingPayments = !live || liveSalesTerritory(process.env.STREAM_SALES_TERRITORIES) !== 'closed';
if (acceptingPayments && (stripeSecretMode(process.env.STRIPE_CONNECT_SECRET_KEY) !== mode ||
    publishableKeyMode(process.env.STRIPE_CONNECT_PUBLISHABLE_KEY) !== mode ||
    !process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.startsWith('whsec_'))) {
  throw Error('Configure matching Stripe keys and the Connect webhook signing secret for ' + mode + ' checkout.');
}
if (acceptingPayments && marketplaceEnabled(process.env) && !process.env.STRIPE_PLATFORM_WEBHOOK_SECRET?.startsWith('whsec_')) {
  throw Error('Configure STRIPE_PLATFORM_WEBHOOK_SECRET for marketplace checkout.');
}
if (live) {
  const origin = new URL(process.env.STREAM_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== process.env.STREAM_PUBLIC_ORIGIN ||
      localPreviewPort(process.env) || (acceptingPayments && (!marketplaceEnabled(process.env) ||
      process.env.STRIPE_PLATFORM_WEBHOOK_SECRET === process.env.STRIPE_CONNECT_WEBHOOK_SECRET))) {
    throw Error('Live checkout requires a public HTTPS origin, marketplace tax and separate signed webhook destinations.');
  }
}
if (live && !process.env.STREAM_RENTAL_SECRET) throw Error('Configure the live playback signing key.');
const secret = process.env.STREAM_RENTAL_SECRET ||
  parseEnv(await readFile(join(directory, 'rental.env'), 'utf8')).STREAM_RENTAL_SECRET;
const store = openRuntimeStore(join(directory, 'filmmakers'), mode);
const catalog = createPublicFilms({ store, authority: createRentalAuthority(secret, { live }) });
const checkout = createViewerCheckout({ store });
if (live) store.withdrawOutsideTerritory(checkout.salesTerritory);
let paymentSweep;
const retryPayments = () => {
  return paymentSweep ??= Promise.allSettled([checkout.closeWithdrawnSessions(), checkout.retryProcessingFees(), checkout.retryFilmmakerTransfers()])
    .then(results => results.every(result => result.status === 'fulfilled' && result.value !== false))
    .finally(() => { paymentSweep = undefined; });
};
const runSweep = () => retryPayments().then(ok => { if (!ok) console.error('Checkout reconciliation interrupted.'); });
// The Cloudflare Worker wakes the container for scheduled maintenance. Local
// rehearsals also retry while idle, without depending on the next page visit.
if (!container) runSweep();
const paymentTimer = !container && setInterval(runSweep,15_000);
if (paymentTimer) paymentTimer.unref();
const recovery = createViewerRecovery({ store });
if (recovery && !container) checkout.indexPreviousOrders().catch(() => console.error('Recovery indexing interrupted.'));
const server = await makeServer(null, { catalog, checkout, recovery, publicOrigin: process.env.STREAM_PUBLIC_ORIGIN });
server.on('close', () => {
  clearInterval(paymentTimer);
  if (paymentSweep) paymentSweep.finally(() => store.close());
  else store.close();
});
if (container) {
  const maintenance = createMaintenanceServer(process.env.STREAM_MAINTENANCE_SECRET, async () => {
    if (!store.needsPaymentSweep()) return true;
    // A delayed or unavailable fee report must not postpone unrelated payment
    // adjustments, outstanding transfers, or withdrawn checkouts.
    const [fees,sweep] = await Promise.allSettled([
      checkout.platformId().then(id => syncTaxFeeReports(store, process.env.STRIPE_CONNECT_SECRET_KEY, id)), retryPayments()
    ]);
    return fees.status === 'fulfilled' && sweep.status === 'fulfilled' && sweep.value;
  });
  maintenance.listen(8794,'0.0.0.0');
  server.once('close', () => maintenance.close());
}
const port = Number(process.env.PORT || 8793);
const previewPort = localPreviewPort(process.env);
if (previewPort) {
  if (previewPort === port) throw new Error('Choose a separate loopback port for dashboard previews.');
  const localCheckout = createViewerCheckout({ store, env: { ...process.env, STREAM_PUBLIC_ORIGIN: undefined } });
  const preview = await makeServer(null, { catalog, checkout: localCheckout, recovery });
  preview.listen(previewPort, '127.0.0.1');
  server.once('close', () => preview.close());
}
server.listen(port, container ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('Screening room: ' + (process.env.STREAM_PUBLIC_ORIGIN || 'http://127.0.0.1:' + port) + '/screening');
});
