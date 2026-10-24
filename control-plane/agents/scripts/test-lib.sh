#!/bin/sh
# shellcheck disable=SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: ls over our own fixture names, assertion chains
# Shared fixture helpers for the control-plane self-tests (*-test.sh in this directory). Sourced, never run.
# Every fixture is a throwaway git repository under $TMPDIR with the control plane installed in .agents/.
# Git runs without the user's global or system configuration, so no global hook or identity applies.
LC_ALL=C; export LC_ALL
GIT_CONFIG_GLOBAL=/dev/null; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
unset AGENT_ROLE 2>/dev/null || true

tl_agents=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)     # control-plane/agents (source) or .agents (installed)
# A fixture outside an existing temp dir would be built in the CURRENT directory (the real repository): stop first.
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-test.XXXXXX") || { echo "test-lib: TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }
[ -n "$base" ] && [ -d "$base" ] || { echo "test-lib: no fixture directory: ${TMPDIR:-/tmp}" >&2; exit 2; }
# Cleanup never decides the exit status (set -e in a trap would): a process still finishing inside $base
# (git maintenance) can make rm fail once, so retry; the assertions already decided the result.
trap 'chmod -R u+w "$base" 2>/dev/null || :; rm -rf "$base" 2>/dev/null || { sleep 1; rm -rf "$base" 2>/dev/null || :; }' EXIT
RID=LC

if command -v shasum >/dev/null 2>&1; then tsha() { shasum -a 256 "$1" | awk '{print $1}'; }; else tsha() { sha256sum "$1" | awk '{print $1}'; }; fi
# qa_bind ID: derive the QA plan's "Plan sha256" line from the current PLAN.md, as the qa role does (A42).
# A() does it before freeze and refreeze; QA_NO_BIND=1 leaves the plan as the test wrote it.
qa_bind() {
  qb_q=.agents/runs/$1/QA_PLAN.md; qb_p=.agents/runs/$1/PLAN.md
  [ -f "$qb_q" ] && [ -f "$qb_p" ] || return 0
  qb_h=$(tsha "$qb_p")
  { sed -n 1p "$qb_q"; printf '\nPlan sha256: %s\n' "$qb_h"; sed '1d' "$qb_q" | grep -v '^Plan sha256: '; } > "$qb_q.tmp" && mv "$qb_q.tmp" "$qb_q"
}
A() { case "${1:-}" in freeze|refreeze) [ -n "${QA_NO_BIND:-}" ] || qa_bind "${2:-}" ;; esac; sh ./.agents/scripts/agent.sh "$@"; }
AS() { as_r=$1; shift; AGENT_ROLE=$as_r sh ./.agents/scripts/agent.sh "$@"; }
ok() { printf 'ok %s\n' "$1"; }
die() { echo "FAIL: $*" >&2; exit 1; }
# expect_fail DESCRIPTION CMD... — the command must fail. LC_TRACE=1 prints why.
expect_fail() {
  ef_d=$1; shift
  if ef_out=$("$@" 2>&1); then die "$ef_d (command succeeded)"; fi
  if [ -n "${LC_TRACE:-}" ]; then printf '  rejected [%s]: %s\n' "$ef_d" "$(printf '%s' "$ef_out" | tail -1 | cut -c1-200)"; fi
}
# expect_msg DESCRIPTION PATTERN CMD... — the command must fail for this reason.
expect_msg() {
  em_d=$1 em_p=$2; shift 2
  if em_out=$("$@" 2>&1); then die "$em_d (command succeeded)"; fi
  printf '%s' "$em_out" | grep -Fq -- "$em_p" || die "$em_d (rejected for another reason: $(printf '%s' "$em_out" | tail -1))"
}
rv() { awk -v s="$1" -v k="$2" '$0 == s ":" { i=1; next } i && /^[^[:space:]#]/ { exit } i && $0 ~ "^  " k ":" { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' ".agents/runs/$RID/RUN.yaml"; }
expect_state() { [ "$(rv "$1" "$2")" = "$3" ] || die "expected $1.$2=$3, got '$(rv "$1" "$2")'"; }
pipe_val() { A pipeline "$RID" | sed -n "s/^$1=//p"; }

