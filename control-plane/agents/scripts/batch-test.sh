#!/bin/sh
# shellcheck disable=SC2010,SC2012,SC2086,SC2015,SC2154,SC2016,SC2329 # assertion chains; tl_agents and base come from test-lib.sh; literal text in fake scripts
# Tests for night mode (A157): `agent.sh batch-plan|batch-cover|batch-next|batch-status|batch-ci|batch-awake|batch-park`.
# There is no driver and no headless session any more: the lead runs the tasks in its own session, one after the other. These tests play the
# lead with a FAKE run and a FAKE deliver (drive below): they act on what `batch-next` says and write the records a real run and a real
# delivery leave (RUN.yaml, questions, deliver/<ID>/PR, merged.tsv). No real claude, gh or network: `gh` is a fake on PATH, "origin" is a bare
# repository on disk.
#
# ASSUMPTIONS about the interface:
#  1. Task files are .agents/tasks/<ID>.md (and todo/, done/, backlog/ below it). The task ID is the file name without .md.
#     Format (task-author TEMPLATES): line 1 `# Task: <ID> — <title>`, optional flat front matter right after it
#     (`---`, `depends_on: A-1, B-2` comma/space separated, blank line, `---`), and a `## Suggested class` section whose
#     first word is TRIVIAL|STANDARD|COMPLEX|CRITICAL. `all` = top-level + todo/ files, ID order (backlog/ and done/ excluded).
#  2. `agent.sh batch-plan <ID...|all>` prints the summary, the batch id (first 12 hex of the sha256 of SUMMARY.md) and the
#     QUESTIONS block ("approve batch"); a cycle prints a line containing `dependency cycle: A -> B -> A`, exits non-zero and
#     writes nothing (no SUMMARY.md, no order.tsv, no approval request). SUMMARY.md has a "not in this batch" heading with one
#     line per excluded task (task ID and the reason: CRITICAL | class unknown | depends on <ID> | dependency <ID> ...).
#  3. order.tsv: `ID<TAB>class<TAB>depends_on` per task in run order; depends_on is the dependency IDs, comma-joined
#     (any placeholder for none). Excluded tasks are not in order.tsv.
#  4. The batch approval is an ordinary `-` approval (.agents/local/approvals/NNN-batch.yaml), recorded by `approve-pending`
#     after the capture "approve batch"; it is valid while its `bound:` equals the sha256 of SUMMARY.md.
#  5. `agent.sh batch-cover <ID> <KIND>` exits non-zero with a one-line reason and writes no file when a check fails; the
#     refusal for kinds outside plan|delivery|mutation_budget contains `not covered by the batch approval`. A covered approval
#     file carries `via_batch:`, `source: "batch"` (quoted or not) and, for mutation_budget, `cap:`.
#  6. `agent.sh batch-next` is read-only and prints the table (task | state | detail | pending question) and one line `NEXT: run|resume|
#     cover|deliver|ci <ID> ...`, `NEXT: finished` or `NEXT: approve`, derived from merged.tsv, the runs, their questions and approvals,
#     ci.tsv and the lead's own parks (state.tsv). States: merged, parked, skipped (a dependency is parked or skipped), waiting (a
#     dependency is still open), open. `--tsv` prints `state<TAB><word>` and one ID/state/detail/question row per task.
#  7. merged.tsv rows: ID<TAB>PR<TAB>epoch. `batch.sh status` prints one line per task containing the ID, the result word, the PR
#     number, the park reason and the first line of the pending question, plus `no friction report` when none exists.
#  8. A run the fake parks exists in the task's worktree .agents/local/worktrees/<ID>/.agents/runs/<ID>/ (RUN.yaml with
#     execution.state and awaiting_input, questions/001.md).
#  9. batch-plan does not require branch main or a clean tree; it writes only under .agents/local/.
# 10. batch-cover finds the batch approval, the run (RUN.yaml pipeline.classification, execution.state) and the pending request
#     as agent.sh does today; a covered `delivery` records one approval per pending step request with the same delivery: hash.
# 11. Fixture config: tests replace the `batch:` block of .agents/config.yaml (mutation_budget_cap, ci_wait_minutes).
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
set -eu
PROOFLINE_TEST=1; export PROOFLINE_TEST
FAKE=$base/fake; mkdir -p "$FAKE/bin" "$FAKE/behave"; export FAKE
PATH=$FAKE/bin:$PATH; export PATH

# fake gh: authenticated, main CI green
cat > "$FAKE/bin/gh" <<'EOF'
#!/bin/sh
# A160: `run list --commit <sha>` answers from $FAKE/ci/<sha> (the JSON) or $FAKE/ci/<sha>.none (no run); any other query is green
sha=''; prev=''; for a in "$@"; do [ "$prev" != --commit ] || sha=$a; prev=$a; done
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha" ]; then cat "$FAKE/ci/$sha"; exit 0; fi
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha.none" ]; then echo '[]'; exit 0; fi
case "$*" in
  *"run list"*) echo '[{"status":"completed","conclusion":"success"}]' ;;
  *"pr view"*"state,isDraft"*) cat "$FAKE/prview" 2>/dev/null || echo "OPEN false aaa b main o" ;;   # the pull request state read by deliver_pr_view
  *"pr view"*) echo 0123456789abcdef0123456789abcdef01234567 ;;   # the merge commit of a PR (A160: the CI of that SHA gates the next task)
  *) : ;;
esac
exit 0
EOF
# A163: fake caffeinate and systemd-inhibit (the real ones are never needed): they record their arguments; caffeinate honours -w PID like the real one
cat > "$FAKE/bin/caffeinate" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/caffeinate.argv"; echo $$ > "$FAKE/caffeinate.pid"
w=''; while [ $# -gt 0 ]; do [ "$1" != -w ] || w=$2; shift; done
[ -n "$w" ] || exit 0
while kill -0 "$w" 2>/dev/null; do sleep 0.2; done
EOF
cat > "$FAKE/bin/systemd-inhibit" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/inhibit.argv"
while :; do case "${1:-}" in --*) shift ;; *) break ;; esac; done
exec "$@"
EOF
chmod +x "$FAKE/bin/gh" "$FAKE/bin/caffeinate" "$FAKE/bin/systemd-inhibit"
mkdir -p "$FAKE/ci"; MSHA=0123456789abcdef0123456789abcdef01234567   # the merge commit the fake gh reports for every PR

