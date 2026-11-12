#!/usr/bin/env bash
# T3 lead: E-series before/after experiments. Run AFTER corpus copy + patch package are ready.
# Usage: bash run-experiments.sh <corpusRoot> <patchedLibPath>
set -u
H="$(cd "$(dirname "$0")" && pwd)"
E="$H/../experiments"
mkdir -p "$E"
CORPUS="${1:?corpus root required}"
PATCHED="${2:?patched lib path required}"
BASELINE="/Users/open/.npm/_npx/f0e663d3a92a984e/node_modules/@deepseek-ai/dsh-session-query-sqlite/lib/index.js"
run() { # label lib db budget fresh
  local label="$1" lib="$2" db="$3" budget="$4" fresh="$5"
  echo "=== $label ==="
  node "$H/bench.mjs" --lib "$lib" --corpus "$CORPUS" --db "$db" --budget "$budget" --label "$label" $fresh | tee "$E/$label.json"
}
run E1-baseline-p1-30s   "$BASELINE" "$E/db-e1.sqlite" 30000 --fresh
run E5-baseline-p1-10s   "$BASELINE" "$E/db-e5.sqlite" 10000 --fresh
run E2-patched-p1-30s    "$PATCHED"  "$E/db-e2.sqlite" 30000 --fresh
run E3-patched-resume-30s "$PATCHED" "$E/db-e2.sqlite" 30000 ""
run E4-patched-warm-30s  "$PATCHED"  "$E/db-e2.sqlite" 30000 ""
run E6-patched-nobudget  "$PATCHED"  "$E/db-e6.sqlite" 0     --fresh
run E5p-patched-10s      "$PATCHED"  "$E/db-e5p.sqlite" 10000 --fresh
echo "ALL EXPERIMENTS DONE"