# install_control_plane DIR: the control plane as `proofline init` lays it out, plus test stubs for the
# scripts other workers own (exec-policy.sh, secret-scan.sh) and the markdown task adapter.
install_control_plane() {
  mkdir -p "$1/.agents/scripts" "$1/.agents/task-integrations" "$1/.agents/local"
  cp "$tl_agents/config.yaml" "$1/.agents/"; cp -R "$tl_agents/modes" "$tl_agents/templates" "$1/.agents/"
  cp "$tl_agents/scripts/agent.sh" "$1/.agents/scripts/"
  [ ! -f "$tl_agents/scripts/next-user.sh" ] || cp "$tl_agents/scripts/next-user.sh" "$1/.agents/scripts/"   # A159: agent.sh next-user runs it
  cat > "$1/.agents/scripts/secret-scan.sh" <<'STUB'
#!/bin/sh
# test stub: a line containing PLANTED_SECRET is a finding (path:line:rule); exit 1 on findings.
rc=0
for f in "$@"; do
  if grep -n PLANTED_SECRET "$f" > /dev/null 2>&1; then rc=1; grep -n PLANTED_SECRET "$f" | cut -d: -f1 | sed "s#^#$f:#; s#\$#:planted-secret#"; fi
done
[ -z "${STUB_SCAN_ERROR:-}" ] || exit 2
exit "$rc"
STUB
  cat > "$1/.agents/scripts/exec-policy.sh" <<'STUB'
#!/bin/sh
# test stub for the execution-policy resolver: echoes its inputs as a decision.
[ "${1:-}" = resolve ] || exit 2; shift
[ -z "${STUB_ARGS:-}" ] || printf '%s\n' "$*" >> "$STUB_ARGS"
model=sonnet sig='' rt=claude effort=medium
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) rt=$2 ;; --signal) sig="$sig $2" ;; --effort) effort=$2 ;;
    --model) model=$2; [ "$model" != bogus ] || exit 3 ;;
    --role|--class|--tier|--profile|--context-bytes|--escalations-used) ;;
    *) exit 3 ;;
  esac
  shift 2
done
case "$sig" in *fix_round_2*|*critical_class*|*low_confidence_pass*) model=opus ;; esac
printf 'runtime=%s\nmodel=%s\neffort=%s\ncontext_bytes=65536\ncapability_tier=2\nmodel_reason=stub%s\n' "$rt" "$model" "$effort" "$(printf '%s' "$sig" | tr ' ' '+')"
STUB
  cat > "$1/.agents/task-integrations/markdown.sh" <<'STUB'
#!/bin/sh
# Markdown task-integration adapter (fixture copy): publish appends the report under a delimited block in the
# task source; verify re-hashes it against the receipt.
set -eu
root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
op=${1:?usage: markdown.sh <publish|verify> ...}
task_source_path() { awk '/^task_source:$/ { i=1; next } i && /^[^[:space:]]/ { exit } i && /^[[:space:]]*path:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$root/.agents/runs/$1/RUN.yaml"; }
h() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; else sha256sum | awk '{print $1}'; fi; }
case "$op" in
  publish)
    id=$2 report=$3; path=$(task_source_path "$id"); target="$root/$path"; [ -f "$target" ] || exit 1
    begin="<!-- COMPLETION-REPORT:BEGIN:$id -->"; end="<!-- COMPLETION-REPORT:END:$id -->"; tmp=$(mktemp "${TMPDIR:-/tmp}/md-adapter.XXXXXX")
    if grep -Fq "$begin" "$target"; then
      awk -v b="$begin" -v e="$end" -v rf="$report" '$0 == b { print; while ((getline l < rf) > 0) print l; s=1; next } $0 == e { print; s=0; next } s { next } { print }' "$target" > "$tmp"
    else cp "$target" "$tmp"; { printf '\n## Completion Report\n\n%s\n' "$begin"; cat "$report"; printf '%s\n' "$end"; } >> "$tmp"; fi
    mv "$tmp" "$target"; printf '%s#%s\n' "$path" "$(h < "$report")" ;;
  verify)
    id=$2 receipt=$3; path=${receipt%%#*}; want=${receipt#*#}; target="$root/$path"; [ -f "$target" ] || exit 1
    got=$(awk -v b="<!-- COMPLETION-REPORT:BEGIN:$id -->" -v e="<!-- COMPLETION-REPORT:END:$id -->" '$0 == b { i=1; next } $0 == e { i=0; next } i { print }' "$target" | h)
    [ "$got" = "$want" ] ;;
  *) exit 2 ;;