# --- fixture helpers ------------------------------------------------------------------------------------------
# mktask ID CLASS|none [DEPS] [DIR]: a markdown task file under .agents/tasks[/DIR]
mktask() {
  mt_d=.agents/tasks; [ -z "${4:-}" ] || mt_d=.agents/tasks/$4; mkdir -p "$mt_d"
  { printf '# Task: %s — title of %s\n' "$1" "$1"
    if [ -n "${3:-}" ]; then printf '\n---\ndepends_on: %s\n\n---\n' "$3"; fi
    printf '\n## Goal\n\nIt works.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n'   # a complete task: the real `agent.sh start --task-file` imports it (A169)
    if [ "$2" != none ]; then printf '\n## Suggested class\n\n%s\n' "$2"; fi; } > "$mt_d/$1.md"
}
# binstall [remote:yes|no]: the batch scripts in .agents/scripts, committed, a local bare origin (never a network)
install_scripts() { # DIR: the control-plane scripts a fixture lacks (batch.sh, dispatch.sh, friction.sh, ...), not the stubs
  for is_s in "$tl_agents"/scripts/*.sh; do
    case "$(basename "$is_s")" in *-test.sh|test-lib.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac
    cp "$is_s" "$1/"
  done
  mkdir -p "$1/../task-integrations"; cp "$tl_agents/task-integrations/markdown.sh" "$tl_agents/task-integrations/_lib.sh" "$1/../task-integrations/"   # A169: sessions run the real `agent.sh start`
}
# bnew: a fresh fixture without task files (the shared template may carry some, see tpl_tasks)
bnew() { new_repo; rm -rf .agents/tasks; }
# tpl_tasks: scaffold() commits the baseline itself, and a later commit would make the frozen plan stale: the task files and
# the batch scripts go into the shared template first, so they are part of the baseline (bnew removes them again).
tpl_tasks() { # a PRIVATE copy of the shared template (never write into the shared cache), used by new_repo from here on
  tl_ensure_template; tpl_p=$(mktemp -d "$base/tpl.XXXXXX"); cp -R "$tl_template/." "$tpl_p/"; tl_template=$tpl_p
  install_scripts "$tl_template/.agents/scripts"; ( cd "$tl_template" && mktask LC COMPLEX && mktask CR CRITICAL ); }
binstall() {
  install_scripts .agents/scripts
  : > "$FAKE/calls.log"; : > "$FAKE/cwd.log"; rm -f "$FAKE"/behave/*
  mkdir -p .github/workflows; printf 'name: ci\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' > .github/workflows/ci.yml   # job A: batch-plan/run want a CI workflow
  git add -A; git commit -qm 'fixture' --allow-empty
  if [ "${1:-yes}" = yes ]; then
    bi_o=$(mktemp -d "$base/origin.XXXXXX"); git init -q --bare "$bi_o"; git remote add origin "$bi_o"; git push -q -u origin main 2>/dev/null
  fi
}
# cfg_batch CAP: replace the batch: block of the fixture config
cfg_batch() {
  awk '/^batch:/ { skip=1; next } skip && /^[^[:space:]#]/ { skip=0 } !skip { print }' .agents/config.yaml > .agents/config.tmp
  printf 'batch:\n  mutation_budget_cap: %s\n  ci_wait_minutes: 1\n' "$1" >> .agents/config.tmp; mv .agents/config.tmp .agents/config.yaml
}
# cfg_extra LINE...: more keys inside the batch: block (after cfg_batch)
cfg_extra() { for ce_l in "$@"; do awk -v l="$ce_l" '{ print } /^batch:/ { print l }' .agents/config.yaml > .agents/config.tmp; mv .agents/config.tmp .agents/config.yaml; done; }
BP() { A batch-plan "$@"; }
BB() { sh ./.agents/scripts/batch.sh "$@"; }
# A capture is single-use per (session, time, text) and `time` has a one-second grain: two approvals of the same words in one second (a fast
# machine, a re-plan right after an approval) would be refused as a replay. Each call therefore gets a capture time one second later than the last.
BAPP_N=0
batch_approve() { BAPP_N=$((BAPP_N + 1)); capture 'approve batch' $(( $(date +%s) + 3600 + BAPP_N )); A approve-pending >/dev/null; }
summary=.agents/local/batch/SUMMARY.md
calls() { cat "$FAKE/calls.log" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }
order_ids() { cut -f1 .agents/local/batch/order.tsv | tr '\n' ' ' | sed 's/ *$//'; }
# nfiles DIR GLOB: how many files match (a refused command must write none)
nfiles() { case "$2" in -*) nf_p="^[0-9][0-9][0-9]$2" ;; *) nf_p=$2 ;; esac; ls -1 "$1" 2>/dev/null | grep -c -e "$nf_p" || :; }


# --- the lead, played by the test ----------------------------------------------------------------------------------
# Behaviour per task in $FAKE/behave/<ID> (default merge): merge (the run reaches CODE_DONE, the delivery merges), question (the run asks a
# question and waits), await (the delivery leaves an open pull request), fail (the run is FAILED).
beh_of() { b=$(head -1 "$FAKE/behave/$1" 2>/dev/null); printf '%s\n' "${b:-merge}"; }
wtp() { printf '%s/.agents/local/worktrees/%s\n' "$(pwd -P)" "$1"; }
set_handoff() { # ID STATE: the handoff state in the run's own RUN.yaml
  sh_f=$(wtp "$1")/.agents/runs/$1/RUN.yaml
  awk -v s="$2" '/^handoff:/ { h = 1; print; next } h && /^[^ ]/ { h = 0 } h && /^  state:/ { print "  state: " s; next } { print }' "$sh_f" > "$sh_f.tmp" && mv "$sh_f.tmp" "$sh_f"
}
ask_question() { # ID: the run waits for the user
  aq_d=$(wtp "$1")/.agents/runs/$1; mkdir -p "$aq_d/questions"
  sed 's/^  awaiting_input: false/  awaiting_input: true/' "$aq_d/RUN.yaml" > "$aq_d/RUN.tmp" && mv "$aq_d/RUN.tmp" "$aq_d/RUN.yaml"
  printf 'from: lead\nasked_at: %s\n---\n1. Which cache do we use for %s?\n   options: a | b\n' "$(date +%s)" "$1" > "$aq_d/questions/001.md"
}
fake_run() { # ID: "NEXT: run ID": a worktree, the real `agent.sh start` in it, then what the run ends up as
  echo "run $1" >> "$FAKE/calls.log"
  fr_wt=$(A worktree-add "$1") || die "worktree-add $1: $fr_wt"
  ( cd "$fr_wt" && sh .agents/scripts/agent.sh start "$1" --task-file ".agents/tasks/$1.md" >/dev/null 2>"$FAKE/start.err" < /dev/null ) || die "start $1 failed in its worktree: $(tail -1 "$FAKE/start.err")"
  case "$(beh_of "$1")" in
    question) ask_question "$1" ;;
    fail) sed 's/^  state: PLANNING/  state: FAILED/' "$fr_wt/.agents/runs/$1/RUN.yaml" > "$fr_wt/.agents/runs/$1/RUN.tmp" && mv "$fr_wt/.agents/runs/$1/RUN.tmp" "$fr_wt/.agents/runs/$1/RUN.yaml" ;;
    *) set_handoff "$1" CODE_DONE ;;
  esac
}
fake_resume() { echo "resume $1" >> "$FAKE/calls.log"; case "$(beh_of "$1")" in question|fail) ;; *) set_handoff "$1" CODE_DONE ;; esac; }
fake_deliver() { # ID: "NEXT: deliver ID"
  echo "deliver $1" >> "$FAKE/calls.log"; fd_wt=$(wtp "$1")
  case "$(beh_of "$1")" in
    await) mkdir -p "$fd_wt/.agents/local/deliver/$1"; echo 77 > "$fd_wt/.agents/local/deliver/$1/PR" ;;
    *) rm -rf "$fd_wt/.agents/runs/$1"
       printf '%s\t%s\t%s\n' "$1" "$((100 + $(printf '%s' "$1" | tr -dc 0-9)))" "$(date +%s)" >> .agents/local/batch/merged.tsv
       A worktree-remove "$1" >/dev/null || die "worktree-remove $1" ;;
  esac
}
nextline() { A batch-next | sed -n 's/^NEXT: //p' | head -1; }
# drive [N]: act on "NEXT:" until finished, or N actions (an interruption)
drive() {
  dr_max=${1:-0}; dr_n=0
  while :; do
    nl=$(nextline); set -- $nl
    case "${1:-}" in
      finished) return 0 ;;
      run) fake_run "$2" ;;
      resume) fake_resume "$2" ;;
      deliver) fake_deliver "$2" ;;
      ci) A batch-ci "$2" >/dev/null || die "batch-ci $2 failed" ;;
      *) die "unexpected NEXT: '$nl'" ;;
    esac
    dr_n=$((dr_n + 1)); [ "$dr_n" -lt 60 ] || die "drive does not end"
    [ "$dr_max" -eq 0 ] || [ "$dr_n" -lt "$dr_max" ] || return 0
  done
}
# --- A202: priority orders the tasks that are free to run; an Allowed scope is asked in the pre-flight -----------------------------------------
# mkprio ID PRIORITY [DEPS]: a task with front matter priority (and depends_on)
mkprio() {
  mktask "$1" STANDARD; mp_f=.agents/tasks/$1.md
  { sed -n 1p "$mp_f"; printf '\n---\npriority: %s\n' "$2"; [ -z "${3:-}" ] || printf 'depends_on: %s\n' "$3"; printf '\n---\n'; sed '1d' "$mp_f"; } > "$mp_f.new"; mv "$mp_f.new" "$mp_f"
}
sc_priority_and_allowed() {
  bnew; mktask T-1 STANDARD; mkprio T-2 low; mkprio T-3 high; mkprio T-4 high T-2; mkprio T-5 medium; binstall no
  BP T-1 T-2 T-3 T-4 T-5 > "$base/plan.out" || die "batch-plan refused a priority batch: $(cat "$base/plan.out")"
  [ "$(order_ids)" = "T-3 T-1 T-5 T-2 T-4" ] || die "priority order: high first, ties in the listed order, a dependency before its dependant (T-4 is high but waits for T-2): $(order_ids)"
  BP T-2 T-1 > "$base/plan.out" || die "batch-plan"
  [ "$(order_ids)" = "T-1 T-2" ] || die "a plain task goes before a low one: $(order_ids)"
  mktask T-1 STANDARD; BP T-1 T-2 >/dev/null; [ "$(order_ids)" = "T-1 T-2" ] || die "tasks without priority keep the listed order: $(order_ids)"
  # Allowed scope: a path the task names outside it is a pre-flight question; the answer "park" parks the task, the other task goes on
  { printf '# Task: S-1 — scoped\n\n## Goal\n\nIt works.\n\n## Context\n\nChanges `src/a.js` and `lib/x.js`.\n\n## Acceptance criteria\n\n- AC-1: the output lists three rows\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nSTANDARD because it is small.\n\n## Allowed scope\n\n- `src/`\n\n## Forbidden scope\n\n- `lib/y.js`\n'; } > .agents/tasks/S-1.md
  mktask S-2 STANDARD; git add -A; git commit -qm tasks
  BP S-1 S-2 > "$base/plan.out" || die "batch-plan: $(cat "$base/plan.out")"
  grep -q '\[S-1, scope\].*lib/x.js' "$summary" || die "no Allowed scope question naming lib/x.js: $(grep -n 'Q[0-9]' "$summary")"
  grep '\[S-1, scope\]' "$summary" | grep -q 'src/a.js' && die "a path inside the Allowed scope was asked about: $(grep 'S-1, scope' "$summary")"
  grep '\[S-1, scope\]' "$summary" | grep -q 'lib/y.js' && die "the Forbidden scope path was asked about instead of refused at freeze"
  batch_approve
  mkdir -p .agents/local/prompts/history; now=$(( $(date +%s) + 10 ))
  printf 'Q1 a\n' > .agents/local/prompts/history/$now-dddd1111.txt
  A batch-answer >/dev/null || die "batch-answer"
  A batch-next | grep -q '^S-1 | parked | allowed scope' || die "an Allowed scope answer 'park' did not park the task: $(A batch-next)"
  A batch-next | grep -q '^NEXT: run S-2' || die "the other task does not go on: $(A batch-next | tail -2)"
  ok "A202 batch: priority orders free tasks (ties keep the listed order, dependencies first); an Allowed scope violation is a pre-flight question and a park answer parks"
}

# --- 1. depends_on order and cycle rejection ---------------------------------------------------------------------------
sc_order_and_cycle() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX T-1; mktask T-5 COMPLEX T-9
  mktask T-7 COMPLEX '' todo; mktask T-8 COMPLEX '' backlog; mktask T-9 COMPLEX '' 'done'
  binstall no
  BP T-3 T-1 T-2 > "$base/plan.out" || die "batch-plan refused a valid batch: $(cat "$base/plan.out")"
  [ "$(order_ids)" = "T-1 T-3 T-2" ] || die "order of 'T-3 T-1 T-2' with T-3 depending on T-1 is: $(order_ids)"
  [ "$(awk -F'\t' '$1 == "T-3" { print $2 }' .agents/local/batch/order.tsv)" = COMPLEX ] || die "order.tsv class column: $(cat .agents/local/batch/order.tsv)"
  awk -F'\t' '$1 == "T-3" { print $3 }' .agents/local/batch/order.tsv | grep -q 'T-1' || die "order.tsv depends_on column: $(cat .agents/local/batch/order.tsv)"
  grep -q "$(tsha "$summary" | cut -c1-12)" "$base/plan.out" || die "the batch id (12 hex of the summary hash) is not printed"
  grep -q 'approve batch' "$base/plan.out" || die "the question does not name 'approve batch'"
  [ -n "$(ls .agents/local/approvals/*-request-batch.yaml 2>/dev/null)" ] || die "no batch approval request was created"
  # a dependency in done/ is satisfied; a todo/ task is in `all`; backlog/ and done/ are not; a dependency nobody has is excluded
  BP all > "$base/all.out" || die "batch-plan all refused: $(cat "$base/all.out")"
  [ "$(order_ids)" = "T-1 T-2 T-3 T-5 T-7" ] || die "all = top-level + todo, ID order, T-5 depends on done/T-9: $(order_ids)"
  mktask T-6 COMPLEX T-99
  BP all > "$base/all.out" || die "batch-plan all refused: $(cat "$base/all.out")"
  order_ids | grep -q 'T-6' && die "a task with an unknown dependency is in the batch"
  grep -q 'T-6' "$summary" || die "the excluded T-6 is not named in the summary"
  # cycle: refuse the whole batch, print it, write nothing, request nothing
  rm -rf .agents/local/batch .agents/local/approvals; rm -f .agents/tasks/T-6.md
  mktask T-1 COMPLEX T-2; mktask T-2 COMPLEX T-3; mktask T-3 COMPLEX T-1
  if BP T-1 T-2 T-3 T-5 > "$base/cyc.out" 2>&1; then die "a dependency cycle was accepted"; fi
  grep -Eq 'dependency cycle: (T-1 -> T-2 -> T-3 -> T-1|T-2 -> T-3 -> T-1 -> T-2|T-3 -> T-1 -> T-2 -> T-3)' "$base/cyc.out" || die "cycle not printed as 'dependency cycle: A -> B -> A': $(cat "$base/cyc.out")"
  [ ! -e "$summary" ] && [ ! -e .agents/local/batch/order.tsv ] || die "a refused batch wrote a summary or an order"
  [ "$(nfiles .agents/local/approvals request-batch)" = 0 ] || die "a refused batch requested an approval"
  ok "batch-plan: topological order (ties in the listed order), all = top-level + todo, done/ dependencies satisfied, cycle refuses and writes nothing"
}


# --- 2. a batch without the approval does not start; the approval is bound to the summary hash --------------------------
sc_no_approval_no_start() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  [ "$(A batch-next)" = 'no batch planned (agent.sh batch-plan <ID...|all>)' ] || die "batch-next without a plan: $(A batch-next)"
  BP all >/dev/null || die "batch-plan failed"
  A batch-next | grep -q '^NEXT: approve$' || die "batch-next before the user approved: $(A batch-next)"
  [ "$(A batch-next --tsv | sed -n 1p)" = "$(printf 'state\tunapproved')" ] || die "state before the approval: $(A batch-next --tsv)"
  grep -q 'Keep the computer awake' "$summary" && grep -q 'caffeinate -i -w' "$summary" && grep -q 'session open' "$summary" || die "the summary does not say the computer must stay awake and the session open: $(cat "$summary")"
  grep -qi 'headless\|driver\|sandbox' "$summary" && die "the summary still names the removed driver: $(grep -i 'headless\|driver\|sandbox' "$summary")"
  expect_msg "batch-check before the user approved" "no valid batch approval" A batch-check
  capture 'sounds good'; A approve-pending >/dev/null
  expect_msg "batch-check after a reply that is not the approval" "no valid batch approval" A batch-check
  batch_approve
  [ "$(nfiles .agents/local/approvals -batch.yaml)" = 1 ] || die "the reply 'approve batch' recorded no batch approval"
  A batch-next | grep -q '^NEXT: run T-1' || die "batch-next after the approval: $(A batch-next)"
  # bound to the summary hash: a changed SUMMARY.md invalidates it
  cp "$summary" "$base/summary.keep"; printf 'extra line\n' >> "$summary"
  expect_msg "batch-check with an edited summary" "no valid batch approval" A batch-check
  A batch-next | grep -q '^NEXT: approve$' || die "an edited summary is still approved: $(A batch-next)"
  cp "$base/summary.keep" "$summary"
  # a new plan has a fresh nonce: the old approval does not carry over
  old=$(tsha "$summary"); BP --replace all >/dev/null; [ "$(tsha "$summary")" != "$old" ] || die "a new plan reused the old summary (no fresh nonce)"
  expect_msg "batch-check after a re-plan" "no valid batch approval" A batch-check
  [ -z "$(calls)" ] || die "a task was started without the approval: $(calls)"
  ok "batch: nothing is next before the approval (or with an edited or re-planned summary); the approval is bound to the SUMMARY.md hash; the summary says to keep the computer awake and the session open"
}

# --- 5. two tasks, one after the other: run, deliver, and only then the next -----------------------------------------------------
sc_sequential() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX T-1; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  [ "$(nextline)" = 'run T-1   (agent.sh worktree-add T-1, then /proofline run T-1 with .agents/local/worktrees/T-1 as the working folder)' ] || die "first action: $(nextline)"
  fake_run T-1
  [ "$(nextline | cut -d' ' -f1-2)" = 'deliver T-1' ] || die "after the run of T-1 the next action is not its delivery: $(nextline)"
  A batch-next | grep -q '^T-2 | waiting | depends on T-1 (not merged yet)' || die "T-2 does not wait for the merge of T-1: $(A batch-next)"
  fake_deliver T-1
  [ "$(nextline | cut -d' ' -f1-2)" = 'ci T-1' ] || die "after the merge the CI of the merge commit comes first: $(nextline)"
  A batch-ci T-1 > "$base/ci.out" || die "batch-ci: $(cat "$base/ci.out")"
  [ "$(nextline | cut -d' ' -f1-2)" = 'run T-2' ] || die "after the merge and the CI of T-1 the next task is T-2: $(nextline)"
  drive
  [ "$(calls)" = 'run T-1 deliver T-1 run T-2 deliver T-2' ] || die "the tasks did not run one after the other (run, deliver, next): '$(calls)'"
  [ "$(A batch-next --tsv | sed -n 1p)" = "$(printf 'state\tfinished-clean')" ] || die "state at the end: $(A batch-next --tsv)"
  [ "$(cut -f1 .agents/local/batch/merged.tsv | tr '\n' ' ')" = 'T-1 T-2 ' ] || die "merged.tsv: $(cat .agents/local/batch/merged.tsv)"
  [ ! -d .agents/local/worktrees/T-1 ] && [ ! -d .agents/local/worktrees/T-2 ] || die "a merged task kept its worktree"
  ok "batch: with a fake deliver two tasks finish one after the other (run, deliver, CI check, then the next); a dependent waits for the merge"
}

# --- 5a. a parked task skips its dependent, an independent task goes on; every task has a worktree of its own (A169) ----------------
# T-1 parks with a question, T-4 waits for its merge, T-3 is independent and merges, T-2 depends on T-1. The runs use the REAL
# `agent.sh start`: with all runs in one folder T-3 would fail with "another open run exists in this worktree".
sc_park_skip_continue() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX T-1; mktask T-3 COMPLEX; mktask T-4 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'question\n' > "$FAKE/behave/T-1"; printf 'await\n' > "$FAKE/behave/T-4"
  main=$(pwd -P)
  drive
  [ "$(calls)" = 'run T-1 run T-3 deliver T-3 run T-4 deliver T-4' ] || die "a parked task and one waiting for merge must not block the independent T-3, and the dependent T-2 must not start: '$(calls)'"
  tsv=$(A batch-next --tsv)
  for w in "T-1 parked question" "T-2 skipped depends on T-1 (parked)" "T-3 merged" "T-4 parked awaiting merge"; do
    printf '%s\n' "$tsv" | tr '\t' ' ' | grep -q "^$w" || die "batch-next --tsv lacks '$w': $tsv"
  done
  printf '%s\n' "$tsv" | grep -q 'Which cache' || die "the pending question is not in the digest: $tsv"
  [ "$(printf '%s\n' "$tsv" | sed -n 1p)" = "$(printf 'state\tfinished-parked')" ] || die "state: $tsv"
  # the main working tree: clean, the task files where they were, no run, no open run
  [ -z "$(git status --porcelain)" ] || die "the main working tree is dirty: $(git status --porcelain)"
  [ -f .agents/tasks/T-1.md ] && [ -f .agents/tasks/T-4.md ] && [ ! -e .agents/tasks/in-progress ] || die "a task file moved in the main working tree: $(ls -R .agents/tasks)"
  [ -z "$(ls .agents/runs 2>/dev/null)" ] && [ -z "$(A open-runs)" ] && [ ! -s .agents/local/ACTIVE_RUN ] || die "the main working tree holds a run: $(ls .agents/runs) / $(A open-runs)"
  [ "$(git branch --show-current)" = main ] || die "the batch left main"
  # the parked and the waiting task keep their worktree and their run; the merged one is gone, the skipped one never had one
  [ -d .agents/local/worktrees/T-1/.agents/runs/T-1 ] && [ -d .agents/local/worktrees/T-4/.agents/runs/T-4 ] || die "a parked or waiting task lost its worktree: $(git worktree list)"
  [ ! -d .agents/local/worktrees/T-3 ] && [ ! -e .agents/local/worktrees/T-2 ] || die "worktree of the merged T-3 left, or one made for the never-started T-2: $(git worktree list)"
  [ "$(cd .agents/local/worktrees/T-1 && sh .agents/scripts/agent.sh open-runs)" = 'T-1 -' ] || die "open runs of T-1's worktree"
  A next-user batch status | grep -q 'reply in this session to the open question.*then run /proofline batch$' || die "next step for a parked task whose run is in a worktree: $(A next-user batch status)"
  A questions T-1 | grep -q 'Which cache' || die "questions for a run in a worktree are not forwarded from the main tree: $(A questions T-1 2>&1)"
  # the dependent waits for the merge: T-1 gets its answer and merges in the SAME worktree, then T-2 runs, not before
  printf 'a\n' > .agents/local/worktrees/T-1/.agents/runs/T-1/questions/001.answer.md
  printf 'merge\n' > "$FAKE/behave/T-1"; : > "$FAKE/calls.log"
  A batch-next | grep -q '^NEXT: resume T-1' || die "after the answer the parked T-1 is resumed: $(A batch-next)"
  drive
  [ "$(calls)" = 'resume T-1 deliver T-1 run T-2 deliver T-2' ] || die "second pass: T-1 resumes and merges, only then T-2 starts, T-3 is not run again: '$(calls)'"
  [ ! -d .agents/local/worktrees/T-1 ] && [ ! -d .agents/local/worktrees/T-2 ] || die "worktrees of merged tasks left"
  [ -d .agents/local/worktrees/T-4 ] || die "the worktree of the task awaiting its merge was removed"
  ok "batch: T-1 parked, T-2 skipped (depends on T-1), T-3 merged on its own, T-4 awaits its merge; worktrees per task, main tree clean; the answered T-1 resumes in its worktree and only then T-2 runs"
}

# --- 5c. an interruption: the same approved batch continues where it stopped and never runs a merged task again -------------------
sc_restart() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  h1=$(tsha "$summary")
  drive 4   # run T-1, deliver T-1, CI T-1, run T-2: the session ends here (closed, limit, sleep)
  [ "$(calls)" = 'run T-1 deliver T-1 run T-2' ] || die "before the interruption: '$(calls)'"
  # a new session: the digest alone says where to go on
  [ "$(nextline | cut -d' ' -f1-2)" = 'deliver T-2' ] || die "after the interruption the half-done T-2 is delivered, not run again: $(nextline)"
  BP T-1 T-2 T-3 > "$base/again.out" || die "the same batch could not be continued: $(cat "$base/again.out")"
  grep -q 'is approved and not finished: continuing it' "$base/again.out" && grep -q '^NEXT: deliver T-2' "$base/again.out" || die "batch-plan of the same batch did not continue it: $(cat "$base/again.out")"
  [ "$(tsha "$summary")" = "$h1" ] && [ "$(nfiles .agents/local/approvals request-batch)" = 1 ] || die "continuing the batch wrote a new summary or asked a new approval"
  drive
  [ "$(calls)" = 'run T-1 deliver T-1 run T-2 deliver T-2 run T-3 deliver T-3' ] || die "after the restart: '$(calls)'"
  [ "$(grep -c '^run T-1' "$FAKE/calls.log")" = 1 ] && [ "$(grep -c '^deliver T-1' "$FAKE/calls.log")" = 1 ] || die "a merged task was run again: $(calls)"
  # finished: the same words plan a new batch (the old one goes to history)
  BP T-1 T-2 T-3 > "$base/new.out" || die "re-plan after the end: $(cat "$base/new.out")"
  [ "$(tsha "$summary")" != "$h1" ] && [ -d .agents/local/batch/history ] && [ ! -s .agents/local/batch/merged.tsv ] || die "a finished batch was not archived by the next plan"
  ok "batch: after an interruption the approved batch continues (no new plan, no new approval), a half-done task is delivered not run again, merged tasks never run twice; a finished batch is archived by the next plan"
}

# --- 6. the morning report comes from the records only -----------------------------------------------------------------------
sc_status_from_records() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX T-2; mktask T-4 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'question\n' > "$FAKE/behave/T-2"
  A batch-park T-4 reason-xyz-from-the-lead >/dev/null || die "batch-park"
  drive
  [ "$(calls)" = 'run T-1 deliver T-1 run T-2' ] || die "the lead's own park of T-4 did not keep it out: '$(calls)'"
  BB status > "$base/st1.out" || die "batch.sh status failed"
  row() { grep "$2" "$1" | head -1; }
  row "$base/st1.out" T-1 | grep -q 'merged' && row "$base/st1.out" T-1 | grep -q '101' || die "T-1 row: $(cat "$base/st1.out")"
  row "$base/st1.out" T-2 | grep -q 'PARKED' && row "$base/st1.out" T-2 | grep -q 'Which cache' || die "T-2 row: $(cat "$base/st1.out")"
  row "$base/st1.out" T-3 | grep -q 'skipped' || die "T-3 row: $(cat "$base/st1.out")"
  grep -qi 'no friction report' "$base/st1.out" || die "no 'no friction report' line"
  grep -qi 'driver' "$base/st1.out" && die "status still has a driver line: $(grep -i driver "$base/st1.out")"
  A batch-status > "$base/st1b.out" || die "agent.sh batch-status failed"
  grep -q 'T-1' "$base/st1b.out" && grep -q 'Which cache' "$base/st1b.out" || die "batch-status table: $(cat "$base/st1b.out")"
  # change the records: the table changes
  awk -F'\t' -v OFS='\t' '$1 == "T-1" { $2 = 777 } { print }' .agents/local/batch/merged.tsv > "$base/m.tsv"
  cp "$base/m.tsv" .agents/local/batch/merged.tsv
  BB status > "$base/st2.out"; row "$base/st2.out" T-1 | grep -q '777' && ! row "$base/st2.out" T-1 | grep -q '101' || die "merged.tsv edit not reflected: $(row "$base/st2.out" T-1)"
  BB status > "$base/st3.out"; row "$base/st3.out" T-4 | grep -q 'PARKED' && row "$base/st3.out" T-4 | grep -q 'reason-xyz-from-the-lead' || die "state.tsv park not reflected: $(row "$base/st3.out" T-4)"
  A batch-park T-4 --clear >/dev/null; BB status | grep T-4 | grep -q 'pending' || die "a cleared park is still shown"
  printf '1\n' > .agents/local/worktrees/T-2/.agents/runs/T-2/questions/001.answer.md   # the user answered (the parked run lives in its task's worktree, A169): the pending question is gone
  BB status > "$base/st4.out"; row "$base/st4.out" T-2 | grep -q 'Which cache' && die "an answered question is still shown as pending"
  row "$base/st4.out" T-2 | grep -q 'pending' || die "an answered task is not pending again: $(row "$base/st4.out" T-2)"
  # batch-next reads and never writes
  before=$(find .agents/local/batch -type f ! -name owner | sort | xargs cat | tsha /dev/stdin 2>/dev/null || find .agents/local/batch -type f ! -name owner | sort)
  A batch-next >/dev/null; A batch-next --tsv >/dev/null
  after=$(find .agents/local/batch -type f ! -name owner | sort | xargs cat | tsha /dev/stdin 2>/dev/null || find .agents/local/batch -type f ! -name owner | sort)
  [ "$before" = "$after" ] || die "batch-next wrote something besides the owner claim"
  ok "batch status and batch-next: generated from merged.tsv, the runs' records and the lead's parks; edits to the records change the table; an answered question un-parks; batch-next changes nothing but the owner claim"
}

# --- 10. (A160) the CI that gates the next task is the one of the merge commit ---------------------------------------------------
sc_merge_commit_ci() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; cfg_batch 40; cfg_extra '  ci_appear_minutes: 1'; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve; rm -f "$FAKE/ci"/*
  drive 2   # run T-1, deliver T-1
  git remote set-url origin https://github.com/acme/app.git   # a GitHub project: the CI of a merge commit is read through gh
  ci() { A batch-ci T-1 > "$base/ci.out" 2>&1; ci_rc=$?; }
  # an old green run exists (the fake answers green to any query that is not about the merge commit); the merge commit's run is red
  printf '[{"status":"completed","conclusion":"failure"}]\n' > "$FAKE/ci/$MSHA"; ci_rc=0; ci || :
  [ "$ci_rc" = 1 ] && grep -q 'RED (run of 0123456)' "$base/ci.out" || die "a red run of the merge commit: rc $ci_rc, $(cat "$base/ci.out")"
  [ "$(nextline | cut -d' ' -f1-2)" = 'ci T-1' ] || die "a red CI must keep the batch at the CI check: $(nextline)"
  # a running run next to a red one is red; a running one alone is not green
  printf '[{"status":"in_progress","conclusion":""},{"status":"completed","conclusion":"failure"}]\n' > "$FAKE/ci/$MSHA"; ci_rc=0; ci || :
  [ "$ci_rc" = 1 ] || die "red + running: rc $ci_rc"
  printf '[{"status":"in_progress","conclusion":""}]\n' > "$FAKE/ci/$MSHA"; ci_rc=0; ci || :
  [ "$ci_rc" = 2 ] || die "a running run: rc $ci_rc, $(cat "$base/ci.out")"
  # no run for the merge commit
  rm -f "$FAKE/ci/$MSHA"; : > "$FAKE/ci/$MSHA.none"; ci_rc=0; ci || :
  [ "$ci_rc" = 4 ] && grep -q 'no run for 0123456 yet' "$base/ci.out" || die "no run: rc $ci_rc, $(cat "$base/ci.out")"
  [ "$(nextline | cut -d' ' -f1-2)" = 'ci T-1' ] || die "no CI run yet must keep the batch at the CI check: $(nextline)"
  # a green run of the merge commit lets the batch go on
  rm -f "$FAKE/ci/$MSHA.none"; printf '[{"status":"completed","conclusion":"success"}]\n' > "$FAKE/ci/$MSHA"; ci_rc=0; ci || :
  [ "$ci_rc" = 0 ] && grep -q 'green' "$base/ci.out" || die "green: rc $ci_rc, $(cat "$base/ci.out")"
  [ "$(nextline | cut -d' ' -f1-2)" = 'run T-2' ] || die "after a green CI the next task is T-2: $(nextline)"
  ok "merge-commit CI: red run of the SHA (an old green main run does not count) and no run yet keep the batch at the check, a running one is 'ask again', green continues"
}

# --- 11. the sleep inhibitor belongs to the session, not to a driver -------------------------------------------------------------
sc_awake() {
  bnew; mktask T-1 COMPLEX; binstall no
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  rm -f "$FAKE/caffeinate.argv" "$FAKE/inhibit.argv"
  sleep 60 & sess=$!   # the "session" process
  PROOFLINE_SESSION_PID=$sess PROOFLINE_UNAME=Darwin A batch-awake > "$base/aw.out" 2>&1 || { kill "$sess"; die "batch-awake on macOS: $(cat "$base/aw.out")"; }
  grep -q "caffeinate -i -w $sess" "$base/aw.out" && grep -q 'Keep the computer awake' "$base/aw.out" || { kill "$sess"; die "batch-awake output: $(cat "$base/aw.out")"; }
  until_ok() { u_i=0; while ! eval "$1" >/dev/null 2>&1; do u_i=$((u_i + 1)); [ "$u_i" -lt 50 ] || return 1; sleep 0.1; done; }
  until_ok "[ -s '$FAKE/caffeinate.argv' ]" || { kill "$sess"; die "caffeinate was not started"; }
  [ "$(cat "$FAKE/caffeinate.argv")" = "-i -w $sess" ] || { kill "$sess"; die "caffeinate arguments: $(cat "$FAKE/caffeinate.argv")"; }
  PROOFLINE_SESSION_PID=$sess PROOFLINE_UNAME=Darwin A batch-awake >/dev/null 2>&1; [ "$(wc -l < "$FAKE/caffeinate.argv" | tr -d ' ')" = 1 ] || { kill "$sess"; die "a second batch-awake started a second inhibitor"; }
  BB status | grep -q "^sleep inhibitor: caffeinate -i -w $sess" || { kill "$sess"; die "status does not show the inhibitor: $(BB status | head -4)"; }
  cpid=$(cat "$FAKE/caffeinate.pid"); kill -0 "$cpid" 2>/dev/null || { kill "$sess"; die "caffeinate is not running"; }
  kill "$sess"; wait "$sess" 2>/dev/null || :
  until_ok "! kill -0 $cpid" || die "caffeinate outlived the session it is tied to"
  BB status | grep -q '^awake: the sleep inhibitor ended' || die "status after the session ended: $(BB status | head -4)"
  sleep 60 & sess=$!
  PROOFLINE_SESSION_PID=$sess PROOFLINE_UNAME=Linux A batch-awake > "$base/aw2.out" 2>&1 || { kill "$sess"; die "batch-awake on Linux: $(cat "$base/aw2.out")"; }
  until_ok "[ -s '$FAKE/inhibit.argv' ]" || { kill "$sess"; die "systemd-inhibit was not started"; }
  grep -q -- '--what=idle:sleep' "$FAKE/inhibit.argv" || { kill "$sess"; die "systemd-inhibit arguments: $(cat "$FAKE/inhibit.argv")"; }
  kill "$sess"; wait "$sess" 2>/dev/null || :
  rm -f "$FAKE/caffeinate.argv" "$FAKE/inhibit.argv"
  sleep 60 & sess=$!
  PROOFLINE_SESSION_PID=$sess PROOFLINE_UNAME=Linux PROOFLINE_BATCH_INHIBIT=none A batch-awake > "$base/aw3.out" 2>&1 || { kill "$sess"; die "batch-awake without an inhibitor: $(cat "$base/aw3.out")"; }
  kill "$sess"; wait "$sess" 2>/dev/null || :
  grep -q 'sleep inhibitor: none available.*the machine may sleep' "$base/aw3.out" || die "no-inhibitor output: $(cat "$base/aw3.out")"
  [ ! -s "$FAKE/caffeinate.argv" ] && [ ! -s "$FAKE/inhibit.argv" ] || die "an inhibitor was started although none is available"
  ok "sleep inhibitor: caffeinate -i -w <session pid> (gone with the session), once; systemd-inhibit on Linux; no inhibitor is said plainly; status shows it"
}

# --- 12. the removed headless driver says what to do instead ---------------------------------------------------------------------
sc_driver_removed() {
  bnew; mktask T-1 COMPLEX; binstall no
  for c in run start stop; do
    BB $c > "$base/gone.out" 2>&1 && die "batch.sh $c still exists"
    grep -q 'driver is gone' "$base/gone.out" && grep -q '/proofline batch' "$base/gone.out" || die "batch.sh $c: $(cat "$base/gone.out")"
  done
  expect_msg "the old Codex sandbox flag" "is gone" BP T-1 --codex-danger-full-access
  expect_fail "agent.sh batch-start" A batch-start
  expect_fail "agent.sh batch-stop" A batch-stop
  [ ! -e .agents/local/batch/SUMMARY.md ] || die "a refused plan wrote a summary"
  ok "removed driver: batch.sh run|start|stop, batch-start, batch-stop and --codex-danger-full-access are refused with what to do instead"
}

# --- 3. the batch approval covers plan, delivery, mutation budget only; not waiver, scope, reopen, rule ... ---------------
cover_setup() { # scaffold LC (COMPLEX, supervised, unfrozen) + a planned and approved batch of LC
  tpl_tasks; scaffold standalone no COMPLEX manual
  BP all > "$base/plan.out" || die "batch-plan failed: $(cat "$base/plan.out")"
  batch_approve
}
sc_cover_limits() {
  cover_setup
  ad=.agents/runs/LC/approvals
  A request-approval LC plan >/dev/null
  n0=$(ls "$ad" | wc -l | tr -d ' ')
  for k in waive:F-1 scope reopen:LC budget rule:L-1 destructive single_step report commit push merge cleanup batch; do
    expect_msg "batch-cover $k" "not covered by the batch approval" A batch-cover LC "$k"
  done
  [ "$(ls "$ad" | wc -l | tr -d ' ')" = "$n0" ] || die "a refused batch-cover wrote an approval file"
  expect_fail "batch-cover for a task outside the batch" A batch-cover NOPE plan
  expect_fail "batch-cover without a pending request" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh batch-cover LC plan
  expect_msg "reviewer batch-plan" "command denied" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh batch-plan all
  expect_msg "implementer batch-cover" "command denied" env AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh batch-cover LC plan
  # waiver and scope still need their own approval: the request exists, the batch does not answer it
  A request-approval LC scope >/dev/null
  expect_fail "batch-cover scope" A batch-cover LC scope
  [ "$(nfiles "$ad" -scope.yaml)" = 0 ] || die "scope got an approval from the batch"
  # plan: recorded as the user's approval; freeze accepts it
  expect_fail "freeze before any approval" A freeze LC
  A batch-cover LC plan > "$base/cover.out" || die "batch-cover plan refused: $(cat "$base/cover.out")"
  pf=$(ls "$ad"/*-plan.yaml | tail -1)
  grep -Eq '^via_batch:' "$pf" && grep -Eq '^source:[[:space:]]*"?batch"?' "$pf" && grep -Eq '^consumed:[[:space:]]*"?false"?' "$pf" && grep -Eq '^answered_by:[[:space:]]*"?user"?' "$pf" || die "covered plan approval: $(cat "$pf")"
  A freeze LC >/dev/null || die "freeze did not accept the covered plan approval"
  expect_fail "second cover of a consumed plan request" A batch-cover LC plan
  ok "batch-cover: only plan|delivery|mutation_budget, nothing for waiver/scope/reopen/rule/budget/...; role-restricted; the covered plan approval lets freeze pass"
}

# --- 3b. mutation budget: needed N must be <= the cap; raise-budget enforces the cap on a batch approval ------------------
mb_plan() { # N: PLAN.md ## Tests with N criteria
  { printf '\n## Tests\n\n'; mb_i=1; while [ "$mb_i" -le "$1" ]; do printf -- '- AC-%s: criterion\n' "$mb_i"; mb_i=$((mb_i + 1)); done; } >> .agents/runs/LC/PLAN.md
}
sc_mutation_cap() {
  cover_setup
  ad=.agents/runs/LC/approvals
  mb_plan 45; A request-approval LC mutation_budget >/dev/null
  expect_fail "batch-cover mutation_budget over the cap (45 > 40)" A batch-cover LC mutation_budget
  [ "$(nfiles "$ad" -mutation_budget.yaml)" = 0 ] || die "an over-cap mutation budget was covered"
  expect_fail "raise-budget without an approval" A raise-budget LC 45
  # under the cap: covered, the approval stores the cap, and raise-budget stops at the cap
  tpl_tasks; scaffold standalone no COMPLEX manual
  BP all >/dev/null; batch_approve; ad=.agents/runs/LC/approvals
  mb_plan 35; A request-approval LC mutation_budget >/dev/null
  A batch-cover LC mutation_budget >/dev/null || die "a mutation budget of 35 criteria (cap 40) was refused"
  mf=$(ls "$ad"/*-mutation_budget.yaml | tail -1)
  grep -Eq '^via_batch:' "$mf" && grep -Eq '^cap:[[:space:]]*"?40"?' "$mf" || die "covered budget approval lacks via_batch or cap 40: $(cat "$mf")"
  expect_fail "raise-budget above the cap with a batch approval (41 > 40)" A raise-budget LC 41
  [ "$(cat .agents/runs/LC/mutation_budget 2>/dev/null || echo none)" = none ] || die "the mutation budget was raised above the cap"
  A raise-budget LC 35 >/dev/null || die "raise-budget to 35 (<= cap) with the covered approval was refused"
  [ "$(cat .agents/runs/LC/mutation_budget)" = 35 ] || die "mutation budget not raised to 35"
  ok "mutation cap: over-cap need refused at cover, raise-budget above the cap refused for a batch approval, within the cap works"
}

# --- 3c. delivery: one cover records one approval per pending delivery step --------------------------------------------
sc_cover_delivery() {
  tpl_tasks; SC_BRANCH=1 scaffold orchestrated
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  to_code_done orchestrated
  git remote add origin https://github.com/acme/app.git
  mkdir -p "$base/hooks"; cp "$tl_agents/githooks/pre-commit" "$tl_agents/githooks/human.sh" "$base/hooks/"; chmod +x "$base/hooks/pre-commit"; git config core.hooksPath "$base/hooks"
  finish_done
  A deliver-plan LC > "$base/dp.out" || die "deliver-plan refused: $(cat "$base/dp.out")"
  expect_msg "a step before any approval" "no unconsumed commit approval" A deliver-step LC commit
  A batch-cover LC delivery > "$base/cover.out" || die "batch-cover delivery refused: $(cat "$base/cover.out")"
  for k in commit push pr merge cleanup; do
    f=$(ls .agents/runs/LC/approvals/*-"$k".yaml 2>/dev/null | tail -1); [ -n "$f" ] || die "no $k approval from the delivery cover"
    grep -Eq '^delivery:' "$f" && grep -Eq '^via_batch:' "$f" || die "$k approval lacks delivery: or via_batch: $(cat "$f")"
  done
  A deliver-step LC commit >/dev/null || die "the covered commit approval was not accepted by deliver-step"
  ok "batch-cover delivery: one approval per delivery step, same delivery hash, accepted by deliver-step"
}

# --- 4. CRITICAL (and unknown class) stay out; a late CRITICAL gets batch-cover refused ---------------------------------
sc_critical_excluded() {
  bnew; mktask T-1 COMPLEX; mktask T-2 CRITICAL; mktask T-3 none; mktask T-4 COMPLEX T-2; mktask T-5 COMPLEX T-1; mktask T-6 STANDARD T-3
  binstall no
  BP all > "$base/plan.out" || die "batch-plan failed: $(cat "$base/plan.out")"
  [ "$(order_ids)" = "T-1 T-5" ] || die "CRITICAL / unknown class / dependents of excluded tasks must be left out: $(order_ids)"
  grep -qi 'not in this batch' "$summary" || die "no 'not in this batch' section in the summary"
  grep 'T-2' "$summary" | grep -qi 'critical' || die "summary does not say T-2 is CRITICAL"
  grep 'T-3' "$summary" | grep -qi 'class unknown' || die "summary does not say T-3 is class unknown"
  grep 'T-4' "$summary" | grep -q 'T-2' || die "summary does not say T-4 depends on the excluded T-2"
  grep 'T-6' "$summary" | grep -q 'T-3' || die "summary does not say T-6 depends on the excluded T-3"
  for w in 'waiver' 'scope' 'mutation' '40'; do grep -qi "$w" "$summary" || die "summary does not mention '$w'"; done
  ok "batch-plan: CRITICAL, class-unknown and dependents of excluded tasks are left out, the summary says why and what is not covered"
}
sc_late_critical() {
  cover_setup
  A request-approval LC plan >/dev/null
  sed 's/^  classification: .*/  classification: CRITICAL/' .agents/runs/LC/RUN.yaml > "$base/run.yaml" && cp "$base/run.yaml" .agents/runs/LC/RUN.yaml
  n0=$(ls .agents/runs/LC/approvals | wc -l | tr -d ' ')
  expect_msg "batch-cover for a run classified CRITICAL after the batch started" "CRITICAL" A batch-cover LC plan
  [ "$(ls .agents/runs/LC/approvals | wc -l | tr -d ' ')" = "$n0" ] || die "an approval was written for a CRITICAL run"
  ok "batch-cover: a task classified CRITICAL after the batch started is refused"
}

