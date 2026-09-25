#!/bin/bash
# Runs the task's original tests against the agent's work (the copy in the folder may have been edited).
set -uo pipefail
TASK=$(cd "$(dirname "$0")" && pwd)
cp "$TASK/files/test_inventory.py" ./test_inventory.py
python3 -m unittest -q 2>&1 | tail -15