esac
STUB
  chmod +x "$1/.agents/scripts/"*.sh "$1/.agents/task-integrations/markdown.sh"
}
# The fixture repository is built once per content hash of the control plane and the stubs above, shared by every
# test process of one run (tests/shared/fixture-lib.sh), and copied for every new_repo (A76). Each scenario
# gets its own copy, so no state is shared.
tl_build_template() { # DIR: an empty directory
  install_control_plane "$1"
  git -C "$1" init -q -b main
  printf '.agents/runs/\n.agents/local/\n' > "$1/.gitignore"
}
tl_fixture_lib=$tl_agents/../../tests/shared/fixture-lib.sh
# shellcheck source=../../../tests/shared/fixture-lib.sh
[ ! -f "$tl_fixture_lib" ] || . "$tl_fixture_lib"
tl_template=''
tl_ensure_template() {
  [ -z "$tl_template" ] || return 0
  if command -v fx_template >/dev/null 2>&1; then
    tl_key=$(fx_key "$tl_agents" config.yaml modes templates scripts/agent.sh scripts/next-user.sh scripts/test-lib.sh)
    tl_template=$(fx_template "ctl-$tl_key" tl_build_template) || { echo "test-lib: cannot build the fixture template" >&2; exit 2; }
  else
    mkdir "$base/template"; tl_build_template "$base/template"; tl_template=$base/template
  fi
}
# Once per test process, so every scenario subshell inherits it. A suite outside control-plane/agents/scripts
# (tests/*/) sets tl_agents itself after sourcing this file: no template then, new_repo makes it lazily.
[ ! -f "$tl_agents/config.yaml" ] || tl_ensure_template
new_repo() { # -> cwd inside a fresh fixture repository with the control plane installed (nothing committed)
  tl_ensure_template
  fx=$(mktemp -d "$base/fx.XXXXXX"); cp -R "$tl_template/." "$fx/"; cd "$fx" || exit 1
}

# --- gate results through the D12 protocol ----------------------------------------------------
gate_owner() { case "$1" in REVIEW_*) echo reviewer ;; SECURITY) echo security_reviewer ;; QA) echo qa ;; VERIFY) echo verifier ;; esac; }
gate_focus() { case "$1" in REVIEW_SMALL) echo rules+tests ;; REVIEW_PLAN) echo plan ;; REVIEW_RULES) echo rules ;; REVIEW_TESTS) echo tests ;; REVIEW_DATA) echo data ;; esac; }
report_path() {
  case "$1" in REVIEW_PLAN) echo reviews/proof-review/plan/REPORT.md ;; REVIEW_RULES) echo reviews/proof-review/rules/REPORT.md ;; REVIEW_SMALL) echo reviews/proof-review/small/REPORT.md ;;
    REVIEW_TESTS) echo reviews/test-trust/tests/REPORT.md ;; REVIEW_DATA) echo reviews/data-design/REVIEW.md ;;
    SECURITY) echo security/REPORT.md ;; QA) echo QA_REPORT.md ;; VERIFY) echo VERIFY.md ;; esac
}
# result_for GATE RESULT [CONFIDENCE] [ROW...] -> path of a result file (rows "id|severity|path:line|finding|evidence")
# RF_FOCUS=<risk focus> (A78): the result is that focus's, reported under its own directory.
risk_report() { case "$1" in contract) echo reviews/contract-proof/REPORT.md ;; concurrency) echo reviews/concurrency-proof/REPORT.md ;; performance) echo reviews/performance-proof/REPORT.md ;;
  config) echo reviews/proof-review/config/REPORT.md ;; migration) echo reviews/data-migration/REPORT.md ;; visual) echo reviews/visual-proof/REPORT.md ;; dependencies) echo security/dependencies/REPORT.md ;; logging) echo security/logging/REPORT.md ;; esac; }
