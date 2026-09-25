import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCents, toCents } from '../src/money.js';

test('toCents rounds to the nearest cent', () => {
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(19.999), 2000);
});

test('formatCents pads the cents and keeps the sign', () => {
  assert.equal(formatCents(105), '$1.05');
  assert.equal(formatCents(7), '$0.07');
  assert.equal(formatCents(1250), '$12.50');
  assert.equal(formatCents(-250), '-$2.50');
});
