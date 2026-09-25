# inventory

A small inventory module (`inventory.py`) and command-line tool. Standard library only.

## `Inventory`

- `Inventory()` starts empty.
- `add(name, qty, price)` adds `qty` units of `name`. Adding an item that already exists increases its quantity and
  replaces its unit price. `qty` must be a positive int and `price` a non-negative number; otherwise raise `ValueError`.
- `remove(name, qty)` removes `qty` units. Raise `KeyError` for an unknown item and `ValueError` when there are fewer
  than `qty` units or `qty` is not positive. An item whose quantity reaches 0 is deleted.
- `quantity(name)` returns the quantity, or 0 for an unknown item.
- `total_value()` returns the sum of quantity × price over all items, rounded to 2 decimals.
- `low_stock(threshold)` returns the names of items with quantity below `threshold`, sorted by name.
- `names()` returns all item names, sorted.
- `to_csv(path)` writes `name,qty,price` with a header line, rows sorted by name.
- `Inventory.from_csv(path)` (classmethod) reads such a file. Blank lines are skipped.
- `report()` returns a text table: a header line `NAME         QTY     PRICE     VALUE`, then one line per item sorted by name,
  then a line `TOTAL` with the total value. Columns: name left-aligned in 10 characters, then a space, quantity
  right-aligned in 5, then a space, price right-aligned in 9 with 2 decimals, then a space, value (qty × price)
  right-aligned in 9 with 2 decimals. The total line is `TOTAL` left-aligned in 10, then a space, 5 spaces, a space,
  9 spaces, a space, and the total right-aligned in 9 with 2 decimals. Lines are joined with `\n`, no trailing newline.

## Command line

`python3 inventory.py report FILE.csv` prints the report of the CSV file.
`python3 inventory.py low FILE.csv THRESHOLD` prints the low-stock names, one per line.
Anything else prints a usage message to stderr and exits with status 2.
