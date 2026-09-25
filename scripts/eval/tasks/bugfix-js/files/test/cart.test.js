import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cart } from '../src/cart.js';

function cart() {
  const c = new Cart();
  c.add({ name: 'pear', qty: 2, price: 125 });
  c.add({ name: 'apple', qty: 4, price: 50 });
  c.add({ name: 'apple', qty: 6, price: 50 });
  return c;
}

test('adding the same item merges the lines', () => {
  assert.equal(cart().lines.get('apple').qty, 10);
  assert.equal(cart().subtotal(), 750);
});

test('removing everything deletes the line', () => {
  const c = cart();
  c.remove('pear', 2);
  assert.equal(c.lines.has('pear'), false);
  assert.throws(() => c.remove('kiwi', 1), /not in cart/);
});

test('a quantity of exactly 10 gets the bulk discount', () => {
  assert.equal(cart().bulkDiscount(), 50);
});

test('tax is charged after the discount', () => {
  // 750 - 50 = 700, plus 10% tax = 770.
  assert.equal(cart().total(0.1), 770);
});

test('receipt', () => {
  assert.equal(cart().receipt(0.1), ['apple x10 $5.00', 'pear x2 $2.50', 'discount -$0.50', 'total $7.70'].join('\n'));
});
