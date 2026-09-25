import os
import subprocess
import sys
import tempfile
import unittest

from inventory import Inventory

HERE = os.path.dirname(os.path.abspath(__file__))


class InventoryTest(unittest.TestCase):
    def make(self):
        inv = Inventory()
        inv.add("apple", 10, 0.5)
        inv.add("pear", 3, 1.25)
        inv.add("fig", 1, 3)
        return inv

    def test_add_and_quantity(self):
        inv = self.make()
        self.assertEqual(inv.quantity("apple"), 10)
        self.assertEqual(inv.quantity("kiwi"), 0)

    def test_add_existing_updates_price(self):
        inv = self.make()
        inv.add("apple", 5, 0.6)
        self.assertEqual(inv.quantity("apple"), 15)
        self.assertEqual(inv.total_value(), round(15 * 0.6 + 3 * 1.25 + 3, 2))

    def test_add_rejects_bad_values(self):
        inv = Inventory()
        for qty, price in [(0, 1), (-1, 1), (1.5, 1), (1, -0.01)]:
            with self.assertRaises(ValueError):
                inv.add("x", qty, price)

    def test_remove(self):
        inv = self.make()
        inv.remove("apple", 4)
        self.assertEqual(inv.quantity("apple"), 6)
        inv.remove("fig", 1)
        self.assertEqual(inv.names(), ["apple", "pear"])

    def test_remove_errors(self):
        inv = self.make()
        with self.assertRaises(KeyError):
            inv.remove("kiwi", 1)
        with self.assertRaises(ValueError):
            inv.remove("pear", 4)
        with self.assertRaises(ValueError):
            inv.remove("pear", 0)
        self.assertEqual(inv.quantity("pear"), 3)

    def test_total_value_rounding(self):
        inv = Inventory()
        inv.add("a", 3, 0.1)
        self.assertEqual(inv.total_value(), 0.3)

    def test_low_stock(self):
        self.assertEqual(self.make().low_stock(5), ["fig", "pear"])
        self.assertEqual(self.make().low_stock(1), [])

    def test_csv_round_trip(self):
        inv = self.make()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "inv.csv")
            inv.to_csv(path)
            with open(path) as f:
                self.assertEqual(f.read().splitlines(), ["name,qty,price", "apple,10,0.5", "fig,1,3", "pear,3,1.25"])
            again = Inventory.from_csv(path)
        self.assertEqual(again.names(), ["apple", "fig", "pear"])
        self.assertEqual(again.total_value(), inv.total_value())

    def test_from_csv_skips_blank_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "inv.csv")
            with open(path, "w") as f:
                f.write("name,qty,price\n\nplum,2,0.75\n\n")
            inv = Inventory.from_csv(path)
        self.assertEqual(inv.quantity("plum"), 2)

    def test_report(self):
        expected = "\n".join([
            "NAME         QTY     PRICE     VALUE",
            "apple         10      0.50      5.00",
            "fig            1      3.00      3.00",
            "pear           3      1.25      3.75",
            "TOTAL                          11.75",
        ])
        self.assertEqual(self.make().report(), expected)

    def test_cli_report_and_low(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "inv.csv")
            self.make().to_csv(path)
            script = os.path.join(HERE, "inventory.py")
            out = subprocess.run([sys.executable, script, "report", path], capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), self.make().report())
            out = subprocess.run([sys.executable, script, "low", path, "5"], capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.split(), ["fig", "pear"])

    def test_cli_usage(self):
        script = os.path.join(HERE, "inventory.py")
        out = subprocess.run([sys.executable, script, "nope"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)
        self.assertTrue(out.stderr)


if __name__ == "__main__":
    unittest.main()
