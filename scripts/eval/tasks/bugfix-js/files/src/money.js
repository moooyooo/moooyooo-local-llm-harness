// Money is kept in integer cents to avoid floating-point errors.

export function toCents(amount) {
  return Math.round(amount * 100);
}

/** 105 → "$1.05", -250 → "-$2.50". */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100)}`;
}
