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
  row "$base/st1.out" T-2 | grep -q 'parked' && row "$base/st1.out" T-2 | grep -q 'Which cache' || die "T-2 row: $(cat "$base/st1.out")"
  row "$base/st1.out" T-3 | grep -q 'skipped' || die "T-3 row: $(cat "$base/st1.out")"
  grep -qi 'no friction report' "$base/st1.out" || die "no 'no friction report' line"
  grep -qi 'driver' "$base/st1.out" && die "status still has a driver line: $(grep -i driver "$base/st1.out")"
  A batch-status > "$base/st1b.out" || die "agent.sh batch-status failed"
  grep -q 'T-1' "$base/st1b.out" && grep -q 'Which cache' "$base/st1b.out" || die "batch-status table: $(cat "$base/st1b.out")"
  # change the records: the table changes
  awk -F'\t' -v OFS='\t' '$1 == "T-1" { $2 = 777 } { print }' .agents/local/batch/merged.tsv > "$base/m.tsv"
  cp "$base/m.tsv" .agents/local/batch/merged.tsv
  BB status > "$base/st2.out"; row "$base/st2.out" T-1 | grep -q '777' && ! row "$base/st2.out" T-1 | grep -q '101' || die "merged.tsv edit not reflected: $(row "$base/st2.out" T-1)"
  BB status > "$base/st3.out"; row "$base/st3.out" T-4 | grep -q 'parked' && row "$base/st3.out" T-4 | grep -q 'reason-xyz-from-the-lead' || die "state.tsv park not reflected: $(row "$base/st3.out" T-4)"
  A batch-park T-4 --clear >/dev/null; BB status | grep T-4 | grep -q 'pending' || die "a cleared park is still shown"
  printf '1\n' > .agents/local/worktrees/T-2/.agents/runs/T-2/questions/001.answer.md   # the user answered (the parked run lives in its task's worktree, A169): the pending question is gone
  BB status > "$base/st4.out"; row "$base/st4.out" T-2 | grep -q 'Which cache' && die "an answered question is still shown as pending"
  row "$base/st4.out" T-2 | grep -q 'pending' || die "an answered task is not pending again: $(row "$base/st4.out" T-2)"
  # batch-next reads and never writes
  before=$(find .agents/local/batch -type f | sort | xargs cat | tsha /dev/stdin 2>/dev/null || find .agents/local/batch -type f | sort)
  A batch-next >/dev/null; A batch-next --tsv >/dev/null
  after=$(find .agents/local/batch -type f | sort | xargs cat | tsha /dev/stdin 2>/dev/null || find .agents/local/batch -type f | sort)
  [ "$before" = "$after" ] || die "batch-next wrote something"
  ok "batch status and batch-next: generated from merged.tsv, the runs' records and the lead's parks; edits to the records change the table; an answered question un-parks; batch-next is read-only"
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
  [ "$(A worktree-path W-2)" = "$wt" ] && ! A worktree-path W-9 >/dev/null 2>&1 || die "worktree-path"
  for d in batch approvals metrics friction prompts; do [ -L "$wt/.agents/local/$d" ] || die "no link to the shared $d folder in the worktree"; done
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
run_sc sc_status_from_records
run_sc sc_adapter_refused
run_sc sc_merge_commit_ci
run_sc sc_ci_required
run_sc sc_awake
run_sc sc_driver_removed
echo 'batch tests passed'