wbody() { printf '## Goal\n\n%s.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n' "$2"; }   # ID TITLE -> a task body for `agent.sh start --title`
# --- 5a'. A169: agent.sh worktree-add|worktree-path|worktree-remove, the open-run check per worktree --------------------------------
sc_worktree_cmds() {
  bnew; binstall no
  main=$(pwd -P)
  wbody W-1 first | A start W-1 --title first > "$base/st.out" 2>&1 || die "start W-1: $(cat "$base/st.out")"
  expect_msg "a second run in the same worktree names the way out" 'agent.sh worktree-add' A start W-2 --title second
  wt=$(A worktree-add W-2) || die "worktree-add: $wt"
  [ "$wt" = "$main/.agents/local/worktrees/W-2" ] && [ -d "$wt/.agents/scripts" ] || die "worktree-add printed '$wt'"
  [ "$(A worktree-add W-2)" = "$wt" ] || die "a second worktree-add did not reuse the worktree"
  # A200: commands written in the main tree after the user's yes (uncommitted) reach a worktree made from the committed branch, only when they are the sole config difference
  [ -z "$(cd "$wt" && sh .agents/scripts/agent.sh config-get commands.test)" ] || die "the fixture already has commands.test"
  sed 's/^  test:[[:space:]]*$/  test: npm test/' .agents/config.yaml > "$base/cfg.new"; grep -q '^  test: npm test' "$base/cfg.new" || die "fixture config has no empty commands.test line"
  cp .agents/config.yaml "$base/cfg.keep"; cp "$base/cfg.new" .agents/config.yaml
  A worktree-add W-2 >/dev/null; [ "$(cd "$wt" && sh .agents/scripts/agent.sh config-get commands.test)" = 'npm test' ] || die "A200: the worktree did not get the approved commands"
  cp "$base/cfg.keep" .agents/config.yaml; ( cd "$wt" && git checkout -q -- .agents/config.yaml )
  [ "$(A worktree-path W-2)" = "$wt" ] && ! A worktree-path W-9 >/dev/null 2>&1 || die "worktree-path"
  for d in batch approvals metrics friction prompts; do [ ! -L "$wt/.agents/local/$d" ] || die "A185: the worktree has a link to the shared $d folder"; done
  [ -z "$(find "$wt/.agents/local" -type l 2>/dev/null)" ] || die "A185: the worktree holds a symlink: $(find "$wt/.agents/local" -type l)"
  [ -d "$main/.agents/local/approvals" ] || die "A185: the shared folders live in the main tree"
  git check-ignore -q .agents/local/worktrees/W-2 || die "the worktree folder is not git-ignored"
  wbody W-2 second | ( cd "$wt" && sh .agents/scripts/agent.sh start W-2 --title second >/dev/null ) || die "start W-2 in its own worktree"
  [ "$(A open-runs)" = 'W-1 -' ] && [ "$(cd "$wt" && sh .agents/scripts/agent.sh open-runs)" = 'W-2 -' ] || die "open runs are not per worktree: main '$(A open-runs)' worktree '$(cd "$wt" && sh .agents/scripts/agent.sh open-runs)'"
  # the task branch starts from the detached HEAD at the canonical tip; the canonical branch stays in the main working tree
  ( cd "$wt" && sh .agents/scripts/agent.sh classify W-2 TRIVIAL >/dev/null && sh .agents/scripts/agent.sh branch W-2 ) > "$base/br.out" 2>&1 || die "branch from a detached task worktree: $(cat "$base/br.out")"
  case "$(git -C "$wt" branch --show-current)" in proofline/W-2-*) ;; *) die "task branch of W-2: '$(git -C "$wt" branch --show-current)'" ;; esac
  [ "$(git branch --show-current)" = main ] || die "worktree-add moved the main working tree off main"
  ( cd "$wt" && ! sh .agents/scripts/agent.sh worktree-add W-3 >/dev/null 2>&1 ) || die "worktree-add ran inside a task worktree"
  expect_msg "removing a worktree that still holds a run" 'still holds the run' A worktree-remove W-2
  [ -d "$wt" ] || die "the refused removal removed the worktree"
  A worktree-remove W-2 --force >/dev/null || die "forced removal"
  [ ! -e "$wt" ] && [ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] || die "worktree left after removal: $(git worktree list)"
  A worktree-remove W-2 | grep -q 'no worktree' || die "removing a missing worktree is not a no-op"
  ok "worktree-add|path|remove: one worktree per run, open runs counted per worktree, branch from the detached canonical tip, removal refused while a run is inside"
}

