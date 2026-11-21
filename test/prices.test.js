import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filmPrices, maxPreviewSeconds, priceFromInput, savedPreviewSeconds, usdInput } from '../src/prices.js';

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

test('whole-second previews leave a full second and never exceed three minutes', () => {
  for (const [duration, max] of [[0.8,0], [1,0], [1.99,0], [2,1], [10.9,9], [180.9,179], [181,180], [5400,180]]) {
    assert.equal(maxPreviewSeconds(duration), max);
    assert.equal(savedPreviewSeconds(180,duration), max);
  }
  assert.equal(savedPreviewSeconds(undefined,4.8),3);
  assert.equal(savedPreviewSeconds(undefined,5400),10);
  assert.equal(savedPreviewSeconds(0,5400),0);
});
