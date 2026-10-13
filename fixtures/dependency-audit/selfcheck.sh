#!/bin/sh
# Proves the planted facts of the dependency-audit fixture built in $1 against the skill's own scripts
# (skills/exploit-proof/scripts/diff-manifests.mjs and validate-dependencies.mjs). Offline; runs no audit tool.
set -eu
HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
SCRIPTS=$HERE/../../skills/exploit-proof/scripts
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
command -v node >/dev/null 2>&1 || { echo "selfcheck: SKIPPED: node not available"; exit 0; }

[ "$(git rev-parse --abbrev-ref HEAD)" = "feature/dep-update" ] || fail "HEAD is not feature/dep-update"
[ "$(git rev-list --count main..feature/dep-update)" -eq 1 ] || fail "dep-update must be one commit"
[ "$(git rev-list --count main..feature/dep-ok)" -eq 1 ] || fail "dep-ok must be one commit"
[ -z "$(git status --porcelain)" ] || fail "working tree not clean"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/dependency-audit-selfcheck-XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# record_audit <in> <out>: what the agent adds. A detected audit tool that cannot run (no network) is recorded as
# tool_unavailable, never left silent.
record_audit() {
  node -e '
    const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (d.audit.status === "not_run") d.audit = { status: "tool_unavailable", command: d.audit_candidates[0].command, reason: "selfcheck: no network" };
    fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$1" "$2"
}
# summary <json>: "<id-less list of blocking reasons:name>" sorted, one line.
summary() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(d.changes.filter((c) => c.class === "blocking").map((c) => `${c.reasons.join("+")}:${c.name}`).sort().join(" "));' "$1"
}

# --- feature/dep-update with the policy and the plan --------------------------------------------
node "$SCRIPTS/diff-manifests.mjs" --base main --plan .agents/runs/DA-1/PLAN-fail.md --out "$tmp/fail.raw.json"
record_audit "$tmp/fail.raw.json" "$tmp/fail.json"
want="license_denied:copyleft-lib undeclared_dependency:quick-json undeclared_install_script:scripts.postinstall"
[ "$(summary "$tmp/fail.json")" = "$want" ] || fail "blocking set differs: $(summary "$tmp/fail.json")"
out=$(node "$SCRIPTS/validate-dependencies.mjs" "$tmp/fail.json" --table) || fail "validator rejected the document"
echo "$out" | grep -qx 'RESULT: FAIL' || fail "expected RESULT: FAIL"
echo "$out" | grep -qx 'CONFIDENCE: medium' || fail "expected CONFIDENCE: medium (audit tool unavailable)"
[ "$(echo "$out" | grep -c '| blocking |')" -eq 3 ] || fail "expected 3 blocking rows"
echo "$out" | grep -q 'known vulnerabilities not checked' || fail "tool-unavailable is not stated"
# decoys: declared / flagged-but-declared / lockfile-only are notes, never blocking
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const by = (f, n) => d.changes.find((c) => c.file === f && c.name === n);
  const note = (f, n) => { const c = by(f, n); if (!c || c.class !== "note") { console.error("not a note: " + f + " " + n); process.exit(1); } return c; };
  note("package.json", "uuid-lite");
  note("package.json", "date-utils");
  if (!note("package.json", "git-tool").flags.includes("git_url")) process.exit(1);
  if (!note("package.json", "fmt-lite").flags.includes("unpinned")) process.exit(1);
  const ms = note("package-lock.json", "ms"); if (ms.direct) process.exit(1);
  const ih = note("package-lock.json", "inner-helper"); if (ih.direct || !ih.flags.includes("install_script")) process.exit(1);
' "$tmp/fail.json" || fail "decoy classification differs"

# --- the same change without a license policy: not configured, never a PASS ------------------
node "$SCRIPTS/diff-manifests.mjs" --base main --plan .agents/runs/DA-1/PLAN-fail.md --config /dev/null --out "$tmp/nopolicy.raw.json"
record_audit "$tmp/nopolicy.raw.json" "$tmp/nopolicy.json"
[ "$(summary "$tmp/nopolicy.json")" = "undeclared_dependency:quick-json undeclared_install_script:scripts.postinstall" ] || fail "no-policy blocking set differs"
node "$SCRIPTS/validate-dependencies.mjs" "$tmp/nopolicy.json" --table | grep -q 'license policy not configured' || fail "not-configured license check is not stated"

# --- an audit tool detected and not run is rejected (silence is not a result) ---------------
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (d.audit_candidates.length === 0) d.audit_candidates.push({ tool: "npm", command: "npm audit --json", source: "selfcheck" });
  d.audit = { status: "not_run" }; fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$tmp/fail.json" "$tmp/silent.json"
if node "$SCRIPTS/validate-dependencies.mjs" "$tmp/silent.json" >/dev/null 2>&1; then fail "a silent audit was accepted"; fi

# --- feature/dep-ok: everything declared -> PASS ------------------------------------------------
git checkout -q feature/dep-ok
node "$SCRIPTS/diff-manifests.mjs" --base main --plan .agents/runs/DA-1/PLAN-ok.md --out "$tmp/ok.raw.json"
record_audit "$tmp/ok.raw.json" "$tmp/ok.json"
[ -z "$(summary "$tmp/ok.json")" ] || fail "dep-ok has blocking changes"
out=$(node "$SCRIPTS/validate-dependencies.mjs" "$tmp/ok.json") || fail "validator rejected dep-ok"
echo "$out" | grep -qx 'RESULT: PASS' || fail "expected RESULT: PASS on dep-ok"
git checkout -q feature/dep-update
echo "selfcheck: dependency-audit facts ok"