result_for() {
  rf_g=$1 rf_r=$2 rf_c=${3:-high}; shift 2; [ $# -eq 0 ] || shift
  rf_art=$(report_path "$rf_g"); rf_fc=$(gate_focus "$rf_g")
  if [ -n "${RF_FOCUS:-}" ]; then rf_art=$(risk_report "$RF_FOCUS"); rf_fc=$RF_FOCUS; fi
  mkdir -p ".agents/runs/$RID/$(dirname "$rf_art")"
  printf '# %s report\n\nVerdict: %s\n\nJudged the whole current tree.\n' "$rf_g" "$rf_r" > ".agents/runs/$RID/$rf_art"
  rf_f=$base/result.$$.md
  {
    printf 'ROLE: %s\nTASK: %s\n' "$(gate_owner "$rf_g")" "$RID"
    [ -z "$rf_fc" ] || printf 'FOCUS: %s\n' "$rf_fc"
    printf 'RESULT: %s\nCONFIDENCE: %s\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n' "$rf_r" "$rf_c" "$(A fingerprint "$RID")" "$rf_art" "$(tsha ".agents/runs/$RID/$rf_art")"
    printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n'
    for rf_row in "$@"; do printf '| %s |\n' "$(printf '%s' "$rf_row" | sed 's/|/ | /g')"; done
  } > "$rf_f"
  printf '%s\n' "$rf_f"
}
rec() { rc_f=$(result_for "$@"); AGENT_ROLE=$(gate_owner "$1") sh ./.agents/scripts/agent.sh record "$RID" --file "$rc_f" >/dev/null; }
gpass() { rec "$1" PASS; }
# gfail GATE FIX-PATH: one blocking finding on that path.
gfail() { # the rules gates also record how they scanned and which instances they found (A171)
  case "$1" in REVIEW_RULES|REVIEW_SMALL) gf_ev="traced: empty key -> nil; scan: grep -n lookup $2; instances: single" ;; *) gf_ev='traced: empty key -> nil' ;; esac
  rec "$1" FAIL high "$1-1|blocking|$2:1|lookup returns the wrong value for an empty key|$gf_ev"
}
required() { pipe_val gates; }
pass_all() {
  for pa_g in $(required); do
    [ "$pa_g" != VERIFY ] || continue   # A171: VERIFY runs after the gates it depends on (QA visual)
    if [ "$pa_g" = SECRETS ]; then A secret-scan "$RID" >/dev/null; else gpass "$pa_g"; fi
  done
  # every risk focus a gate carries (A78)
  A pipeline "$RID" | sed -n 's/^focus\.\([A-Z_]*\)\.\([a-z]*\)=.*/\1 \2/p' | while read -r pa_g pa_f; do RF_FOCUS=$pa_f gpass "$pa_g"; done
  gpass VERIFY
}

# --- implementation helpers ------------------------------------------------------------------
wopen() { W=$(A window-open "$RID"); }
wclose() { A window-close "$RID" "$W" 0 >/dev/null; }
wev() { # phase result [target]; WEV_EF overrides the RED expected failure
  e_ef=''; [ "$1" = RED ] && e_ef="expected_failure: ${WEV_EF:-TestImpl fails: lookup is not implemented in impl.txt yet}"
  printf 'command: go test ./...\ntarget: %s\n%s\n' "${3:-impl.txt,impl_test.txt}" "$e_ef" | AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh worker-evidence "$RID" "$1" "$2" >/dev/null
}
worker() { wopen; printf '%s\n' "$4" >> "$3"; wev "$1" "$2"; wclose; }   # phase result file line
solo() { # phase result file line [target] — standalone: the lead implements and records its own evidence
  printf '%s\n' "$4" >> "$3"
  e_ef=''; [ "$1" = RED ] && e_ef='expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet'
  printf 'command: go test ./...\ntarget: %s\n%s\n' "${5:-impl.txt,impl_test.txt}" "$e_ef" | sh ./.agents/scripts/agent.sh worker-evidence "$RID" "$1" "$2" >/dev/null
}
write_report() {
  printf '%s\n' "# Completion Report: $RID" '' '## Implementation Summary' 'impl.txt and impl_test.txt changed under the lifecycle gates.' '' \
    '## TDD Evidence' 'RED then GREEN recorded by the expected implementation owner.' '' '## Verification' 'All gates passed on the final tree.' '' '## Assumptions' 'none' '' \
    '## Review Result' 'Approved on the final tree.' '' '## QA Result' 'Every frozen QA scenario passed on the final tree.' '' \
    '## Execution' 'Not applicable in fixtures.' '' '## Known Limitations / Follow-up' 'None.' "$@" > ".agents/runs/$RID/COMPLETION_REPORT.md"
}
finish_done() {
  A knowledge-done "$RID" not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  write_report "$@"
  A publish-completion-report "$RID" markdown >/dev/null
  A handoff "$RID" DONE >/dev/null
}
tc_status() { awk -v s="$2" '/^\*\*Status:\*\*/ { print "**Status:** " s; next } { print }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"; }
# capture TEXT [TIME]: a user-prompt capture as a runtime hook writes it (.agents/local/prompts/<session>.json).
capture() {
  cp_time=${2:-$(( $(date +%s) + 3600 ))}; mkdir -p .agents/local/prompts
  printf '%s' "$1" > "$base/cap.txt"
  cp_text=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"session":"s1","time":%s,"sha256":"%s","text":"%s"}\n' "$cp_time" "$(tsha "$base/cap.txt")" "$cp_text" > .agents/local/prompts/s1.json
}
approve_as_user() { # KIND TEXT
  A request-approval "$RID" "$1" >/dev/null; capture "$2"; A approve "$RID" "$1" >/dev/null
}

