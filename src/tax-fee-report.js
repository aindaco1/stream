import { parse } from 'csv-parse/sync';

const columns = ['incurred_by', 'product', 'feature_name', 'amount', 'currency', 'balance_transaction_id'];
const label = value => value.trim().toLowerCase().replaceAll('_', ' ');

// Read the transaction-level Tax Basic amount, before any tax Stripe charges on its services.
// Never infer zero from a missing report row or from zero customer tax.
export function importTaxFeeReport(store, platform, csv, { chargeId, reviewer } = {}) {
  const rows = parse(csv, {
    bom: true, skip_empty_lines: true, columns(header) {
      if (new Set(header).size !== header.length || !columns.every(key => header.includes(key))) {
        throw Error('Expected an itemized Stripe Fees report with transaction IDs, product, feature, amount and currency.');
      }
      return header;
    }
  });
  const fees = [];
  const charges = new Set();
  for (const row of rows) {
    if (row.account_id && row.account_id !== platform) continue;
    if (!['automatic taxes', 'stripe tax', 'tax'].includes(label(row.product)) || label(row.feature_name) !== 'automatic tax') continue;
    const id = row.incurred_by;
    if (!/^(cs|pi|ch)_/.test(id)) continue;
    const order = id.startsWith('cs_') ? store.viewerOrderBySession(id) :
      store.viewerOrderByPlatformPayment(platform, id.startsWith('pi_') ? id : null, id.startsWith('ch_') ? id : null);
    if (!order || (chargeId && order.chargeId !== chargeId) || order.platform !== platform || !order.paidAt || (order.taxBasicFeeCents !== null && !order.taxFeeReference)) continue;
    const amount = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(row.amount);
    if (!amount || row.currency.toLowerCase() !== 'usd' || !/^txn_[a-zA-Z0-9]+$/.test(row.balance_transaction_id) || charges.has(order.chargeId)) {
      throw Error('Ambiguous automatic tax fee for ' + order.chargeId + '. Review its complete itemized report.');
    }
    charges.add(order.chargeId);
    const feeCents = Number(amount[1]) * 100 + Number((amount[2] ?? '').padEnd(2, '0'));
    fees.push({ chargeId: order.chargeId, feeCents, reference: row.balance_transaction_id });
  }
  return { matched: fees.length, recorded: store.recordTaxFees(platform, fees, reviewer) };
}
