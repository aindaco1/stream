import { calculateManualTax, normalizeTaxDestination } from '@dustwave/tax-core';
import { parseNewMexicoStreetAddress } from '@dustwave/tax-core/provider';
import { readBoundedJson } from '@dustwave/worker-core/response-body';

const addressFinder = 'https://grt.edacnm.org/api/by_address';
// TRD publishes a new layer for each effective period. Review the new layer
// before extending this window. The previous period cannot price a new order.
const schedule = 'https://services5.arcgis.com/f4lpEvI6fkgVYigk/arcgis/rest/services/New_Mexico_gross_receipts_tax_July_2026_June_2027_pub_WM/FeatureServer/2/query';
const validFrom = '2026-07-01', validThrough = '2027-06-30';
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone:'America/Denver', year:'numeric', month:'2-digit', day:'2-digit'
});
const schedules = new WeakMap();
const normalize = value => String(value ?? '').trim().replace(/\s+/gu,' ').toUpperCase();
const locationCode = /^\d{2}-\d{3}$/u;

function rateParts(percent) {
  const value = String(percent ?? '');
  if (!/^\d{1,2}(?:\.\d{1,4})?$/u.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const rate = Number(whole) * 10_000 + Number(fraction.padEnd(4,'0'));
  return rate > 0 ? rate : null;
}

async function readProvider(url, fetchImpl, maxBytes) {
  const response = await fetchImpl(url, {
    method:'GET', headers:{accept:'application/json'}, redirect:'error', signal:AbortSignal.timeout(3000)
  });
  if (!response.ok) throw Error('GRT provider unavailable.');
  return readBoundedJson(response,maxBytes);
}

async function loadDistricts(fetchImpl) {
  const params = new URLSearchParams({
    f:'json', where:'1=1', returnGeometry:'false',
    outFields:'county,locat_cdr,locat_cd1,locat_cd2,grt_rate,grt_rate2,note_key'
  });
  const response = await readProvider(schedule + '?' + params,fetchImpl,128 * 1024);
  if (!Array.isArray(response.features) || !response.features.length || response.exceededTransferLimit) {
    throw Error('Incomplete GRT schedule.');
  }
  const districts = new Map();
  for (const { attributes: row } of response.features) {
    const code = row.locat_cdr;
    if (!locationCode.test(code)) continue;
    // A repeated code, cooperative tribal rate or schedule footnote requires
    // additional facts. Delegate these cases to the automatic-tax checkout.
    const ordinary = !districts.has(code) && ['locat_cd1','locat_cd2','note_key'].every(key => Object.hasOwn(row,key)) &&
      !normalize(row.locat_cd1) && !normalize(row.locat_cd2) &&
      !normalize(row.note_key) && (row.grt_rate2 === 0 || row.grt_rate2 === null);
    districts.set(code, ordinary ? { county:normalize(row.county), rate:rateParts(row.grt_rate) } : null);
  }
  return districts;
}

async function currentDistricts(fetchImpl) {
  let entry = schedules.get(fetchImpl);
  if (!entry || entry.expires <= Date.now()) {
    entry = { expires:Date.now() + 3_600_000, districts:loadDistricts(fetchImpl) };
    schedules.set(fetchImpl,entry);
  }
  try { return await entry.districts; }
  catch (error) {
    if (schedules.get(fetchImpl) === entry) schedules.delete(fetchImpl);
    throw error;
  }
}

// An unresolved jurisdiction selects the existing Stripe Tax flow. Only a
// reporting code and rate leave this function. Viewer addresses are not cached.
export async function resolveNewMexicoQuote(address, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { valid, destination } = normalizeTaxDestination(address);
  if (!valid || destination.country !== 'US' || !['NM','NEW MEXICO'].includes(destination.state) ||
      !destination.city || destination.city.length > 100 || destination.line1.length > 160 ||
      /\bP\.?\s*O\.?\s*BOX\b/iu.test(destination.line1)) return null;
  const street = parseNewMexicoStreetAddress(destination.line1);
  if (!street) return null;
  const timestamp = Number(typeof now === 'function' ? now() : now);
  // A default Checkout Session may stay open for 24 hours.
  if (!Number.isFinite(timestamp) || localDate.format(timestamp) < validFrom ||
      localDate.format(timestamp + 86_400_000) > validThrough) return null;

  const query = {
    street_number:street.streetNumber, street_name:street.streetName, pre_direction:street.preDirection,
    street_suffix:street.streetSuffix, street_post_directional:street.postDirection,
    city:destination.city, zipcode:destination.postalCode.slice(0,5)
  };
  const params = new URLSearchParams(Object.entries(query).filter(([,value]) => value));
  try {
    // tax-core's single-result provider returns the first row. Stream needs the
    // complete result set before treating this location as fit for filing.
    const { results } = await readProvider(addressFinder + '?' + params,fetchImpl,16_384);
    if (!Array.isArray(results) || results.length !== 1) return null;
    const match = results[0];
    if (match?.success !== true || !['NM E911','Intuit'].includes(match.source) || !locationCode.test(match.location_code) ||
        !Object.entries(query).every(([key,value]) => normalize(match[key]) === normalize(value))) return null;
    const district = (await currentDistricts(fetchImpl)).get(match.location_code);
    const rate = rateParts(match.tax_rate);
    if (!district || !rate || district.rate !== rate || !district.county || district.county !== normalize(match.county)) return null;
    return { code:match.location_code, ratePartsPerMillion:rate, validFrom, validThrough, source:'EDAC ' + match.source + ' / NM TRD' };
  } catch {
    return null;
  }
}

export function newMexicoTotals(order, quote) {
  const ratePartsPerMillion = quote.ratePartsPerMillion;
  const film = calculateManualTax({ subtotalCents:order.amount, ratePartsPerMillion });
  const tip = calculateManualTax({ subtotalCents:order.tipAmount, ratePartsPerMillion, taxBehavior:'inclusive' });
  return {
    chargedTotalCents:film.totalCents + tip.totalCents,
    taxCents:film.taxCents + tip.taxCents,
    tipTaxCents:tip.taxCents
  };
}
