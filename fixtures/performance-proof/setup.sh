#!/bin/sh
# Builds the performance-proof fixture in $1: the synthetic base/change sample files (no benchmark runs) and a
# project config whose `performance:` block sets regression_pct 20, and three plans whose `## Risk` flag line
# states budget_pct=20, budget_pct=12 and an unparseable budget_pct. Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1/.agents"
cp -R "$here/samples" "$1/samples"
cat > "$1/.agents/config.yaml" <<'X'
performance:
  regression_pct: 20
  noise_pct: 5
  min_runs: 10
X
for b in 20 12 abc; do
  printf '# Plan\n\n## Risk\n\nperformance_critical: yes budget_pct=%s\n' "$b" > "$1/PLAN-$b.md"
done