# --- A185 items 4-6: dependencies are the worktree's own copy, .env* is copied and never committed, no symlink is needed ------------------
sc_worktree_prep() {
  bnew; binstall no
  main=$(pwd -P)
  printf 'node_modules/\n.env*\n' >> .gitignore; git add .gitignore; git commit -qm ignore
  mkdir -p node_modules/pkg; echo v1 > node_modules/pkg/index.js; printf 'SECRET=1\n' > .env; printf 'X=1\n' > .env.local
  wt=$(A worktree-add W-1) || die "worktree-add: $wt"
  # 4: a dependency change in the worktree leaves the main tree alone
  [ -d "$wt/node_modules/pkg" ] && [ ! -L "$wt/node_modules" ] || die "node_modules is not a real copy in the worktree"
  echo v2 > "$wt/node_modules/pkg/index.js"; echo new > "$wt/node_modules/added.js"; rm -rf "$wt/node_modules/pkg/gone"
  [ "$(cat node_modules/pkg/index.js)" = v1 ] && [ ! -e node_modules/added.js ] || die "a dependency change in the worktree reached the main tree"
  # 5: .env* is copied, listed, and refused by the pre-commit hook even when forced; evidence and status never carry it
  [ "$(cat "$wt/.env")" = SECRET=1 ] && [ -f "$wt/.env.local" ] || die ".env* was not copied into the worktree"
  grep -qxF .env "$wt/.agents/local/worktree-copied" || die "the copied file is not listed: $(cat "$wt/.agents/local/worktree-copied" 2>/dev/null)"
  [ -z "$(git -C "$wt" status --porcelain | grep -F .env)" ] || die "git status shows the copied .env"
  git -C "$wt" add -A; [ -z "$(git -C "$wt" diff --cached --name-only | grep -F .env)" ] || die "git add -A staged the copied .env"
  cp -R "$tl_agents/githooks" "$wt/.agents/githooks" || die "no githooks to copy"
  git -C "$wt" add -f .env
  if git -C "$wt" -c core.hooksPath=.agents/githooks -c user.name=t -c user.email=t@example.invalid commit -qm env >"$base/pc.out" 2>&1; then die "the pre-commit hook let a copied .env into a commit"; fi
  grep -q 'worktree.copy_files' "$base/pc.out" || die "the refusal does not say why: $(cat "$base/pc.out")"
  # a file git does not ignore is reported, never copied
  printf 'C=1\n' > .envrc.keep; sed 's/^\.env\*$/.env/' .gitignore > .gitignore.t && mv .gitignore.t .gitignore
  wt2=$(A worktree-add W-2 2>"$base/w2.err") || die "worktree-add W-2: $wt2"
  [ ! -e "$wt2/.envrc.keep" ] || die "a file git does not ignore was copied"
  # 6: the same with symlink creation blocked
  mkdir -p "$base/lnfail"; printf '#!/bin/sh\necho "ln: symbolic links not allowed" >&2\nexit 1\n' > "$base/lnfail/ln"; chmod +x "$base/lnfail/ln"
  printf 'node_modules/\n.env*\n' > .gitignore
  wt3=$(PATH=$base/lnfail:$PATH A worktree-add W-3 2>"$base/w3.err") || die "worktree-add failed with symlinks blocked: $(cat "$base/w3.err")"
  [ -d "$wt3/node_modules/pkg" ] && [ ! -L "$wt3/node_modules" ] && [ -f "$wt3/.env" ] || die "no real copy with symlinks blocked"
  [ -z "$(find "$wt3/.agents/local" -type l 2>/dev/null)" ] || die "a link was made with symlinks blocked"
  echo 'rec=1' > .agents/local/metrics/probe.txt
  [ "$(PATH=$base/lnfail:$PATH A worktree-add W-3)" = "$wt3" ] || die "reuse with symlinks blocked"
  ok "worktree-add: dependency folder copied (a change stays in the worktree), .env* copied and refused by pre-commit, works with ln -s blocked (A185)"
}

