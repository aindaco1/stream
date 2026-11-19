import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filmPrices, priceFromInput, usdInput } from '../src/prices.js';

test('USD inputs stay in integer cents through decimal boundaries and storage round trips', () => {
  for (const [input, cents] of [['.50', 50], [' 1.15 ', 115], ['1.4', 140], ['999999.99', 99999999]]) {
    assert.equal(priceFromInput(input), cents);
    assert.equal(priceFromInput(usdInput(cents)), cents);
  }
  assert.equal(priceFromInput('  '), null);
  for (const value of [undefined, 299, '0.49', '1.005', '1000000', '-2', '1e2', 'NaN', '$2']) {
    assert.equal(priceFromInput(value), undefined);
  }
  assert.deepEqual(filmPrices(undefined), { rent: 99, buy: null });
  assert.deepEqual(filmPrices({ rent: null, buy: null }), { rent: null, buy: null });
  for (const malformed of [null, {}, { rent: null }, { rent: 1.1, buy: null }, { rent: null, buy: 100000000 }]) {
    assert.equal(filmPrices(malformed), null);
  }
});
