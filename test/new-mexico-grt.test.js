import assert from 'node:assert/strict';
import test from 'node:test';
import { newMexicoTotals, resolveNewMexicoQuote } from '../src/new-mexico-grt.js';

const address = { line1:'1 Civic Plaza NW', city:'Albuquerque', state:'NM', postalCode:'87102-0001', country:'US' };
const now = Date.parse('2026-11-20T12:00:00Z');
const civic = {
  street_number:'1', street_name:'Civic Plaza', city:'Albuquerque', zipcode:'87102', street_post_directional:'NW',
  success:true, tax_rate:'7.6250', county:'Bernalillo', location_code:'02-701', source:'NM E911'
};
const downtown = {
  county:'Bernalillo', locat_cdr:'02-701', locat_cd1:' ', locat_cd2:null,
  grt_rate:7.625, grt_rate2:0, note_key:null
};

function provider(results = [civic], rows = [downtown], extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect,'error');
    assert.ok(init.signal instanceof AbortSignal);
    const { hostname, searchParams } = new URL(url);
    calls.push(hostname);
    if (hostname === 'grt.edacnm.org') {
      assert.equal(searchParams.get('street_number'),'1');
      assert.equal(searchParams.get('street_name'),'Civic Plaza');
      assert.equal(searchParams.get('zipcode'),'87102');
      return Response.json({results});
    }
    assert.equal(hostname,'services5.arcgis.com');
    assert.equal(searchParams.get('returnGeometry'),'false');
    return Response.json({features:rows.map(attributes => ({attributes})), ...extra});
  };
  return {fetchImpl,calls,now};
}

test('rental and purchase reconcile with completed Albuquerque sandbox orders', async () => {
  const options = provider();
  const quote = await resolveNewMexicoQuote(address,options);
  assert.deepEqual(quote,{code:'02-701',ratePartsPerMillion:76250,validFrom:'2026-07-01',
    validThrough:'2027-06-30',source:'EDAC NM E911 / NM TRD'});
  assert.deepEqual(newMexicoTotals({amount:99,tipAmount:10},quote),{chargedTotalCents:117,taxCents:9,tipTaxCents:1});
  assert.deepEqual(newMexicoTotals({amount:299,tipAmount:0},quote),{chargedTotalCents:322,taxCents:23,tipTaxCents:0});
  await resolveNewMexicoQuote(address,options);
  assert.deepEqual(options.calls,['grt.edacnm.org','services5.arcgis.com','grt.edacnm.org']);
});

test('manual quotes require a complete NM destination and a full Session inside the reviewed period', async () => {
  const options = provider();
  for (const change of [{country:'CA'},{state:'CO'},{line1:''},{line1:'65432 PO BOX'},{city:''},{postalCode:'junk'}]) {
    assert.equal(await resolveNewMexicoQuote({...address,...change},options),null);
  }
  for (const timestamp of ['2026-07-01T05:59:59Z','2027-06-30T06:00:00Z','2027-07-10T08:00:00Z']) {
    assert.equal(await resolveNewMexicoQuote(address,{...options,now:Date.parse(timestamp)}),null);
  }
  assert.deepEqual(options.calls,[]);
  assert.ok(await resolveNewMexicoQuote(address,{...options,now:Date.parse('2026-07-01T06:00:00Z')}));
});

test('ambiguous, approximate, unmatched and conflicting address results fall back to automatic tax', async () => {
  for (const matches of [[],[civic,civic],[{...civic,success:false}],[{...civic,source:'Mapquest Geocode'}],
    [{...civic,city:'Rio Rancho'}],[{...civic,street_number:'3'}],[{...civic,zipcode:'87120'}],
    [{...civic,tax_rate:'7.8750'}],[{...civic,county:'Santa Fe'}]]) {
    assert.equal(await resolveNewMexicoQuote(address,provider(matches)),null);
  }
});

test('a tribal, qualified, missing, duplicate or incomplete schedule entry cannot price a film', async () => {
  for (const rows of [[],[downtown,downtown],[{...downtown,locat_cd1:'02-999'}],
    [{...downtown,note_key:'*'}],[{...downtown,grt_rate2:6.5}],
    [{...downtown,locat_cdr:'02-100'}]]) {
    assert.equal(await resolveNewMexicoQuote(address,provider([civic],rows)),null);
  }
  assert.equal(await resolveNewMexicoQuote(address,provider([civic],[downtown],{exceededTransferLimit:true})),null);
});

test('provider outages and oversized results fall back and a later request may recover', async () => {
  const {fetchImpl:working} = provider();
  let attempts = 0;
  const fetchImpl = async (url,init) => {
    if (url.startsWith('https://services5.arcgis.com') && attempts++ === 0) return new Response('',{status:502});
    return working(url,init);
  };
  assert.equal(await resolveNewMexicoQuote(address,{fetchImpl,now}),null);
  assert.ok(await resolveNewMexicoQuote(address,{fetchImpl,now}));
  assert.equal(await resolveNewMexicoQuote(address,{now,fetchImpl:async () => new Response('x'.repeat(17000))}),null);
});
