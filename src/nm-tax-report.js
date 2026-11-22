const monthParts = new Intl.DateTimeFormat('en-US', {timeZone:'America/Denver',year:'numeric',month:'2-digit'});

export function reportingMonth(date = new Date()) {
  const parts = Object.fromEntries(monthParts.formatToParts(date).map(({type,value}) => [type,value]));
  return parts.year + '-' + parts.month;
}

function startOfMonth(year, month) {
  // Mountain midnight is either 06:00 or 07:00 UTC. Checking the civil month
  // at 06:00 also handles November 1, when the clocks change after midnight.
  const earliest = Date.UTC(year,month,1,6);
  const target = new Date(earliest).toISOString().slice(0,7);
  return (reportingMonth(new Date(earliest)) === target ? earliest : earliest+3600000) / 1000;
}

export function newMexicoReport(store, period) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) throw Error('Choose a month in YYYY-MM format.');
  const [year,month] = period.split('-').map(Number);
  const rows = store.nmTaxSummary(startOfMonth(year,month-1), startOfMonth(year,month));
  const lines = [['month','nm_reporting_location','rate_percent','paid_orders','film_receipts_usd','tip_receipts_before_tax_usd',
    'taxable_receipts_usd','film_tax_usd','tax_included_in_tip_usd','total_tax_usd','adjustments_to_review']];
  for (const row of rows) {
    if (!/^\d{2}-\d{3}$/.test(row.district) || !Number.isSafeInteger(row.ppm)) throw Error('Review the recorded district and rate.');
    const amounts = [row.film,row.tip,row.film+row.tip,row.tax-row.tipTax,row.tipTax,row.tax];
    lines.push([period,row.district,(row.ppm/10000).toFixed(4),row.orders,...amounts.map(c => (c/100).toFixed(2)),row.adjustments]);
  }
  return lines.map(row => row.join(',')).join('\r\n') + '\r\n';
}
