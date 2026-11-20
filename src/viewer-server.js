import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { localPreviewPort } from './config.js';
import { operatorDirectory } from './operator.js';
import { createPublicFilms } from './public-films.js';
import { createRentalAuthority } from './rental.js';
import { makeServer } from './server.js';
import { openSetupStore } from './setup-store.js';
import { createViewerRecovery } from './viewer-recovery.js';
import { createViewerCheckout } from './viewer-checkout.js';

const directory = operatorDirectory();
if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(process.env.STRIPE_CONNECT_SECRET_KEY ?? '') ||
    !/^pk_test_[A-Za-z0-9]+$/.test(process.env.STRIPE_CONNECT_PUBLISHABLE_KEY ?? '') ||
    process.env.STRIPE_CONNECT_LIVE === '1' || !process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.startsWith('whsec_')) {
  throw new Error('Configure Stripe sandbox secret and publishable keys and a Connect webhook signing secret for viewer checkout.');
}
const secret = process.env.STREAM_RENTAL_SECRET ||
  parseEnv(await readFile(join(directory, 'rental.env'), 'utf8')).STREAM_RENTAL_SECRET;
const store = openSetupStore(join(directory, 'filmmakers'));
const catalog = createPublicFilms({ store, authority: createRentalAuthority(secret) });
const checkout = createViewerCheckout({ store });
let withdrawalSweep;
const retryWithdrawals = () => {
  withdrawalSweep ??= checkout.closeWithdrawnSessions().catch(() => console.error('Checkout closure interrupted.'))
    .finally(() => { withdrawalSweep = undefined; });
};
retryWithdrawals();
const withdrawalTimer = setInterval(retryWithdrawals,15_000);
withdrawalTimer.unref();
const recovery = createViewerRecovery({ store });
if (recovery) checkout.indexPreviousOrders().catch(() => console.error('Recovery indexing interrupted.'));
const server = await makeServer(null, { catalog, checkout, recovery, publicOrigin: process.env.STREAM_PUBLIC_ORIGIN });
server.on('close', () => {
  clearInterval(withdrawalTimer);
  if (withdrawalSweep) withdrawalSweep.finally(() => store.close());
  else store.close();
});
const port = Number(process.env.PORT || 8793);
const previewPort = localPreviewPort(process.env);
if (previewPort) {
  if (previewPort === port) throw new Error('Choose a separate loopback port for dashboard previews.');
  const localCheckout = createViewerCheckout({ store, env: { ...process.env, STREAM_PUBLIC_ORIGIN: undefined } });
  const preview = await makeServer(null, { catalog, checkout: localCheckout, recovery });
  preview.listen(previewPort, '127.0.0.1');
  server.once('close', () => preview.close());
}
server.listen(port, '127.0.0.1', () => {
  console.log('Screening room: ' + (process.env.STREAM_PUBLIC_ORIGIN || 'http://127.0.0.1:' + port) + '/screening');
});
