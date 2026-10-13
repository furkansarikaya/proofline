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
want="license_denied:copyleft-lib undeclared_dependency:evil-crate undeclared_dependency:evilcrate undeclared_dependency:evilnpm undeclared_dependency:evilpy undeclared_dependency:evilreq undeclared_dependency:markerpkg undeclared_dependency:nested undeclared_dependency:org.evil:lib undeclared_dependency:quick-json undeclared_index:index:pkgs.evil.example undeclared_install_script:scripts.postinstall"
[ "$(summary "$tmp/fail.json")" = "$want" ] || fail "blocking set differs: $(summary "$tmp/fail.json")"
out=$(node "$SCRIPTS/validate-dependencies.mjs" "$tmp/fail.json" --table) || fail "validator rejected the document"
echo "$out" | grep -qx 'RESULT: FAIL' || fail "expected RESULT: FAIL"
echo "$out" | grep -qx 'CONFIDENCE: medium' || fail "expected CONFIDENCE: medium (audit tool unavailable)"
[ "$(echo "$out" | grep -c '| blocking |')" -eq 12 ] || fail "expected 12 blocking rows"
echo "$out" | grep -q 'known vulnerabilities not checked' || fail "tool-unavailable is not stated"
# decoys: declared / flagged-but-declared / lockfile-only are notes, never blocking
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const by = (f, n) => d.changes.find((c) => c.file === f && c.name === n);
  const note = (f, n) => { const c = by(f, n); if (!c || c.class !== "note") { console.error("not a note: " + f + " " + n); process.exit(1); } return c; };
  note("package.json", "uuid-lite");
  note("pyproject.toml", "foo");          // extras in the name: "foo[bar]>=1.0" is read, and evilpy after it is not hidden
  note("Cargo.toml", "unixcrate");        // target table form, declared
  note("build.gradle", "org.acme:bom");   // platform(...) notation, declared
  const by2 = (f, n) => d.changes.find((c) => c.file === f && c.name === n);
  const ren = by2("Cargo.toml", "evil-crate");            // renamed crate: the real name, alias kept
  if (!ren || ren.alias !== "renamed" || !ren.flags.includes("alias")) { console.error("cargo rename not recorded under the real name"); process.exit(1); }
  const al = by2("package.json", "evilnpm");               // npm alias
  if (!al || al.alias !== "al" || !al.flags.includes("alias")) { console.error("npm alias not recorded under the real name"); process.exit(1); }
  if (!by2("deps/extra.pip", "evilreq")) { console.error("include target with any file name not read"); process.exit(1); }
  if (d.changes.some((c) => c.name === "index:pypi.org")) { console.error("the default index was reported"); process.exit(1); }
  const mk = by2("requirements.txt", "markerpkg");        // env marker without a space is not part of the version
  if (!mk || mk.to[0] !== ">=1.0" || !mk.flags.includes("unpinned")) { console.error("env marker handling: " + JSON.stringify(mk)); process.exit(1); }
  const ne = by2("requirements.txt", "nested");            // nested extras
  if (!ne || ne.to[0] !== "==2.0") { console.error("nested extras: " + JSON.stringify(ne)); process.exit(1); }
  note("package.json", "date-utils");
  if (!note("package.json", "git-tool").flags.includes("git_url")) process.exit(1);
  if (!note("package.json", "fmt-lite").flags.includes("unpinned")) process.exit(1);
  const ms = note("package-lock.json", "ms"); if (ms.direct) process.exit(1);
  const ih = note("package-lock.json", "inner-helper"); if (ih.direct || !ih.flags.includes("install_script")) process.exit(1);
' "$tmp/fail.json" || fail "decoy classification differs"

# --- the same change without a license policy: not configured, never a PASS ------------------
node "$SCRIPTS/diff-manifests.mjs" --base main --plan .agents/runs/DA-1/PLAN-fail.md --config /dev/null --out "$tmp/nopolicy.raw.json"
record_audit "$tmp/nopolicy.raw.json" "$tmp/nopolicy.json"
[ "$(summary "$tmp/nopolicy.json")" = "undeclared_dependency:evil-crate undeclared_dependency:evilcrate undeclared_dependency:evilnpm undeclared_dependency:evilpy undeclared_dependency:evilreq undeclared_dependency:markerpkg undeclared_dependency:nested undeclared_dependency:org.evil:lib undeclared_dependency:quick-json undeclared_index:index:pkgs.evil.example undeclared_install_script:scripts.postinstall" ] || fail "no-policy blocking set differs"
node "$SCRIPTS/validate-dependencies.mjs" "$tmp/nopolicy.json" --table | grep -q 'license policy not configured' || fail "not-configured license check is not stated"

# --- an audit tool detected and not run is rejected (silence is not a result) ---------------
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (d.audit_candidates.length === 0) d.audit_candidates.push({ tool: "npm", command: "npm audit --json", source: "selfcheck" });
  d.audit = { status: "not_run" }; fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$tmp/fail.json" "$tmp/silent.json"
