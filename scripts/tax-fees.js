import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripeMode } from '../src/stripe-mode.js';
import { operatorDirectory } from '../src/operator.js';
import { openRuntimeStore } from '../src/runtime-store.js';
import { importTaxFeeReport } from '../src/tax-fee-report.js';

const [action, platform, ...args] = process.argv.slice(2);
const sizes = { pending: 0, import: 1, confirm: 3 };
if (!Object.hasOwn(sizes, action) || args.length !== sizes[action] || !/^acct_[a-zA-Z0-9]+$/.test(platform) ||
    (action === 'confirm' && (!/^ch_[a-zA-Z0-9]+$/.test(args[0]) || !/^(0|[1-9][0-9]*)$/.test(args[1]) ||
      !(args[1] === '0' ? /^frr_/ : /^txn_/).test(args[2])))) {
  throw Error('Usage: npm run tax:fees -- pending ACCOUNT | import ACCOUNT ITEMIZED.csv | confirm ACCOUNT CHARGE FEE_CENTS STRIPE_REFERENCE');
}
const store = openRuntimeStore(join(operatorDirectory(), 'filmmakers'), stripeMode(process.env));
try {
  if (action === 'pending') console.table(store.pendingTaxFees(platform));
  if (action === 'import') console.log(importTaxFeeReport(store, platform, await readFile(args[0], 'utf8')));
  if (action === 'confirm') console.log({ recorded: store.recordTaxFees(platform, [
    { chargeId: args[0], feeCents: Number(args[1]), reference: args[2] }
  ]) });
} finally { store.close(); }
