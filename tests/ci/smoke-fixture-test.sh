#!/bin/sh
# The real-session smoke fixture (tests/real-session/smoke.sh fixture_commands) must leave no empty commands.build|test|lint, otherwise the batch
# pre-flight (A200) tells the lead to stop at the first NEXT line of the batch (A202 smoke run 3) and the scenario measures nothing.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd); repo=$(CDPATH='' cd "$here/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-smoke-fixture.XXXXXX"); trap 'rm -rf "$T"' EXIT HUP INT TERM
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
P=$T/p; mkdir -p "$P"
# the fixture's own package.json line and function, taken from smoke.sh itself
grep -q '"build": "node --check src/greet.js", "lint": "node --check tests/greet.test.js"' "$repo/tests/real-session/smoke.sh" || { echo "FAIL: smoke fixture package.json has no build and lint scripts" >&2; exit 1; }
git -C "$P" init -q -b main; printf '{ "name": "x", "scripts": { "test": "node --test" } }\n' > "$P/package.json"; git -C "$P" add -A; git -C "$P" commit -q -m base
(cd "$P" && "$repo/bin/proofline" init --yes --runtimes claude --lead claude --worker claude --reviewers claude --profile economy --task-adapter markdown) > "$T/init.txt" 2>&1 || { cat "$T/init.txt" >&2; exit 1; }
eval "$(sed -n '/^fixture_commands() {/,/^}/p' "$repo/tests/real-session/smoke.sh")"
fixture_commands
for k in build test lint; do
  v=$(sed -n "s/^  $k: *//p" "$P/.agents/config.yaml" | head -n 1)
  [ -n "$v" ] || { echo "FAIL: commands.$k is empty after fixture_commands" >&2; exit 1; }
done
# A226: the "a Codex implementer in a worktree" row. The old check, a text match over .agents/local and the transcript, passed on a batch whose implementers ran on Claude
# (a worktree carries roles.conf and *-test.sh files that say "implementer ... codex"); codex_dispatch_seen reads a real signal.
eval "$(sed -n '/^codex_dispatch_seen() {/,/^}/p' "$repo/tests/real-session/smoke.sh")"
eval "$(sed -n '/^codex_config_commit() {/,/^}/p' "$repo/tests/real-session/smoke.sh")"
D=$T/d; P=$D; mkdir -p "$D/.agents/local/worktrees/T-2/.agents" "$D/.agents/local/metrics"
printf 'implementer balanced codex tier2 high 2\n' > "$D/.agents/local/worktrees/T-2/.agents/roles.conf"
printf 'dispatch: T-2 implementer runtime=claude model=sonnet effort=high (ROLE_PROFILE) writes_code=yes\n' > "$T/claude-only.jsonl"
old_check() { grep -rqs 'implementer-codex\|implementer.*codex' "$P/.agents/local" "$1" 2>/dev/null; }
old_check "$T/claude-only.jsonl" || { echo "FAIL: the old check no longer shows the false positive on a claude-only batch" >&2; exit 1; }
codex_dispatch_seen "$T/claude-only.jsonl" && { echo "FAIL: codex_dispatch_seen passes a batch whose implementers ran on claude" >&2; exit 1; }
printf '{"kind":"dispatch","task":"T-2","role":"implementer","focus":null,"gate":null,"runtime":"claude","model":"sonnet"}\n' > "$D/.agents/local/metrics/records.jsonl"
codex_dispatch_seen "$T/claude-only.jsonl" && { echo "FAIL: a claude metrics record counts as a Codex dispatch" >&2; exit 1; }
printf 'dispatch: T-3 implementer runtime=codex model=gpt-6-sol effort=high (ROLE_PROFILE) writes_code=yes\n' > "$T/codex.jsonl"
codex_dispatch_seen "$T/codex.jsonl" || { echo "FAIL: a codex dispatch line in the transcript is not seen" >&2; exit 1; }
printf '{"kind":"dispatch","task":"T-3","role":"implementer","focus":null,"gate":null,"runtime":"codex","model":"gpt-6-sol"}\n' >> "$D/.agents/local/metrics/records.jsonl"
codex_dispatch_seen "$T/claude-only.jsonl" || { echo "FAIL: a codex metrics record is not seen" >&2; exit 1; }
rm -f "$D/.agents/local/metrics/records.jsonl"; mkdir -p "$D/.agents/local/worktrees/T-3/.agents/runs/T-3/dispatch"; : > "$D/.agents/local/worktrees/T-3/.agents/runs/T-3/dispatch/001-implementer-codex.log"
codex_dispatch_seen "$T/claude-only.jsonl" || { echo "FAIL: a dispatch file of a Codex implementer is not seen" >&2; exit 1; }
# codex_config_commit puts the Codex config on MAIN and the origin's main even when the lead left a task branch checked out
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/codex"; chmod +x "$T/bin/codex"
O=$T/origin.git; P=$T/p2; git init -q --bare -b main "$O"; git init -q -b main "$P"; mkdir -p "$P/.agents"; printf 'runtime:\n  lead: claude\n  roles:\n' > "$P/.agents/config.yaml"
git -C "$P" add -A; git -C "$P" commit -q -m base; git -C "$P" remote add origin "$O"; git -C "$P" push -q origin main; git -C "$P" checkout -q -b proofline/T-1-x
PATH="$T/bin:$PATH" codex_config_commit || { echo "FAIL: codex_config_commit failed on a task branch" >&2; exit 1; }
git -C "$P" show main:.agents/config.yaml | grep -q '^    implementer: codex' || { echo "FAIL: the Codex config is not on main" >&2; exit 1; }
git --git-dir="$O" show main:.agents/config.yaml | grep -q '^    implementer: codex' || { echo "FAIL: the Codex config is not on the origin's main" >&2; exit 1; }
git -C "$P" show proofline/T-1-x:.agents/config.yaml | grep -q 'implementer: codex' && { echo "FAIL: the Codex config landed on the task branch" >&2; exit 1; }
PATH="$T/bin:$PATH" codex_config_commit || { echo "FAIL: codex_config_commit is not idempotent" >&2; exit 1; }
echo "smoke-fixture-test: all passed"
