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
echo "smoke-fixture-test: all passed"
