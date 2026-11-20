import { join } from 'node:path';
import { operatorDirectory } from '../src/operator.js';
import { openSetupStore } from '../src/setup-store.js';

const admin = process.argv[2] === '--super-admin';
const name = process.argv[admin ? 3 : 2];
if (!name || process.argv.length !== (admin ? 4 : 3)) throw new Error('Usage: npm run invite -- [--super-admin] "Account name"');
const origin = process.env.STREAM_PUBLIC_ORIGIN || 'http://127.0.0.1:' + (process.env.PORT || '8787');
const url = new URL(origin);
if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
  throw new Error('Use the public HTTPS origin or the local server.');
}
const store = openSetupStore(join(operatorDirectory(), 'filmmakers'));
try {
  console.log('Private sign-in link (single use, expires in 30 minutes):');
  console.log(origin + (admin ? '/setup/admin/sign-in#' : '/setup/sign-in#') + store.invite(name, admin ? 'admin' : 'filmmaker'));
} finally { store.close(); }