# --- A185 review: a link inside a copied dependency folder never leads back into the main tree ---------------------------------------
sc_worktree_links() {
  bnew; binstall no
  main=$(pwd -P)
  printf 'node_modules/\n' >> .gitignore; git add .gitignore; git commit -qm ignore
  mkdir -p node_modules/pkg node_modules/.bin shared; echo v1 > node_modules/pkg/index.js; echo tool > shared/tool.js
  # relative, leaves the folder: from main/node_modules/.bin six levels up is above the main tree, but from the copy (main/.agents/local/worktrees/W-1/node_modules/.bin) it is the main tree
  ln -s ../../../../../../shared/tool.js node_modules/.bin/rel
  ln -s "$main/shared/tool.js" node_modules/abs                   # absolute, into the main tree
  ln -s pkg/index.js node_modules/inside                          # relative, stays inside the folder
  wt=$(A worktree-add W-1) || die "worktree-add: $wt"
  for l in "$wt/node_modules/.bin/rel" "$wt/node_modules/abs"; do
    [ -L "$l" ] || continue                                       # rejected (removed) is as good as re-pointed
    case "$l" in */rel) [ "$(readlink "$l")" != ../../../../../../shared/tool.js ] || die "the relative link that reaches the main tree was copied unchanged" ;; esac
    r=$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$l")
    case "$r" in "$wt"/*) ;; "$main"/*) die "the copied link ${l#"$wt"/} still leads into the main tree: $r" ;; esac
  done
  echo changed > "$wt/node_modules/.bin/rel" 2>/dev/null || :
  [ "$(cat shared/tool.js)" = tool ] || die "a write through a copied link reached the main tree's shared/tool.js"
  [ "$(readlink "$wt/node_modules/inside")" = pkg/index.js ] || die "a link that stays inside the folder was changed: $(readlink "$wt/node_modules/inside")"
  ok "worktree-add: a relative or absolute link in a copied dependency folder that led into the main tree is re-pointed; an inner link is kept (A185)"
}

# --- A185 (round 2): the prompt hook of the main tree approves the pending request of a run that lives in a worktree ---------------------------------
sc_worktree_prompt_approval() {
  bnew; mktask W-1 COMPLEX; binstall no
  hook=$(CDPATH='' cd "$tl_agents/../.." && pwd)/adapters/claude/hooks/proofline-hook.sh; [ -f "$hook" ] || die "no hook at $hook"
  main=$(pwd -P)
  hp() { printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"%s","prompt":"%s"}' "$main" "$1" | CLAUDE_PROJECT_DIR=$main PROOFLINE_NO_TTY=1 PROOFLINE_HOOK_APPROVE_BUDGET=120 PROOFLINE_HOOK_LOCK_WAIT=60 sh "$hook" prompt claude; }
  wt=$(A worktree-add W-1) || die "worktree-add: $wt"
  ( cd "$wt" && sh .agents/scripts/agent.sh start W-1 --task-file .agents/tasks/W-1.md >/dev/null 2>"$base/st.err" </dev/null ) || die "start W-1 in its worktree: $(tail -1 "$base/st.err")"
  printf -- '---\nscope:\n  - path: x.txt\n    criteria: [AC-1]\n---\n# Plan\n' > "$wt/.agents/runs/W-1/PLAN.md"
  ( cd "$wt" && sh .agents/scripts/agent.sh request-approval W-1 scope >/dev/null ) || die "request-approval scope in the worktree"
  ls "$wt"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-request-scope.yaml >/dev/null 2>&1 || die "no scope request in the worktree run"
  # the user's reply reaches the hook of the MAIN tree session; the run is in the worktree
  sleep 1; out=$(hp 'approve scope')
  ls "$wt"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml >/dev/null 2>&1 || die "the prompt hook did not record the scope approval in the worktree run: $out"
  printf '%s' "$out" | grep -q 'approval recorded' || die "the hook did not say it recorded the approval: $out"
  [ ! -e .agents/runs/W-1 ] || die "the approval created a run folder in the main tree"
  [ -s .agents/local/approve.log ] && grep -q 'W-1' .agents/local/approve.log || die "no line for W-1 in the shared approve.log of the main tree: $(cat .agents/local/approve.log 2>/dev/null)"
  [ ! -e "$wt/.agents/local/approve.log" ] || die "the worktree kept its own approve.log"
  # a run in another worktree with NO request: the prompt adds no work for it, its agent.sh is never started
  mktask W-2 COMPLEX; git add -A; git commit -qm 'task W-2'
  wt2=$(A worktree-add W-2) || die "worktree-add W-2: $wt2"
  ( cd "$wt2" && sh .agents/scripts/agent.sh start W-2 --task-file .agents/tasks/W-2.md >/dev/null 2>"$base/st2.err" </dev/null ) || die "start W-2: $(tail -1 "$base/st2.err")"
  mv "$wt2/.agents/scripts/agent.sh" "$wt2/.agents/scripts/agent.real.sh"
  printf '#!/bin/sh\necho "$*" >> "%s/wtcalls"\nexec sh "$(dirname "$0")/agent.real.sh" "$@"\n' "$base" > "$wt2/.agents/scripts/agent.sh"
  : > "$base/wtcalls"; hp 'thanks, looks good' >/dev/null
  [ ! -s "$base/wtcalls" ] || die "a prompt without a pending request started the worktree's agent.sh: $(cat "$base/wtcalls")"
  mv "$wt2/.agents/scripts/agent.real.sh" "$wt2/.agents/scripts/agent.sh"
  # the capture is safe state in the main tree: a capture planted as a link is refused, as in the main tree
  ( cd "$wt" && sh .agents/scripts/agent.sh request-approval W-1 scope >/dev/null ) || die "second scope request"; sleep 1
  cp .agents/local/prompts/s1.json "$base/cap.real"; rm -f .agents/local/prompts/s1.json; ln -s "$base/cap.real" .agents/local/prompts/s1.json
  ( cd "$wt" && sh .agents/scripts/agent.sh approve-pending W-1 >"$base/lnk.out" 2>&1 ) || :
  grep -q 'not a regular single-link file' "$base/lnk.out" && [ "$(ls "$wt"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml | wc -l | tr -d ' ')" = 1 ] || die "a symlinked capture in the shared prompts folder was accepted from the worktree: $(cat "$base/lnk.out")"
  rm -f .agents/local/prompts/s1.json; ln "$base/cap.real" .agents/local/prompts/s1.json
  ( cd "$wt" && sh .agents/scripts/agent.sh approve-pending W-1 >"$base/lnk2.out" 2>&1 ) || :
  grep -q 'not a regular single-link file' "$base/lnk2.out" && [ "$(ls "$wt"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml | wc -l | tr -d ' ')" = 1 ] || die "a hard-linked capture was accepted from the worktree: $(cat "$base/lnk2.out")"
  ok "a worktree run's pending request is approved by the main tree's prompt hook (shared approve.log, no worktree process without a request); a linked capture is refused (A185)"
}

# --- A181 round 3: a task whose branch waits for the user's merge on a local origin; git says when it was merged, then the batch moves on -----------------
sc_manual_merge_batch() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  fake_run T-1
  wt=$(wtp T-1)
  # the delivered commit as the pr step of a manual platform leaves it: a branch on origin and deliver/<ID>/MERGE_HEAD
  git -C "$wt" checkout -q -b proofline/T-1-x; echo delivered > "$wt/delivered.txt"; git -C "$wt" add delivered.txt; git -C "$wt" commit -qm 'feat: delivered'
  git -C "$wt" push -q origin proofline/T-1-x 2> "$base/p.err" || die "push: $(cat "$base/p.err")"
  mkdir -p "$wt/.agents/local/deliver/T-1"; printf '%s\tmain\tproofline/T-1-x\n' "$(git -C "$wt" rev-parse HEAD)" > "$wt/.agents/local/deliver/T-1/MERGE_HEAD"
  A batch-next > "$base/bn.out" 2>&1 || die "batch-next: $(cat "$base/bn.out")"
  grep -q 'awaiting merge' "$base/bn.out" || die "batch-next does not say the task awaits the user's merge: $(cat "$base/bn.out")"
  grep -q 'YOUR merge into origin' "$base/bn.out" && grep -q '^NEXT: run T-2' "$base/bn.out" || die "an unmerged task blocked the batch or lacks the instruction: $(cat "$base/bn.out")"
  [ ! -s .agents/local/batch/merged.tsv ] || die "batch-next recorded a merge nobody made"
  # the user merges on origin (a fast-forward of main): git proves it, batch-next offers the proof step
  git -C "$wt" push -q origin proofline/T-1-x:main 2> "$base/p.err" || die "merge on origin: $(cat "$base/p.err")"
  A batch-next > "$base/bn.out" 2>&1 || die "batch-next after the merge: $(cat "$base/bn.out")"
  grep -q '^NEXT: deliver T-1 merged' "$base/bn.out" || die "batch-next after the merge: $(cat "$base/bn.out")"
  # the proof records the merge (before the cleanup); the batch then moves on to T-2
  A deliver-merged T-1 > "$base/dm.out" 2>&1 || :
  grep -q 'merge recorded for T-1: the delivered commit is on origin/main' "$base/dm.out" || die "deliver-merged: $(cat "$base/dm.out")"
  grep -q "^T-1	-	" .agents/local/batch/merged.tsv || die "no merge record for T-1: $(cat .agents/local/batch/merged.tsv 2>/dev/null)"
  A batch-next > "$base/bn.out" 2>&1
  if grep -q '^NEXT: ci T-1' "$base/bn.out"; then A batch-ci T-1 > "$base/ci.out" 2>&1 || die "batch-ci T-1 after the manual merge: $(cat "$base/ci.out")"; A batch-next > "$base/bn.out" 2>&1; fi
  grep -q '^NEXT: run T-2' "$base/bn.out" && ! grep -q 'T-1.*awaiting merge' "$base/bn.out" || die "the batch did not move on to T-2: $(cat "$base/bn.out")"
  ok "batch-next: an unmerged manual-platform task is 'awaiting merge' and the batch goes on; after the user's merge it offers 'deliver T-1 merged', and the record moves the batch to the next task (A181)"
}

# A180 round 5: a hand-pushed delivery (SUMMARY.md says the user merges, branch on origin, no MERGE_HEAD) waits for the merge and does not block the batch
sc_hand_pushed_batch() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  fake_run T-1; wt=$(wtp T-1)
  git -C "$wt" checkout -q -b proofline/T-1-x; echo d > "$wt/d.txt"; git -C "$wt" add d.txt; git -C "$wt" commit -qm 'feat: d'
  git -C "$wt" push -q origin proofline/T-1-x 2> "$base/p.err" || die "push: $(cat "$base/p.err")"
  mkdir -p "$wt/.agents/local/deliver/T-1"
  printf 'merge_by: user\nhead: %s\nbase: main\nbranch: proofline/T-1-x\n' "$(git -C "$wt" rev-parse HEAD)" > "$wt/.agents/local/deliver/T-1/SUMMARY.md"
  A batch-next > "$base/bn.out" 2>&1
  grep -q 'awaiting merge' "$base/bn.out" && grep -q '^NEXT: run T-2' "$base/bn.out" || die "a hand-pushed delivery is not awaiting merge: $(cat "$base/bn.out")"
  ok "batch-next: a hand-pushed delivery without MERGE_HEAD is parked as awaiting merge (A180)"
}

# --- round 6: the main tree's prompt hook runs only an unchanged worktree agent.sh, and a reply binds to the run it names when several wait --------------------
sc_prompt_guards() {
  bnew; mktask W-1 COMPLEX; mktask W-2 COMPLEX; binstall no
  hook=$(CDPATH='' cd "$tl_agents/../.." && pwd)/adapters/claude/hooks/proofline-hook.sh; main=$(pwd -P)
  hp() { printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"%s","prompt":"%s"}' "$main" "$1" | CLAUDE_PROJECT_DIR=$main PROOFLINE_NO_TTY=1 PROOFLINE_HOOK_APPROVE_BUDGET=120 PROOFLINE_HOOK_LOCK_WAIT=60 sh "$hook" prompt claude; }
  for r in W-1 W-2; do
    w=$(A worktree-add $r) || die "worktree-add $r"
    ( cd "$w" && sh .agents/scripts/agent.sh start $r --task-file .agents/tasks/$r.md >/dev/null 2>&1 </dev/null ) || die "start $r"
    printf -- '---\nscope:\n  - path: x.txt\n    criteria: [AC-1]\n---\n# Plan\n' > "$w/.agents/runs/$r/PLAN.md"
    ( cd "$w" && sh .agents/scripts/agent.sh request-approval $r scope >/dev/null ) || die "request-approval $r"
  done
  w1=$(wtp W-1); w2=$(wtp W-2)
  # (7) two runs wait: a reply that names none approves neither; naming W-2 approves only W-2
  sleep 1; out=$(hp 'approve scope')
  ls "$w1"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml "$w2"/.agents/runs/W-2/approvals/[0-9][0-9][0-9]-scope.yaml >/dev/null 2>&1 && die "an unnamed reply approved a run while two waited"
  printf '%s' "$out" | grep -q 'say which run you approve' || die "the hook did not ask which run: $out"
  sleep 1; out=$(hp 'i approve the scope for W-2')
  ls "$w2"/.agents/runs/W-2/approvals/[0-9][0-9][0-9]-scope.yaml >/dev/null 2>&1 || die "the reply naming W-2 did not approve W-2: $out $(tail -3 .agents/local/approve.log 2>/dev/null)"
  ls "$w1"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml >/dev/null 2>&1 && die "the reply naming W-2 also approved W-1"
  # (1) a worktree agent.sh that differs from the main one is not run: a forged approve-pending leaves its mark nowhere
  printf '\necho forged > "%s/forged"\n' "$base" >> "$w1/.agents/scripts/agent.sh"
  sleep 1; hp 'i approve the scope for W-1' >/dev/null
  [ ! -e "$base/forged" ] || die "the hook ran a modified worktree agent.sh"
  ls "$w1"/.agents/runs/W-1/approvals/[0-9][0-9][0-9]-scope.yaml >/dev/null 2>&1 && die "W-1 was approved through a modified agent.sh"
  ok "prompt hook: a reply with two runs waiting binds to the named run or asks; a modified worktree agent.sh is never run (round 6)"
}

# --- 9d. (A161, #140) night mode runs markdown tasks only: another adapter is refused with the next step -------------------------
sc_adapter_refused() {
  bnew; mktask T-1 COMPLEX; sed 's/^  adapter: markdown/  adapter: github/' .agents/config.yaml > .agents/config.tmp && mv .agents/config.tmp .agents/config.yaml; binstall no
  rm -rf .agents/local/batch
  expect_msg "batch-plan with tasks.adapter github" "tasks.adapter is github" BP all
  BP all > "$base/ad.out" 2>&1 && die "batch-plan accepted tasks.adapter github"
  grep -q "Next step: set tasks.adapter to markdown in .agents/config.yaml, import each task with '/proofline task <issue reference>' .*, then run '/proofline batch <ID...>' again\$" "$base/ad.out" || die "message: $(cat "$base/ad.out")"
  [ "$(find .agents/local/batch -type f 2>/dev/null | wc -l | tr -d ' ')" = 0 ] || die "a refused plan wrote files: $(find .agents/local/batch -type f)"
  [ "$(nfiles .agents/local/approvals request-batch)" = 0 ] || die "a refused plan requested an approval"
  ok "batch-plan: tasks.adapter github exits 1 with the exact next step and writes nothing"
}

# --- A163, A180: a GitHub project without a pull_request workflow can plan a batch; it is a WARNING, not a blocker -----------
sc_ci_required() {
  bnew; mktask T-1 COMPLEX; binstall no; rm -rf .github   # binstall adds a workflow; this scenario starts without one
  git remote add origin https://github.com/acme/app.git
  BP T-1 > "$base/plan.out" 2>&1 || die "batch-plan refused although the missing CI is only a warning: $(cat "$base/plan.out")"
  grep -q '^## WARNING' "$summary" || die "SUMMARY.md has no WARNING section"
  ! grep -q 'BLOCKER' "$summary" || die "a BLOCKER section is back"
  for t in 'no CI check runs on pull requests here.' 'verifies the commit locally' '/proofline task Add a GitHub Actions workflow'; do
    grep -Fq -- "$t" "$summary" || die "the warning lacks '$t': $(cat "$summary")"
  done
  [ -e .agents/local/batch/order.tsv ] || die "no order although the plan is valid"
  batch_approve
  A batch-check >/dev/null 2>&1 || die "the approved batch without CI is not valid"
  mkdir -p .github/workflows; printf 'on: [push, pull_request]\njobs: {}\n' > .github/workflows/ci.yml
  BP --replace T-1 > "$base/plan.out" 2>&1 || die "batch-plan refused with a workflow: $(cat "$base/plan.out")"
  ! grep -q '^## WARNING' "$summary" || die "WARNING in a summary with CI"
  ok "batch: no pull_request workflow is a WARNING in the summary and the approved batch is valid (A180); with one there is no warning"
}

# --- 13. one session works a batch: a live owner makes the others wait, a dead one is taken over -------------------------------
sc_owner_guard() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  sleep 60 & s1=$!; sleep 60 & s2=$!
  PROOFLINE_SESSION_PID=$s1 A batch-next | grep -q '^NEXT: run T-1' || { kill $s1 $s2; die "the first session did not get the batch"; }
  PROOFLINE_SESSION_PID=$s2 A batch-next > "$base/own.out"
  grep -q "^NEXT: wait (owned by pid $s1)" "$base/own.out" || { kill $s1 $s2; die "a second live session was not told to wait: $(cat "$base/own.out")"; }
  PROOFLINE_SESSION_PID=$s1 A batch-next | grep -q '^NEXT: run T-1' || { kill $s1 $s2; die "the owner itself is told to wait"; }
  kill $s1; wait $s1 2>/dev/null || :
  PROOFLINE_SESSION_PID=$s2 A batch-next | grep -q '^NEXT: run T-1' || { kill $s2; die "a dead owner was not taken over"; }
  [ "$(cut -f1 .agents/local/batch/owner)" = "$s2" ] || { kill $s2; die "owner file: $(cat .agents/local/batch/owner)"; }
  # a specialist role neither claims nor takes over: the command allow-list denies it, and batch.sh itself claims only for the lead
  PROOFLINE_SESSION_PID=$s2 A batch-next >/dev/null; own_before=$(cat .agents/local/batch/owner)
  sleep 60 & s3=$!
  expect_msg "a specialist role calling batch-next" "command denied for reviewer" env AGENT_ROLE=reviewer PROOFLINE_SESSION_PID=$s3 sh ./.agents/scripts/agent.sh batch-next
  PROOFLINE_SESSION_PID=$s3 sh ./.agents/scripts/batch.sh next > "$base/spec.out" 2>&1   # no lead role given: a digest, no claim, no verdict
  grep -q '^NEXT: run T-1' "$base/spec.out" && ! grep -q 'NEXT: wait' "$base/spec.out" || { kill $s2 $s3; die "a non-lead caller got a wait verdict: $(cat "$base/spec.out")"; }
  [ "$(cat .agents/local/batch/owner)" = "$own_before" ] || { kill $s2 $s3; die "a non-lead caller claimed the batch"; }
  kill $s2; wait $s2 2>/dev/null || :
  PROOFLINE_SESSION_PID=$s3 sh ./.agents/scripts/batch.sh next >/dev/null
  [ "$(cut -f1 .agents/local/batch/owner)" = "$s2" ] || { kill $s3; die "a non-lead caller took over a dead owner"; }
  kill $s3; wait $s3 2>/dev/null || :
  ok "batch-next: one session owns the batch (a live owner makes another wait with its pid), a dead owner is taken over"
}

# --- 14. the pull request is open, but merged.tsv has no record: the platform decides ----------------------------------------------
sc_pr_recovery() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX T-1; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'await\n' > "$FAKE/behave/T-1"
  drive
  A batch-next --tsv | tr '\t' ' ' | grep -q '^T-1 parked awaiting merge pull request 77: its state cannot be read' || die "a PR whose state cannot be read must say so: $(A batch-next --tsv)"
  git remote set-url origin https://github.com/acme/app.git; PROOFLINE_SELFTEST=1; export PROOFLINE_SELFTEST
  printf 'OPEN false aaa b main o\n' > "$FAKE/prview"
  A batch-next --tsv | tr '\t' ' ' | grep -q '^T-1 parked awaiting merge pull request 77 is open' || die "an open PR keeps the task parked: $(A batch-next --tsv)"
  printf 'MERGED false aaa b main o\n' > "$FAKE/prview"
  A batch-next | grep -q '^NEXT: deliver T-1 cleanup 77' || die "a merged PR without a record must lead to the cleanup step: $(A batch-next)"
  [ ! -s .agents/local/batch/merged.tsv ] || die "batch-next recorded a merge itself"
  ok "batch-next: a PR file without a merged.tsv record asks the platform: merged -> deliver cleanup, open -> parked, unreadable -> parked and says so"
}

# --- 15. the approved batch is continued only for tasks it knows ------------------------------------------------------------------
sc_plan_all_subset() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask CR CRITICAL; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  BP all > "$base/same.out" 2>&1 || die "all (with a CRITICAL task left out by the plan) must continue the batch: $(cat "$base/same.out")"
  grep -q 'continuing it' "$base/same.out" || die "no continue: $(cat "$base/same.out")"
  mktask T-9 COMPLEX
  expect_msg "all with a task added after the approval" "does not contain: T-9" BP all
  expect_msg "an explicit ID the batch does not know" "does not contain: T-9" BP T-1 T-9
  BP --replace all >/dev/null || die "--replace"; order_ids | grep -q 'T-9' || die "--replace did not include T-9"
  ok "batch-plan: 'all' or IDs that the approved batch does not contain are refused with --replace as the way out; tasks it left out on purpose do not count"
}

# --- 16. the keys of the removed driver are ignored, not validated; the live keys still are -------------------------------------------
sc_config_ignored_keys() {
  bnew; binstall no
  cfg_batch 40; cfg_extra '  task_timeout: soon' '  runtimes: nothing'
  A config-check >/dev/null 2>"$base/cc.err" || die "an old config with batch.task_timeout and batch.runtimes is refused: $(cat "$base/cc.err")"
  cfg_batch 40; cfg_extra '  ci_appear_minutes: 0'
  expect_msg "batch.ci_appear_minutes: 0 stays invalid" "ci_appear_minutes must be at least 1" A config-check
  cfg_batch 40; cfg_extra '  frobnicate: 1'
  expect_msg "an unknown batch key" "unknown batch key" A config-check
  ok "config: batch.task_timeout and batch.runtimes are accepted and ignored (old configs), batch.ci_appear_minutes and unknown keys are still checked"
}

# --- A200: plan-lint. The questions a plan would raise at freeze are asked in the summary, answered in the user's own words ----------------------
sc_preflight() {
  bnew; mkdir -p .agents/tasks; binstall no
  { printf '# Task: P-1 — wide task\n\n## Goal\n\nIt works.\n\n## Context\n\nChanges'; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do printf ' `src/m%s.js`' "$i"; done
    printf ' and the pages `docs/g1.md`, `docs/g2.md`. This adds a new dependency on a library.\n\n## Acceptance criteria\n\n- AC-1: the output is better\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nCOMPLEX because it touches many modules.\n'; } > .agents/tasks/P-1.md
  mktask P-2 STANDARD; mktask P-3 COMPLEX; git add -A; git commit -qm tasks
  BP P-1 P-2 P-3 > "$base/plan.out" || die "batch-plan failed: $(cat "$base/plan.out")"
  grep -q '^## Pre-flight questions' "$summary" || die "no pre-flight section: $(cat "$summary")"
  for k in split exempt dep ac; do grep -q "\[P-1, $k\]" "$summary" || die "no $k question for P-1: $(grep -n 'Q[0-9]' "$summary")"; done
  grep -q '\[P-2' "$summary" && die "a plain task raised a question: $(grep 'P-2' "$summary")"
  grep -q 'code paths (2 content or document paths are not counted)' "$summary" || die "the split question counts content paths or misses the figures: $(grep 'split' "$summary")"
  grep -q '\[P-3, class\].*Its reason' "$summary" || die "a COMPLEX task with few paths is not asked for its class: $(grep P-3 "$summary")"
  grep -q '^## Verification commands' "$summary" || die "no verification commands section"
  grep -q 'no proven proposal exists' "$summary" || die "empty commands without a proposal are not said: $(sed -n '/Verification commands/,/Stop rules/p' "$summary")"
  cut -f1,2,3,4 .agents/local/batch/lint.tsv | tr '\t' ' ' | tr '\n' ';' | grep -q 'Q1 P-1 split' || die "lint.tsv: $(cat .agents/local/batch/lint.tsv)"
  batch_approve
  expect_msg "batch-answer without a user message" "no captured user message since the summary" A batch-answer
  mkdir -p .agents/local/prompts/history; now=$(( $(date +%s) + 10 ))
  printf 'thanks, looks fine\n' > .agents/local/prompts/history/$now-aaaa1111.txt
  expect_msg "a remark is no answer" "no captured user message since the summary" A batch-answer
  printf 'Q1: do not split, Q2 a, Q3 b\nQ4 a.\n' > .agents/local/prompts/history/$((now + 1))-bbbb2222.txt
  A batch-answer > "$base/ans.out" || die "batch-answer: $(cat "$base/ans.out")"
  A batch-answers P-1 | tr '\n' ';' | grep -q 'Q1 P-1 split: option b (up to 27)' || die "split answer: $(A batch-answers P-1)"
  A batch-answers P-1 | grep -q 'Q3 P-1 dep: option b' && A batch-answers P-1 | grep -q 'Q4 P-1 ac: option a' || die "answers: $(A batch-answers P-1)"
  A batch-next | grep -q '^P-1 | PARKED | new dependency' || die "a dependency answer 'park' did not park the task: $(A batch-next)"
  # A202: a parked task reads PARKED (with its reason) in both views, never like a running or pending one
  A batch-status | grep -q '^P-1 | PARKED | ' && A batch-status | grep -q '^P-1 | PARKED | .*new dependency' || die "batch-status does not show P-1 as PARKED with its reason: $(A batch-status)"
  A batch-status | grep -q '^P-2 | pending | ' || die "the running-to-be task is not told apart from the parked one: $(A batch-status)"
  if A batch-next | grep -q '^P-1 | parked'; then die "batch-next still writes a parked task like an ordinary state"; fi
  A batch-next | grep -q '^NEXT: run P-2' || die "the other task does not go on: $(A batch-next | tail -2)"
  # a leading "no" that also says to split is ambiguous: Q1 stays unanswered, never read as option b (proceed without splitting)
  q1_before=$(A batch-answers P-1 | grep -c 'Q1 ')
  printf 'Q1 no problem, split it\nQ2 a\n' > .agents/local/prompts/history/$((now + 1))-bbbb9999.txt
  A batch-answer >/dev/null || die "batch-answer on the ambiguous Q1 message: $(A batch-answer 2>&1)"
  [ "$(A batch-answers P-1 | grep -c 'Q1 ')" = "$q1_before" ] || die "'Q1 no problem, split it' was read as an answer to Q1: $(A batch-answers P-1)"
  # "bölmek" / "bölmeli" say to split: never option b (do not split); only the bare imperative "bölme" does
  q1_before=$(A batch-answers P-1 | grep -c 'Q1 ')
  printf 'Q1 bölmeli\nQ2 a\n' > .agents/local/prompts/history/$((now + 1))-bbbb9998.txt
  A batch-answer >/dev/null || die "batch-answer on the bölmeli message: $(A batch-answer 2>&1)"
  [ "$(A batch-answers P-1 | grep -c 'Q1 ')" = "$q1_before" ] || die "'Q1 bölmeli' was read as an answer to Q1: $(A batch-answers P-1)"
  printf 'Q1 bölmek lazım\nQ2 a\n' > .agents/local/prompts/history/$((now + 1))-bbbb9997.txt
  A batch-answer >/dev/null || die "batch-answer on the bölmek message"
  [ "$(A batch-answers P-1 | grep -c 'Q1 ')" = "$q1_before" ] || die "'Q1 bölmek lazım' was read as an answer to Q1: $(A batch-answers P-1)"
  # the same message is used once; a later "all recommended" fills what is open and a later message corrects an answer
  printf 'all recommended\n' > .agents/local/prompts/history/$((now + 2))-cccc3333.txt; A batch-answer >/dev/null || die "all recommended"
  [ "$(A batch-answers P-1 | grep -c 'Q1 ')" -ge 2 ] || die "all recommended did not answer"
  A batch-answers P-1 | grep 'Q1 ' | tail -1 | grep -q 'option a' || die "the newest answer to Q1 is not the recommended: $(A batch-answers P-1)"
  ok "A200 plan-lint: the summary asks split, exempt, dependency, criteria and class questions per task; the answers are the user's captured words, a remark is no answer, a park answer parks, all recommended takes the safe options"
}
# A200: the empty-commands proposal is covered by the user's own words only
sc_commands_check() {
  bnew; binstall no
  mkdir -p .agents/local/commands; pf=.agents/local/commands/PROPOSAL.tsv
  printf 'test\tnpm test\n' > "$pf"
  ct=$(( $(date +%s) + 7200 ))
  cap_apply() { ct=$((ct + 1)); capture "$1" "$ct"; A approve-pending >/dev/null 2>&1 || :; }
  expect_msg "commands-check without any approval" "does not approve the commands" A commands-check
  # an approval in the user's words that was said before any request is no answer (the capture is older than the request)
  A request-approval - commands | grep -q 'commands.test: npm test' || die "the request does not show the proposed commands"
  capture 'approve commands' 1000; A approve-pending >/dev/null 2>&1 || :
  expect_msg "a reply older than the request" "does not approve the commands" A commands-check
  cap_apply 'looks good'; expect_msg "commands-check on a reply that is no approval" "does not approve the commands" A commands-check
  cap_apply 'do not approve commands'; expect_msg "commands-check on a negated reply" "does not approve the commands" A commands-check
  cap_apply 'approve commands'; A commands-check | grep -q 'approved by the user' || die "approve commands: $(A commands-check 2>&1)"
  ls .agents/local/approvals | grep -q -- '-commands.yaml' || die "no approval of the kind commands was recorded"
  # a proposal changed after the approval (forged or replayed with other commands) has no approval bound to it
  cp "$pf" "$base/proposal.keep"; printf 'test\tnpm test\nlint\trm -rf x\n' > "$pf"
  expect_msg "a forged proposal is not covered by the approval of another" "does not approve the commands" A commands-check
  cp "$base/proposal.keep" "$pf"; A commands-check | grep -q 'approved by the user' || die "the approved proposal is not accepted again before it is applied"
  # a file time inside the proposal means nothing
  printf '#proposed_at\t0\ntest\tnpm test\n' > "$pf"
  expect_msg "a proposal that claims a time is another proposal" "does not approve the commands" A commands-check
  cp "$base/proposal.keep" "$pf"
  # applied once: the approval is consumed, so the same proposal replayed is refused until asked and answered again
  A approval-consume - commands >/dev/null || die "the commands approval was not consumed"
  expect_msg "a replayed proposal after the apply" "does not approve the commands" A commands-check
  # a batch approval covers the proposal only when its summary names the proposal
  capture 'looks good'; h=$(tsha "$pf" | cut -c1-12)
  mktask C-1 COMPLEX; git add -A; git commit -qm c1; BP C-1 >/dev/null
  grep -q "^commands proposal: $h\$" "$summary" || die "the summary does not name the proven proposal: $(sed -n '/Verification commands/,/Stop rules/p' "$summary")"
  expect_msg "commands-check before the batch is approved" "does not approve the commands" A commands-check
  batch_approve; A commands-check | grep -q 'covered by the batch approval' || die "the batch approval did not cover the named proposal: $(A commands-check 2>&1)"
  # the digest orders the write before any task (a lead that is not told stops at "approve commands" and never writes it)
  A batch-next | grep -q '^NEXT: commands ' || die "batch-next does not put the covered commands proposal first: $(A batch-next 2>&1 | tail -n 2)"
  mv "$pf" "$base/proposal.moved"; ! A batch-next | grep -q '^NEXT: commands' || die "batch-next still asks for the commands after the proposal was applied"; mv "$base/proposal.moved" "$pf"
  printf 'test\tnpm test\nlint\trm -rf x\n' > "$pf"
  expect_msg "a changed proposal is not covered" "does not approve the commands" A commands-check
  ok "A200: commands-check passes only on a commands approval bound to this proposal's sha256 (consumed on apply, no time read from the file) or on a batch approval whose summary names it"
}

# --- A200: a task that names a code path an earlier task names waits for that task's merge -----------------------------------
sc_same_files_wait() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX; binstall
  printf '\n## Scope\n\n- `src/shared.js`\n- `docs/notes.md`\n' >> .agents/tasks/T-1.md
  printf '\n## Scope\n\n- `src/shared.js`\n' >> .agents/tasks/T-2.md
  printf '\n## Scope\n\n- `src/other.js`\n- `docs/notes.md`\n' >> .agents/tasks/T-3.md
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  [ -s .agents/local/batch/paths.tsv ] || die "no paths.tsv was written at plan time"
  tsv=$(A batch-next --tsv | tr '\t' ' ')
  printf '%s\n' "$tsv" | grep -q '^T-2 waiting shares src/shared.js with T-1 (not merged yet)' || die "T-2 must wait for T-1, which names the same code file: $tsv"
  printf '%s\n' "$tsv" | grep -q '^T-3 open' || die "a shared DOCUMENT path must not make T-3 wait: $tsv"
  printf 'question\n' > "$FAKE/behave/T-1"; drive
  A batch-next --tsv | tr '\t' ' ' | grep -q '^T-2 skipped shares src/shared.js with T-1 (parked)' || die "T-2 must be skipped while T-1 is parked: $(A batch-next --tsv)"
  ok "A200: batch-next does not start a task that shares a code file with an earlier unmerged task; document paths do not count"
}

run_sc sc_preflight
run_sc sc_priority_and_allowed
run_sc sc_commands_check
run_sc sc_same_files_wait
run_sc sc_order_and_cycle
run_sc sc_no_approval_no_start
run_sc sc_cover_limits
run_sc sc_mutation_cap
run_sc sc_cover_delivery
run_sc sc_critical_excluded
run_sc sc_late_critical
run_sc sc_sequential
run_sc sc_park_skip_continue
run_sc sc_restart
run_sc sc_worktree_cmds
run_sc sc_worktree_prep
run_sc sc_worktree_links
run_sc sc_worktree_prompt_approval
run_sc sc_manual_merge_batch
run_sc sc_hand_pushed_batch
run_sc sc_prompt_guards
run_sc sc_status_from_records
run_sc sc_adapter_refused
run_sc sc_merge_commit_ci
run_sc sc_ci_required
run_sc sc_awake
run_sc sc_driver_removed
run_sc sc_owner_guard
run_sc sc_pr_recovery
run_sc sc_plan_all_subset
run_sc sc_config_ignored_keys
echo 'batch tests passed'
