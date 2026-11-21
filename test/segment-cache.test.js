import assert from 'node:assert/strict';
import test from 'node:test';
import { createSegmentCache } from '../src/segment-cache.js';

test('recent segments from every open film share one byte and entry budget', () => {
  const open = createSegmentCache(12, 3);
  const a = open(), b = open();
  const bytes = Buffer.alloc(4);
  a.set('0', bytes);
  b.set('0', Buffer.alloc(4));
  a.set('1', Buffer.alloc(2));
  assert.strictEqual(a.get('0'), bytes);
  b.set('1', Buffer.alloc(1));
  assert.equal(b.get('0'), undefined);
  assert.ok(a.get('1'));
  b.set('2', Buffer.alloc(9));
  assert.equal(a.get('0'), undefined);
  assert.ok(b.get('1'));
  b.clear();
  assert.ok(a.get('1'));
  assert.equal(b.get('2'), undefined);
});

test('replacement releases the previous entry and the budget includes the backing allocation', () => {
  const open = createSegmentCache(8, 2);
  const a = open(), b = open();
  a.set(1, Buffer.alloc(8));
  a.set(1, Buffer.alloc(2));
  b.set(1, Buffer.alloc(6));
  assert.ok(a.get(1));
  a.set(1, Buffer.alloc(9).subarray(0, 1));
  assert.equal(a.get(1), undefined);
  assert.ok(b.get(1));
});
