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
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-test.XXXXXX")
trap 'chmod -R u+w "$base" 2>/dev/null; rm -rf "$base"' EXIT
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
# The fixture repository is built once per process and copied for every new_repo (A76).
new_repo() { # -> cwd inside a fresh fixture repository with the control plane installed (nothing committed)
  if [ ! -d "$base/template" ]; then
    mkdir "$base/template"; install_control_plane "$base/template"
    git -C "$base/template" init -q -b main
    printf '.agents/runs/\n.agents/local/\n' > "$base/template/.gitignore"
  fi
  fx=$(mktemp -d "$base/fx.XXXXXX"); cp -R "$base/template/." "$fx/"; cd "$fx" || exit 1
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
result_for() {
  rf_g=$1 rf_r=$2 rf_c=${3:-high}; shift 2; [ $# -eq 0 ] || shift
  rf_art=$(report_path "$rf_g"); mkdir -p ".agents/runs/$RID/$(dirname "$rf_art")"
  printf '# %s report\n\nVerdict: %s\n\nJudged the whole current tree.\n' "$rf_g" "$rf_r" > ".agents/runs/$RID/$rf_art"
  rf_f=$base/result.$$.md
  {
    printf 'ROLE: %s\nTASK: %s\n' "$(gate_owner "$rf_g")" "$RID"
    [ -z "$(gate_focus "$rf_g")" ] || printf 'FOCUS: %s\n' "$(gate_focus "$rf_g")"
    printf 'RESULT: %s\nCONFIDENCE: %s\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n' "$rf_r" "$rf_c" "$(A fingerprint "$RID")" "$rf_art" "$(tsha ".agents/runs/$RID/$rf_art")"
    printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n'
    for rf_row in "$@"; do printf '| %s |\n' "$(printf '%s' "$rf_row" | sed 's/|/ | /g')"; done
  } > "$rf_f"
  printf '%s\n' "$rf_f"
}
rec() { rc_f=$(result_for "$@"); AGENT_ROLE=$(gate_owner "$1") sh ./.agents/scripts/agent.sh record "$RID" --file "$rc_f" >/dev/null; }
gpass() { rec "$1" PASS; }
# gfail GATE FIX-PATH: one blocking finding on that path.
gfail() { rec "$1" FAIL high "$1-1|blocking|$2:1|lookup returns the wrong value for an empty key|traced: empty key -> nil"; }
required() { pipe_val gates; }
pass_all() {
  for pa_g in $(required); do
    if [ "$pa_g" = SECRETS ]; then A secret-scan "$RID" >/dev/null; else gpass "$pa_g"; fi
  done
}

# --- implementation helpers ------------------------------------------------------------------
wopen() { W=$(A window-open "$RID"); }
wclose() { A window-close "$RID" "$W" 0 >/dev/null; }
wev() { # phase result [target]
  e_ef=''; [ "$1" = RED ] && e_ef='expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet'
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
  A knowledge-done "$RID" not_applicable >/dev/null
  write_report "$@"
  A publish-completion-report "$RID" markdown >/dev/null
  A handoff "$RID" DONE >/dev/null
}
tc_status() { awk -v s="$2" '/^\*\*Status:\*\*/ { print "**Status:** " s; next } { print }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"; }
# capture TEXT [TIME]: a user-prompt capture as a runtime hook writes it (.agents/local/prompts/<session>.json).
capture() {
  cp_time=${2:-$(( $(date +%s) + 5 ))}; mkdir -p .agents/local/prompts
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
  case "$class" in TRIVIAL) ;; *) printf '%s\n' '# Evidence' '' '## Assumptions' 'none' '' '## Claims' > "$d/EVIDENCE.md"; printf '# QA plan\n\n- QA-1 (AC-1): lookup returns the stored value\n' > "$d/QA_PLAN.md" ;; esac
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl_test.txt' '    criteria: [AC-1]' '---' '# Plan' '' '## Assumptions' 'none' '' '## Architecture' 'one storage map; no new module' > "$d/PLAN.md"
  [ -z "${SC_PLAN_EXTRA:-}" ] || printf '%s\n' "$SC_PLAN_EXTRA" >> "$d/PLAN.md"
  printf '%s\n' 'task:' '  id: LC' 'repository:' '  base_sha: PENDING' "${SC_BRANCH:+  canonical_branch: PENDING}" "${SC_BRANCH:+  task_branch: PENDING}" 'task_source:' '  type: local_markdown' "  path: $tpath" '  revision: PENDING' \
    'execution:' '  mode: deterministic' '  profile: PENDING' "  autonomy: $auto" "  topology: $topo" '  state: PLANNING' '  knowledge_state: not_started' '  awaiting_input: false' \
    'pipeline:' '  classification: PENDING' '  review: PENDING' '  tier: PENDING' \
    'freeze:' '  task_sha256: PENDING' '  evidence_sha256: PENDING' '  plan_sha256: PENDING' '  qa_plan_sha256: PENDING' '  policy_sha256: PENDING' '  pipeline: PENDING' '  scope_paths: PENDING' \
    'baseline:' '  status: pending' \
    'handoff:' '  state: PLANNED' '  implemented_patch_sha256: PENDING' '  code_done_patch_sha256: PENDING' \
    'worker_evidence:' '  required: true' 'tdd:' '  required: true' \
    'completion_report:' '  required: true' '  adapter: PENDING' '  published: false' '  receipt: PENDING' \
    'lifecycle_gates:' '  required: true' | sed '/^$/d' > "$d/RUN.yaml"
  : > impl.txt; : > impl_test.txt
  if [ "$layout" = yes ]; then
    mkdir -p tasks/todo; printf '%s\n' '# LC task' '' '**Status:** todo' '' '## Requirements' '' '- lookup returns the documented default for an empty key' > tasks/todo/LC.md
  else
    printf '# LC task\n' > tasks/LC.md
  fi
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
