#!/bin/bash
# Runs the task's original tests against the agent's work (the copies in the folder may have been edited).
set -uo pipefail
TASK=$(cd "$(dirname "$0")" && pwd)
rm -rf tests && cp -r "$TASK/files/tests" ./tests
python3 -m unittest discover -s tests -t . 2>&1 | tail -15