# scaffold <topology> [todo-layout:yes|no] [class] [autonomy] — a lifecycle_gates run frozen at handoff
# IMPLEMENTING, cwd inside the fixture. Scope impl.txt + impl_test.txt; the default class is COMPLEX.
# SC_BRANCH=1: the run gets a task branch (repository.task_branch), established after classify.
scaffold() {
  topo=$1 layout=${2:-no} class=${3:-COMPLEX} auto=${4:-autonomous}
  tpath=tasks/LC.md; [ "$layout" = yes ] && tpath=tasks/in-progress/LC.md
  new_repo; RID=LC; d=.agents/runs/LC; mkdir -p "$d" tasks
  printf 'LC\n' > .agents/local/ACTIVE_RUN
  printf '# Task: LC — lookup\n\n## Acceptance criteria\n\n- AC-1: lookup behavior\n' > "$d/TASK.md"
  [ -z "${SC_TASK_EXTRA:-}" ] || printf '%s\n' "$SC_TASK_EXTRA" >> "$d/TASK.md"
  case "$class" in TRIVIAL) ;; *) printf '%s\n' '# Evidence' '' '## Assumptions' 'none' '' '## Claims' > "$d/EVIDENCE.md"; printf '# QA plan\n\n- QA-1 (AC-1): lookup returns the stored value\n' > "$d/QA_PLAN.md"; [ "${SC_TEST_CRIT:-${SC_SCOPE_OTHER:-AC-1}}" = AC-1 ] || printf -- '- QA-2 (%s): second behavior\n' "${SC_TEST_CRIT:-$SC_SCOPE_OTHER}" >> "$d/QA_PLAN.md"; [ -z "${SC_QA_EXTRA:-}" ] || printf '%s\n' "$SC_QA_EXTRA" >> "$d/QA_PLAN.md" ;; esac
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' ${SC_EXEMPT:+'    tdd_exemption: fixture file without executable behaviour to test here'} '  - path: impl_test.txt' "    criteria: [${SC_TEST_CRIT:-AC-1}]" ${SC_EXEMPT:+'    tdd_exemption: fixture file without executable behaviour to test here'} ${SC_SCOPE_EXTRA:+'  - path: other.txt' "    criteria: [$SC_SCOPE_EXTRA]" '    tdd_exemption: fixture file without executable behaviour to test here'} ${SC_SCOPE_OTHER:+'  - path: far.txt' "    criteria: [$SC_SCOPE_OTHER]" '    tdd_exemption: fixture file without executable behaviour to test here'} ${SC_SCOPE_AGENTS:+'  - path: .agents/impl.txt' '    criteria: [AC-1]' '    tdd_exemption: fixture file without executable behaviour to test here'} ${SC_SCOPE_NAMED:+"  - path: $SC_SCOPE_NAMED" '    criteria: [AC-1]' '    tdd_exemption: fixture file without executable behaviour to test here'} '---' '# Plan' '' '## Assumptions' 'none' '' '## Architecture' 'one storage map; no new module' > "$d/PLAN.md"
  [ -z "${SC_PLAN_EXTRA:-}" ] || printf '%s\n' "$SC_PLAN_EXTRA" >> "$d/PLAN.md"
  printf '%s\n' 'task:' '  id: LC' 'repository:' '  base_sha: PENDING' "${SC_BRANCH:+  canonical_branch: PENDING}" "${SC_BRANCH:+  task_branch: PENDING}" 'task_source:' '  type: local_markdown' "  path: $tpath" '  revision: PENDING' \
    'execution:' '  mode: deterministic' '  profile: PENDING' "  autonomy: $auto" "  topology: $topo" '  state: PLANNING' '  knowledge_state: not_started' '  knowledge_reason: ""' '  awaiting_input: false' \
    'pipeline:' '  classification: PENDING' '  review: PENDING' '  tier: PENDING' \
    'freeze:' '  task_sha256: PENDING' '  evidence_sha256: PENDING' '  plan_sha256: PENDING' '  qa_plan_sha256: PENDING' '  policy_sha256: PENDING' '  pipeline: PENDING' '  scope_paths: PENDING' '  risk_sha256: PENDING' \
    'baseline:' '  status: pending' \
    'handoff:' '  state: PLANNED' '  implemented_patch_sha256: PENDING' '  code_done_patch_sha256: PENDING' \
    'worker_evidence:' '  required: true' 'tdd:' '  required: true' \
    'completion_report:' '  required: true' '  adapter: PENDING' '  published: false' '  receipt: PENDING' \
    'lifecycle_gates:' '  required: true' | sed '/^$/d' > "$d/RUN.yaml"
  : > impl.txt; : > impl_test.txt; [ -z "${SC_SCOPE_AGENTS:-}" ] || : > .agents/impl.txt; [ -z "${SC_SCOPE_EXTRA:-}" ] || : > other.txt; [ -z "${SC_SCOPE_OTHER:-}" ] || : > far.txt
  if [ "$layout" = yes ]; then
    mkdir -p tasks/todo; printf '%s\n' '# LC task' '' '**Status:** todo' '' '## Requirements' '' '- lookup returns the documented default for an empty key' > tasks/todo/LC.md
  else
    printf '# LC task\n' > tasks/LC.md
  fi
  [ -z "${SC_AGENTS_MD:-}" ] || printf '# Project\n\n## Project rules\n\nkeep it small\n\n<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n' > AGENTS.md
  [ "${SC_AGENTS_MD:-}" != 2 ] || printf '\n## Notes\n\n<!-- proofline:begin -->\nsecond pair\n<!-- proofline:end -->\n' >> AGENTS.md   # a second marker pair is product text (A155)
  [ -z "${SC_SCOPE_NAMED:-}" ] || { mkdir -p "$(dirname "$SC_SCOPE_NAMED")"; : > "$SC_SCOPE_NAMED"; }
  git add -A; git commit -qm baseline
  if [ "$layout" = yes ]; then mkdir -p tasks/in-progress; git mv tasks/todo/LC.md tasks/in-progress/LC.md; tc_status tasks/in-progress/LC.md in-progress; fi
  A classify LC "$class" >/dev/null
  [ -z "${SC_BRANCH:-}" ] || A branch LC >/dev/null
  A baseline LC >/dev/null; [ "$class" = TRIVIAL ] || printf 'discovered\n' >> "$d/EVIDENCE.md"; printf 'planned\n' >> "$d/PLAN.md"
  if [ "$auto" = autonomous ]; then A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null; fi
}
# Drive a scaffolded run (frozen, IMPLEMENTING) to CODE_DONE.
to_code_done() {
  if [ "$1" = orchestrated ]; then
    worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  else
    solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  fi
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
}
# LC_ONLY=<substring> runs only matching scenarios. LC_EXACT="name [arg]" runs only the scenario called exactly
# so (tests/selftest.sh splits a suite into one process per scenario this way, A76).
run_sc() {
  if [ -n "${LC_EXACT:-}" ]; then [ "$LC_EXACT" = "$*" ] || return 0
  elif [ -n "${LC_ONLY:-}" ]; then printf '%s' "$*" | grep -q -- "$LC_ONLY" || return 0; fi
  ( "$@" )
}