if node "$SCRIPTS/validate-dependencies.mjs" "$tmp/silent.json" >/dev/null 2>&1; then fail "a silent audit was accepted"; fi

# --- a fresh run must reproduce the document (a hand-removed change is caught) -----------------
node "$SCRIPTS/validate-dependencies.mjs" "$tmp/fail.json" --repo . --base main --plan .agents/runs/DA-1/PLAN-fail.md >/dev/null || fail "re-derivation rejected the real document"
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  d.changes = d.changes.filter((c) => c.name !== "quick-json"); fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$tmp/fail.json" "$tmp/edited.json"
if node "$SCRIPTS/validate-dependencies.mjs" "$tmp/edited.json" --repo . --base main --plan .agents/runs/DA-1/PLAN-fail.md >/dev/null 2>&1; then fail "a document with a removed change was accepted"; fi

# --- measured audit: output, exit code and vulnerabilities must agree ---------------------------
# audit <status-json> <vulnerabilities-json> -> document on stdout
audit() {
  node -e '
    const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    d.audit = JSON.parse(process.argv[2]); d.vulnerabilities = JSON.parse(process.argv[3]);
    process.stdout.write(JSON.stringify(d));' "$tmp/fail.json" "$1" "$2"
}
OUT1="found 1 vulnerabilities\nquick-json  <1.4.2  GHSA-fake-0001-demo  high"
# listed vulnerability with its id in the output: accepted, FAIL, never high (exit 1)
audit "{\"status\":\"measured\",\"command\":\"npm audit --json\",\"exit_code\":1,\"output_excerpt\":\"$OUT1\"}" \
  '[{"id":"GHSA-fake-0001-demo","package":"quick-json","severity":"high","source":"audit_tool_output"}]' > "$tmp/vuln.json"
out=$(node "$SCRIPTS/validate-dependencies.mjs" "$tmp/vuln.json" --table) || fail "measured vulnerability document rejected"
echo "$out" | grep -qx 'CONFIDENCE: medium' || fail "a non-zero audit exit must cap confidence at medium"
echo "$out" | grep -q 'known vulnerability GHSA-fake-0001-demo in quick-json' || fail "vulnerability row missing"
# exit code 1 and an output that reports vulnerabilities, but none recorded: rejected
audit "{\"status\":\"measured\",\"command\":\"npm audit --json\",\"exit_code\":1,\"output_excerpt\":\"$OUT1\"}" '[]' > "$tmp/mismatch.json"
if node "$SCRIPTS/validate-dependencies.mjs" "$tmp/mismatch.json" >/dev/null 2>&1; then fail "empty vulnerabilities with a non-zero audit exit was accepted"; fi
# a prefix of the id is not the id
audit "{\"status\":\"measured\",\"command\":\"npm audit --json\",\"exit_code\":1,\"output_excerpt\":\"GHSA-fake-0001-demo-extra high\"}" \
  '[{"id":"GHSA-fake-0001-demo","package":"quick-json","severity":"high","source":"audit_tool_output"}]' > "$tmp/prefix.json"
if node "$SCRIPTS/validate-dependencies.mjs" "$tmp/prefix.json" >/dev/null 2>&1; then fail "a partial id match was accepted"; fi
# non-zero exit with an explained empty list: accepted, medium
audit '{"status":"measured","command":"npm audit --json","exit_code":1,"output_excerpt":"npm ERR! audit endpoint returned an error","no_findings_reason":"the tool failed to reach the registry; its output lists no advisories"}' '[]' > "$tmp/explained.json"
node "$SCRIPTS/validate-dependencies.mjs" "$tmp/explained.json" | grep -qx 'CONFIDENCE: medium' || fail "explained empty list must be accepted at medium"

# --- feature/dep-ok: everything declared -> PASS ------------------------------------------------
git checkout -q feature/dep-ok
node "$SCRIPTS/diff-manifests.mjs" --base main --plan .agents/runs/DA-1/PLAN-ok.md --out "$tmp/ok.raw.json"
record_audit "$tmp/ok.raw.json" "$tmp/ok.json"
[ -z "$(summary "$tmp/ok.json")" ] || fail "dep-ok has blocking changes"
out=$(node "$SCRIPTS/validate-dependencies.mjs" "$tmp/ok.json" --repo . --base main --plan .agents/runs/DA-1/PLAN-ok.md) || fail "validator rejected dep-ok"
echo "$out" | grep -qx 'RESULT: PASS' || fail "expected RESULT: PASS on dep-ok"
# a clean measurement (exit 0, none found) on the clean change is the one path to confidence high
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  d.audit = { status: "measured", command: "npm audit --json", exit_code: 0, output_excerpt: "found 0 vulnerabilities" };
  fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$tmp/ok.json" "$tmp/ok-measured.json"
node "$SCRIPTS/validate-dependencies.mjs" "$tmp/ok-measured.json" | grep -qx 'CONFIDENCE: high' || fail "a clean measured audit on dep-ok must be confidence high"
git checkout -q feature/dep-update
echo "selfcheck: dependency-audit facts ok"
