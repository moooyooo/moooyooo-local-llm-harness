import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItems } from '../src/parse.js';

test('parses items, skipping comments and blank lines', () => {
  const text = '# shop list\napple, 3, 0.5\n\npear,2,1.25\n';
  assert.deepEqual(parseItems(text), [
    { name: 'apple', qty: 3, price: 50 },
    { name: 'pear', qty: 2, price: 125 },
  ]);
});

test('errors name the 1-based line', () => {
  assert.throws(() => parseItems('apple,1,1\n\nfig,x,2'), { message: 'line 3: bad quantity' });
  assert.throws(() => parseItems('fig,1'), { message: 'line 1: expected name,qty,price' });
  assert.throws(() => parseItems('# a\nfig,1,-3'), { message: 'line 2: bad price' });
});
