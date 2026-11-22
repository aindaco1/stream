import assert from 'node:assert/strict';
import test from 'node:test';
import { callStore, pack, unpack } from '../src/store-wire.js';

test('the container transport round-trips catalog Maps, missing arguments and user-supplied arrays', () => {
  const sample = new Map([['film', {details:['map','void'],missing:undefined,bits:new Uint8Array([0,255])}]]);
  assert.deepEqual(unpack(JSON.parse(JSON.stringify(pack([sample,undefined])))),[sample,undefined]);
});

test('the private transport preserves version checks on each step of Stripe setup', () => {
  let revision = 1, record = {status:'started'};
  const store = { stripeContext(owner,mode) {
    const state = { ...record };
    return { creatorId:owner, state, get confirmation(){ return revision; },
      assertCurrent(){}, claimAccount(account,requestedMode){ return mode === requestedMode && account === 'seller'; },
      save(){ record = state; revision++; }
    };
  } };
  const read = callStore(store,'stripe.read',['filmmaker','live']);
  assert.equal(callStore(store,'stripe.claim',['filmmaker','live',read.confirmation,'seller','live']),true);
  assert.equal(callStore(store,'stripe.save',['filmmaker','live',read.confirmation,{status:'ready'}]),2);
  assert.deepEqual(record,{status:'ready'});
  assert.throws(()=>callStore(store,'stripe.claim',['filmmaker','live',read.confirmation,'seller','live']),{statusCode:409});
  for (const method of ['close','constructor','__proto__','stripeContext']) {
    assert.throws(()=>callStore(store,method,[]),TypeError);
  }
});
