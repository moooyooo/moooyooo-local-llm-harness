import { formatCents } from './money.js';

/** A shopping cart. Prices are in cents. */
export class Cart {
  constructor() {
    this.lines = new Map();
  }

  add({ name, qty, price }) {
    const line = this.lines.get(name);
    if (line) line.qty += qty;
    else this.lines.set(name, { name, qty, price });
  }

  remove(name, qty) {
    const line = this.lines.get(name);
    if (!line) throw new Error(`not in cart: ${name}`);
    line.qty -= qty;
    if (line.qty <= 0) this.lines.delete(name);
  }

  subtotal() {
    let sum = 0;
    for (const l of this.lines.values()) sum += l.qty * l.price;
    return sum;
  }

  /** 10% off every line bought in a quantity of 10 or more, rounded to the cent per line. */
  bulkDiscount() {
    let off = 0;
    for (const l of this.lines.values()) {
      if (l.qty > 10) off += Math.round(l.qty * l.price * 0.1);
    }
    return off;
  }

  /** Tax is charged on the amount after the discount, rounded to the cent. */
  total(taxRate = 0) {
    const discounted = this.subtotal() - this.bulkDiscount();
    const tax = Math.round(this.subtotal() * taxRate);
    return discounted + tax;
  }

  /** One line per item sorted by name, then the discount and the total. */
  receipt(taxRate = 0) {
    const rows = [...this.lines.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => `${l.name} x${l.qty} ${formatCents(l.qty * l.price)}`);
    rows.push(`discount ${formatCents(-this.bulkDiscount())}`);
    rows.push(`total ${formatCents(this.total(taxRate))}`);
    return rows.join('\n');
  }
}
