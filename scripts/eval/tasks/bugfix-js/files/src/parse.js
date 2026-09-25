import { toCents } from './money.js';

/**
 * Items from lines of `name,qty,price` (price in dollars). Blank lines and lines starting with # are skipped.
 * Errors name the 1-based line number.
 */
export function parseItems(text) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const [name, qty, price] = line.split(',').map((s) => s.trim());
    if (!name || qty === undefined || price === undefined) throw new Error(`line ${i}: expected name,qty,price`);
    const q = Number(qty);
    if (!Number.isInteger(q) || q <= 0) throw new Error(`line ${i}: bad quantity`);
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) throw new Error(`line ${i}: bad price`);
    items.push({ name, qty: q, price: toCents(p) });
  }
  return items;
}
