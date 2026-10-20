#!/bin/sh
# shellcheck disable=SC2010,SC2012,SC2015,SC2154,SC2016,SC2329 # assertion chains; tl_agents and base come from test-lib.sh; literal text in fake scripts
# Tests for night mode (A157): `agent.sh batch-plan|batch-cover|batch-status` and `batch.sh run|status`.
# No real claude, gh or network: `claude` and `gh` are fakes on PATH (the driver honours them only under PROOFLINE_TEST=1),
# "origin" is a bare repository on disk. The fake claude writes synthetic records (merged.tsv, run dirs, questions).
#
# ASSUMPTIONS about the interface (the spec leaves these open; the implementation follows them):
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
#  6. `sh .agents/scripts/batch.sh run|status` from the repository root. The driver refuses a missing/invalid approval with a
#     message containing `batch approval`, a live LOCK with `only one task at a time`. It starts the headless session as
#     `claude -p "<prompt containing 'Task <ID> only'>" ...` (the prompt is an argument; the fake finds the ID there), in the
#     repository root, with PROOFLINE_TEST=1 in the environment. It needs `gh auth status`, `gh run list` (JSON) and a git
#     remote `origin` with main (git pull --ff-only); config batch.ci_wait_minutes is irrelevant (the fake CI is green).
#  7. state.tsv rows: ID<TAB>status<TAB>reason<TAB>question (status pending|running|merged|parked|skipped). A parked task's
#     reason is `question`, `FAILED` or `BLOCKED`; a skipped task's reason starts with `depends on <ID>`.
#  8. merged.tsv rows: ID<TAB>PR<TAB>epoch. `batch.sh status` prints one line per task containing the ID, the result word,
#     the PR number, the park reason and the first line of the pending question of the parked run (read from its questions/
#     dir), plus `no friction report` when none exists. `agent.sh batch-status` prints the same table.
#  9. A run the fake parks exists as .agents/runs/<ID>/ (RUN.yaml with execution.state and awaiting_input, questions/001.md).
# 10. batch-plan does not require branch main or a clean tree (only the driver does); it writes only under .agents/local/.
# 11. batch-cover finds the batch approval, the run (RUN.yaml pipeline.classification, execution.state) and the pending request
#     as agent.sh does today; a covered `delivery` records one approval per pending step request with the same delivery: hash.
# 12. Fixture config: tests replace the `batch:` block of .agents/config.yaml (mutation_budget_cap, ci_wait_minutes).
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
set -eu
PROOFLINE_TEST=1; export PROOFLINE_TEST
FAKE=$base/fake; mkdir -p "$FAKE/bin" "$FAKE/behave"; export FAKE
PATH=$FAKE/bin:$PATH; export PATH

# fake claude: -p "<prompt>"; the task ID is in "Task <ID> only"; the behaviour is the first line of $FAKE/behave/<ID>
cat > "$FAKE/bin/claude" <<'EOF'
#!/bin/sh
prompt=''
while [ $# -gt 0 ]; do case "$1" in -p) prompt=$2; shift ;; esac; shift; done
id=$(printf '%s' "$prompt" | sed -n 's/.*Task \([A-Za-z0-9_.-]*\) only.*/\1/p')
[ -n "$id" ] || { echo "fake claude: no task id in the prompt" >&2; exit 2; }
printf '%s\n' "$id" >> "$FAKE/calls.log"
echo "LOGONLY-$id narrative text that exists only in the session log"
beh=$(head -1 "$FAKE/behave/$id" 2>/dev/null); [ -n "$beh" ] || beh=nothing
mkrun() { # STATE AWAITING
  mkdir -p ".agents/runs/$id/questions"
  printf 'task:\n  id: %s\nexecution:\n  state: %s\n  awaiting_input: %s\npipeline:\n  classification: COMPLEX\nhandoff:\n  state: PLANNED\n' "$id" "$1" "$2" > ".agents/runs/$id/RUN.yaml"
}
case "$beh" in
  merge|merge+worktree)
    [ "$beh" = merge ] || git worktree add -q -b "tmp-$id" "$FAKE/wt-$id" >/dev/null 2>&1
    pr=$((100 + $(printf '%s' "$id" | tr -dc 0-9)))
    printf '%s\t%s\t%s\n' "$id" "$pr" "$(date +%s)" >> .agents/local/batch/merged.tsv ;;
  question)
    mkrun PLANNING true
    printf 'from: lead\nasked_at: %s\n---\n1. Which cache do we use for %s?\n   options: a | b\n' "$(date +%s)" "$id" > ".agents/runs/$id/questions/001.md" ;;
  failed) mkrun FAILED false ;;
  limit) echo "usage limit reached, try later"; exit 1 ;;
  hang) # A160/A161: a session that outlives batch.task_timeout, with descendants of every kind: a plain grandchild, a nested sh with its own
    # child, a backgrounded subshell that ignores TERM and has a child of its own. Every pid goes to descendants.pids.
    sleep 300 & echo $! > "$FAKE/grandchild.pid"; echo $! >> "$FAKE/descendants.pids"
    sh -c 'sleep 301 & echo $! >> "$FAKE/descendants.pids"; sleep 302' & echo $! >> "$FAKE/descendants.pids"
    ( trap '' TERM; sleep 303 & echo $! >> "$FAKE/descendants.pids"; sleep 304; sleep 305 ) & echo $! >> "$FAKE/descendants.pids"
    sleep 20 ;;
  nothing) : ;;
esac
exit 0
EOF
# fake gh: authenticated, main CI green
cat > "$FAKE/bin/gh" <<'EOF'
#!/bin/sh
# A160: `run list --commit <sha>` answers from $FAKE/ci/<sha> (the JSON) or $FAKE/ci/<sha>.none (no run); any other query is green
sha=''; prev=''; for a in "$@"; do [ "$prev" != --commit ] || sha=$a; prev=$a; done
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha" ]; then cat "$FAKE/ci/$sha"; exit 0; fi
if [ -n "$sha" ] && [ -f "$FAKE/ci/$sha.none" ]; then echo '[]'; exit 0; fi
case "$*" in
  *"run list"*) echo '[{"status":"completed","conclusion":"success"}]' ;;
  *"pr view"*) echo 0123456789abcdef0123456789abcdef01234567 ;;   # the merge commit of a PR (A160: the driver waits for the CI of that SHA)
  *) : ;;
esac
exit 0
EOF
# fake codex: records its argv, then behaves like the fake claude for the task named in the last argument (the prompt)
cat > "$FAKE/bin/codex" <<'EOF'
#!/bin/sh
[ "$1" != --version ] || { echo "codex-cli 0.163.0"; exit 0; }
for a in "$@"; do last=$a; done
printf '%s\n' "$*" >> "$FAKE/codex.argv"
# A160: a session that rewrites the approved summary to widen the sandbox for the sessions after it
if [ -f "$FAKE/codex.tamper" ]; then sed 's/^codex sandbox: .*/codex sandbox: danger-full-access/' .agents/local/batch/SUMMARY.md > .agents/local/batch/SUMMARY.tmp && mv .agents/local/batch/SUMMARY.tmp .agents/local/batch/SUMMARY.md; fi
exec claude -p "$last"
EOF
chmod +x "$FAKE/bin/claude" "$FAKE/bin/gh" "$FAKE/bin/codex"
mkdir -p "$FAKE/ci"; MSHA=0123456789abcdef0123456789abcdef01234567   # the merge commit the fake gh reports for every PR

# --- fixture helpers ------------------------------------------------------------------------------------------
# mktask ID CLASS|none [DEPS] [DIR]: a markdown task file under .agents/tasks[/DIR]
mktask() {
  mt_d=.agents/tasks; [ -z "${4:-}" ] || mt_d=.agents/tasks/$4; mkdir -p "$mt_d"
  { printf '# Task: %s — title of %s\n' "$1" "$1"
    if [ -n "${3:-}" ]; then printf '\n---\ndepends_on: %s\n\n---\n' "$3"; fi
    printf '\n## Acceptance criteria\n\n- AC-1: it works\n'
    if [ "$2" != none ]; then printf '\n## Suggested class\n\n%s\n' "$2"; fi; } > "$mt_d/$1.md"
}
# binstall [remote:yes|no]: the batch scripts in .agents/scripts, committed, a local bare origin (never a network)
install_scripts() { # DIR: the control-plane scripts a fixture lacks (batch.sh, dispatch.sh, friction.sh, ...), not the stubs
  for is_s in "$tl_agents"/scripts/*.sh; do
    case "$(basename "$is_s")" in *-test.sh|test-lib.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac
    cp "$is_s" "$1/"
  done
}
# bnew: a fresh fixture without task files (the shared template may carry some, see tpl_tasks)
bnew() { new_repo; rm -rf .agents/tasks; }
# tpl_tasks: scaffold() commits the baseline itself, and a later commit would make the frozen plan stale: the task files and
# the batch scripts go into the shared template first, so they are part of the baseline (bnew removes them again).
tpl_tasks() { new_repo; install_scripts "$base/template/.agents/scripts"; ( cd "$base/template" && mktask LC COMPLEX && mktask CR CRITICAL ); }
binstall() {
  install_scripts .agents/scripts
  : > "$FAKE/calls.log"; rm -f "$FAKE"/behave/*
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
batch_approve() { capture 'approve batch'; A approve-pending >/dev/null; }
summary=.agents/local/batch/SUMMARY.md
calls() { cat "$FAKE/calls.log" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'; }
state_of() { awk -F'\t' -v t="$1" -v c="$2" '$1 == t { print $c }' .agents/local/batch/state.tsv; }
order_ids() { cut -f1 .agents/local/batch/order.tsv | tr '\n' ' ' | sed 's/ *$//'; }
# nfiles DIR GLOB: how many files match (a refused command must write none)
nfiles() { case "$2" in -*) nf_p="^[0-9][0-9][0-9]$2" ;; *) nf_p=$2 ;; esac; ls -1 "$1" 2>/dev/null | grep -c -e "$nf_p" || :; }

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
  expect_msg "run without a plan" "batch" BB run
  BP all >/dev/null || die "batch-plan failed"
  expect_msg "run before the user approved" "batch approval" BB run
  [ -z "$(calls)" ] || die "a headless session was started without the approval: $(calls)"
  capture 'sounds good'; A approve-pending >/dev/null
  expect_msg "run after a reply that is not the approval" "batch approval" BB run
  batch_approve
  [ "$(nfiles .agents/local/approvals -batch.yaml)" = 1 ] || die "the reply 'approve batch' recorded no batch approval"
  # bound to the summary hash: a changed SUMMARY.md invalidates it
  cp "$summary" "$base/summary.keep"; printf 'extra line\n' >> "$summary"
  expect_msg "run with an edited summary" "batch approval" BB run
  [ -z "$(calls)" ] || die "a session started with an edited summary"
  cp "$base/summary.keep" "$summary"
  # a new plan has a fresh nonce: the old approval does not carry over
  old=$(tsha "$summary"); BP all >/dev/null; [ "$(tsha "$summary")" != "$old" ] || die "a new plan reused the old summary (no fresh nonce)"
  expect_msg "run after a re-plan" "batch approval" BB run
  [ -z "$(calls)" ] || die "a session started after a re-plan without a new approval"
  ok "batch run: refuses without (or with a stale) approval, no session started; the approval is bound to the SUMMARY.md hash"
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

# --- 5. a middle task parks: its dependent is skipped, an independent later task still runs ---------------------------------
sc_park_skip_continue() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX T-2; mktask T-4 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'merge\n' > "$FAKE/behave/T-1"; printf 'question\n' > "$FAKE/behave/T-2"; printf 'merge+worktree\n' > "$FAKE/behave/T-4"
  BB run > "$base/run.out" 2>&1 || :
  [ "$(calls)" = "T-1 T-2 T-4" ] || die "sessions started (one at a time, in order, none for the skipped dependent): '$(calls)'; $(tail -5 "$base/run.out")"
  [ "$(state_of T-1 2)" = merged ] && [ "$(state_of T-2 2)" = parked ] && [ "$(state_of T-3 2)" = skipped ] && [ "$(state_of T-4 2)" = merged ] || die "state.tsv: $(cat .agents/local/batch/state.tsv)"
  [ "$(state_of T-2 3)" = question ] || die "T-2 park reason: $(state_of T-2 3)"
  state_of T-2 4 | grep -q 'Which cache' || die "T-2 pending question not copied: $(state_of T-2 4)"
  state_of T-3 3 | grep -q 'depends on T-2' || die "T-3 skip reason: $(state_of T-3 3)"
  [ -f .agents/local/batch/logs/T-1.log ] && grep -q 'LOGONLY-T-1' .agents/local/batch/logs/T-1.log || die "no session log for T-1"
  [ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] || die "a worktree the session added was left: $(git worktree list)"
  [ "$(git branch --show-current)" = main ] && [ -z "$(git status --porcelain)" ] || die "the driver left the repository off main or dirty"
  BB run >/dev/null 2>&1 || :
  [ "$(calls)" = "T-1 T-2 T-4" ] || die "a second run restarted merged or still-parked tasks: '$(calls)'"
  ok "batch run: T-2 parked, T-3 skipped (depends on T-2), T-4 still ran and merged; hygiene (worktree removed, back on main); a re-run changes nothing"
}

# --- 5b. one at a time: a live lock refuses a second run, a stale lock is replaced -----------------------------------------
sc_lock() {
  bnew; mktask T-1 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'merge\n' > "$FAKE/behave/T-1"
  sleep 120 & lp=$!
  printf '%s\n' "$lp" > .agents/local/batch/LOCK
  expect_msg "second run while the lock holder is alive" "only one task at a time" BB run
  [ -z "$(calls)" ] || die "a session started while the batch was locked"
  kill "$lp" 2>/dev/null; wait "$lp" 2>/dev/null || :
  BB run >/dev/null 2>&1 || die "a stale lock (dead pid) blocked the run"
  [ "$(calls)" = "T-1" ] && [ "$(state_of T-1 2)" = merged ] || die "run after the stale lock: '$(calls)' $(cat .agents/local/batch/state.tsv)"
  ok "lock: a live LOCK pid refuses a second run (only one task at a time), a stale lock is replaced"
}

# --- 6. the morning report comes from the records only -----------------------------------------------------------------------
sc_status_from_records() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; mktask T-3 COMPLEX T-2; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'merge\n' > "$FAKE/behave/T-1"; printf 'question\n' > "$FAKE/behave/T-2"
  BB run >/dev/null 2>&1 || :
  BB status > "$base/st1.out" || die "batch.sh status failed"
  row() { grep "$2" "$1" | head -1; }
  row "$base/st1.out" T-1 | grep -q 'merged' && row "$base/st1.out" T-1 | grep -q '101' || die "T-1 row: $(cat "$base/st1.out")"
  row "$base/st1.out" T-2 | grep -q 'parked' && row "$base/st1.out" T-2 | grep -q 'Which cache' || die "T-2 row: $(cat "$base/st1.out")"
  row "$base/st1.out" T-3 | grep -q 'skipped' || die "T-3 row: $(cat "$base/st1.out")"
  grep -qi 'no friction report' "$base/st1.out" || die "no 'no friction report' line"
  grep -q 'LOGONLY' "$base/st1.out" && die "the report holds text that exists only in the session log"
  grep -q 'LOGONLY' .agents/local/batch/logs/T-1.log || die "test setup: the log lacks its marker"
  A batch-status > "$base/st1b.out" || die "agent.sh batch-status failed"
  grep -q 'T-1' "$base/st1b.out" && grep -q 'Which cache' "$base/st1b.out" || die "batch-status table: $(cat "$base/st1b.out")"
  # change the records: the table changes
  awk -F'\t' -v OFS='\t' '$1 == "T-1" { $2 = 777 } { print }' .agents/local/batch/merged.tsv > "$base/m.tsv"
  cp "$base/m.tsv" .agents/local/batch/merged.tsv
  BB status > "$base/st2.out"; row "$base/st2.out" T-1 | grep -q '777' && ! row "$base/st2.out" T-1 | grep -q '101' || die "merged.tsv edit not reflected: $(row "$base/st2.out" T-1)"
  awk -F'\t' -v OFS='\t' '$1 == "T-3" { $2 = "parked"; $3 = "reason-xyz-from-state" } { print }' .agents/local/batch/state.tsv > "$base/s.tsv"
  cp "$base/s.tsv" .agents/local/batch/state.tsv
  BB status > "$base/st3.out"; row "$base/st3.out" T-3 | grep -q 'parked' && row "$base/st3.out" T-3 | grep -q 'reason-xyz-from-state' || die "state.tsv edit not reflected: $(row "$base/st3.out" T-3)"
  printf '1\n' > .agents/runs/T-2/questions/001.answer.md   # the user answered: the pending question is gone
  BB status > "$base/st4.out"; row "$base/st4.out" T-2 | grep -q 'Which cache' && die "an answered question is still shown as pending"
  ok "batch status: table from state.tsv, merged.tsv and the parked run's records; no log-only text; edits to the records change the table"
}

# --- 7. stale log text is not this session's output ---------------------------------------------------------------------------
sc_stale_log() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  mkdir -p .agents/local/batch/logs; printf 'usage limit reached yesterday; 401 rate limit quota\n' > .agents/local/batch/logs/T-1.log
  printf 'nothing\n' > "$FAKE/behave/T-1"; printf 'merge\n' > "$FAKE/behave/T-2"
  BB run > "$base/run.out" 2>&1 || :
  [ "$(calls)" = "T-1 T-2" ] || die "stale log text stopped the batch or switched runtime: '$(calls)'; $(tail -5 "$base/run.out")"
  [ "$(state_of T-1 2)" = parked ] && state_of T-1 3 | grep -q 'session ended without a result' || die "T-1: $(state_of T-1 2) $(state_of T-1 3)"
  [ "$(state_of T-2 2)" = merged ] || die "the next task did not run: $(cat .agents/local/batch/state.tsv)"
  grep -q '^# stopped' .agents/local/batch/state.tsv && die "the batch recorded a stop"
  ok "batch run: stale limit/auth text in the cumulative log is ignored; no-result session parks, next task still runs"
}

# --- 8. (A160) a session that outlives batch.task_timeout is parked with its whole process group closed -------------------------
sc_task_timeout() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX T-1; mktask T-3 COMPLEX; cfg_batch 40; cfg_extra '  task_timeout: 1'; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'hang\n' > "$FAKE/behave/T-1"; printf 'merge\n' > "$FAKE/behave/T-3"; rm -f "$FAKE/grandchild.pid" "$FAKE/descendants.pids"
  ( PROOFLINE_BATCH_MINUTE=3; export PROOFLINE_BATCH_MINUTE; BB run > "$base/run.out" 2>&1 ) || :
  gc=$(cat "$FAKE/grandchild.pid" 2>/dev/null || :); [ -n "$gc" ] || die "test setup: the fake session spawned no grandchild"
  [ "$(wc -l < "$FAKE/descendants.pids" | tr -d ' ')" -ge 5 ] || die "test setup: the fake session recorded $(wc -l < "$FAKE/descendants.pids") descendants, want 5"
  for dp in $(cat "$FAKE/descendants.pids"); do
    if kill -0 "$dp" 2>/dev/null; then for dq in $(cat "$FAKE/descendants.pids"); do kill -KILL "$dq" 2>/dev/null || :; done; die "a descendant (pid $dp) of the timed-out session is still alive (method ${PROOFLINE_BATCH_PGMETHOD:-auto}): its process group was not closed"; fi
  done
  [ "$(state_of T-1 2)" = parked ] && [ "$(state_of T-1 3)" = timeout ] || die "T-1 after the timeout: $(cat .agents/local/batch/state.tsv); $(tail -5 "$base/run.out")"
  state_of T-1 4 | grep -q 'no result within 1 minutes' || die "T-1 reason text: $(state_of T-1 4)"
  [ "$(state_of T-2 2)" = skipped ] && state_of T-2 3 | grep -q 'depends on T-1 (parked)' || die "T-2: $(state_of T-2 2) $(state_of T-2 3)"
  [ "$(state_of T-3 2)" = merged ] && [ "$(calls)" = "T-1 T-3" ] || die "the batch did not go on after the timeout: '$(calls)' $(cat .agents/local/batch/state.tsv)"
  ok "batch run: a hanging session is parked (timeout), its dependent skipped, the next task merged, the grandchild of its process group is dead"
}

# --- 9. (A160) Codex sessions run sandboxed; danger-full-access only when the approved summary says so ---------------------------
sc_codex_sandbox() {
  bnew; mktask T-1 COMPLEX; cfg_batch 40; cfg_extra '  runtimes: codex'; binstall
  printf 'merge\n' > "$FAKE/behave/T-1"
  # default: workspace-write with network for package installs; the summary says so and carries no warning
  BP all >/dev/null || die "batch-plan failed"
  grep -q '^codex sandbox: proofline_night profile' "$summary" && ! grep -q 'danger-full-access\|^WARNING:' "$summary" || die "default summary: $(grep -i 'sandbox\|WARNING' "$summary")"
  batch_approve; : > "$FAKE/codex.argv"
  BB run >/dev/null 2>&1 || :
  grep -q 'default_permissions="proofline_night"' "$FAKE/codex.argv" && grep -q 'permissions.proofline_night.network.enabled=true' "$FAKE/codex.argv" && ! grep -q -- ' -s ' "$FAKE/codex.argv" || die "codex argv: $(cat "$FAKE/codex.argv")"
  if grep -q 'danger-full-access' "$FAKE/codex.argv"; then die "danger-full-access without the flag: $(cat "$FAKE/codex.argv")"; fi
  # config and environment cannot enable it: only the flag at plan time, visible with the warning
  cg_reset() { rm -rf .agents/local/batch .agents/runs/T-1; : > "$FAKE/codex.argv"; }
  cg_reset; cfg_extra '  codex_sandbox: danger-full-access' '  sandbox: danger-full-access'
  git add -A; git commit -qm 'extra config keys'
  BP all >/dev/null || die "batch-plan with extra config keys failed"; batch_approve
  ( PROOFLINE_CODEX_SANDBOX=danger-full-access; CODEX_SANDBOX=danger-full-access; export PROOFLINE_CODEX_SANDBOX CODEX_SANDBOX; BB run >/dev/null 2>&1 ) || :
  grep -q 'default_permissions="proofline_night"' "$FAKE/codex.argv" && ! grep -q 'danger-full-access' "$FAKE/codex.argv" || die "config/env enabled danger-full-access: $(cat "$FAKE/codex.argv")"
  for pos in first last; do   # the flag in any position
    if [ $pos = first ]; then BP --codex-danger-full-access all > "$base/plan.out" || die "flag first refused: $(cat "$base/plan.out")"
    else BP all --codex-danger-full-access > "$base/plan.out" || die "flag last refused: $(cat "$base/plan.out")"; fi
    grep -q '^codex sandbox: danger-full-access' "$summary" && grep -q '^WARNING:' "$summary" || die "flag $pos: summary lacks the sandbox line or the warning: $(grep -i 'sandbox\|WARNING' "$summary")"
  done
  cg_reset; BP all --codex-danger-full-access >/dev/null || die "batch-plan with the flag failed"; batch_approve; BB run >/dev/null 2>&1 || :
  grep -q -- '-s danger-full-access' "$FAKE/codex.argv" && ! grep -q 'proofline_night' "$FAKE/codex.argv" || die "codex argv with the flag: $(cat "$FAKE/codex.argv")"
  ok "codex: -s workspace-write (+network) by default; danger-full-access only via --codex-danger-full-access in the approved summary (with WARNING), never config or env"
}

sc_codex_sandbox_tamper() {
  # session 1 rewrites SUMMARY.md to danger-full-access: the driver read the approved choice once, so session 2 stays workspace-write
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; cfg_batch 40; cfg_extra '  runtimes: codex'; binstall
  printf 'merge\n' > "$FAKE/behave/T-1"; printf 'merge\n' > "$FAKE/behave/T-2"
  BP all >/dev/null || die "batch-plan failed"; batch_approve; : > "$FAKE/codex.argv"; : > "$FAKE/codex.tamper"
  BB run >/dev/null 2>&1 || :
  rm -f "$FAKE/codex.tamper"
  [ "$(calls)" = "T-1 T-2" ] || die "both tasks should have run: '$(calls)'"
  grep -q '^codex sandbox: danger-full-access' .agents/local/batch/SUMMARY.md || die "the fake codex did not rewrite SUMMARY.md"
  [ "$(wc -l < "$FAKE/codex.argv" | tr -d ' ')" = 2 ] || die "expected two codex sessions: $(cat "$FAKE/codex.argv")"
  sed -n 2p "$FAKE/codex.argv" | grep -q 'default_permissions="proofline_night"' || die "session 2 argv lacks the proofline_night profile: $(sed -n 2p "$FAKE/codex.argv")"
  if grep -q 'danger-full-access' "$FAKE/codex.argv"; then die "danger-full-access reached a session: $(cat "$FAKE/codex.argv")"; fi
  ok "codex sandbox is read once at run start: a session editing SUMMARY.md cannot widen it for the next session"
}

# --- 9b. (A161, #135) the headless session leads its own process group, by every method; no method = no batch --------------------------
pg_setup() { # a batch of T-1 (hangs, timeout 1 minute), T-2 (depends on T-1), T-3 (merges), approved
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX T-1; mktask T-3 COMPLEX; cfg_batch 40; cfg_extra '  task_timeout: 1'; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'hang\n' > "$FAKE/behave/T-1"; printf 'merge\n' > "$FAKE/behave/T-3"; rm -f "$FAKE/grandchild.pid" "$FAKE/descendants.pids"
}
pg_alive_any() { for pa in $(cat "$FAKE/descendants.pids" 2>/dev/null); do if kill -0 "$pa" 2>/dev/null; then return 0; fi; done; return 1; }
sc_pgroup_method() { # METHOD: every available method leaves all five descendants of a hung session dead
  pm=$1
  case "$pm" in setsid) command -v setsid >/dev/null 2>&1 || { ok "process group method setsid: not available on this machine, skipped"; return 0; } ;;
    perl) command -v perl >/dev/null 2>&1 || { ok "process group method perl: not available, skipped"; return 0; } ;;
    python) command -v python3 >/dev/null 2>&1 || { ok "process group method python: not available, skipped"; return 0; } ;; esac
  pg_setup
  ( PROOFLINE_BATCH_PGMETHOD=$pm; PROOFLINE_BATCH_MINUTE=3; export PROOFLINE_BATCH_PGMETHOD PROOFLINE_BATCH_MINUTE; BB run > "$base/run.out" 2>&1 ) || :
  if [ "$pm" = setm ] && grep -q 'no way to start a headless session' "$base/run.out"; then ok "process group method setm: job control not available here, skipped"; return 0; fi
  [ "$(wc -l < "$FAKE/descendants.pids" 2>/dev/null | tr -d ' ')" -ge 5 ] || die "method $pm: the fake session recorded too few descendants: $(tail -3 "$base/run.out")"
  if pg_alive_any; then for dq in $(cat "$FAKE/descendants.pids"); do kill -KILL "$dq" 2>/dev/null || :; done; die "method $pm: a descendant of the timed-out session is still alive"; fi
  [ "$(state_of T-1 2)" = parked ] && [ "$(state_of T-1 3)" = timeout ] && [ "$(state_of T-3 2)" = merged ] || die "method $pm: state: $(cat .agents/local/batch/state.tsv)"
  rf=.agents/local/batch/sessions/T-1.1.rec
  [ -f "$rf" ] || die "method $pm: no session record $rf"
  for kv in id=T-1 n=1 runtime=claude "method=$pm" log=.agents/local/batch/logs/T-1.log timeout=1 exit=124; do grep -qx "$kv" "$rf" || die "method $pm: record lacks $kv: $(cat "$rf")"; done
  grep -q '^start=[0-9]' "$rf" && grep -q '^end=[0-9]' "$rf" || die "method $pm: record lacks start or end: $(cat "$rf")"
  BB status > "$base/st.out" || die "batch status failed"
  grep -q '^sessions (from records; ' "$base/st.out" || die "method $pm: no sessions section: $(cat "$base/st.out")"
  grep -q '^task | # | runtime | start | end | exit | park reason | log$' "$base/st.out" || die "sessions header: $(cat "$base/st.out")"
  grep '^T-1 | 1 | claude | ' "$base/st.out" | grep -q '| 124 (timeout) | timeout | .agents/local/batch/logs/T-1.log$' || die "T-1 session row: $(grep '^T-1 |' "$base/st.out")"
  grep '^T-3 | 1 | claude | ' "$base/st.out" | grep -q '| 0 | - | ' || die "T-3 session row: $(grep '^T-3 |' "$base/st.out")"
  ok "process group method $pm: every descendant of a hung session is dead, record says method=$pm, status shows 124 (timeout) and the log path"
}
sc_pgroup_refuse() { # none, an unavailable method and an unknown one: one clear line, no session, nothing parked
  for pm in none bogus; do
    pg_setup
    ( PROOFLINE_BATCH_PGMETHOD=$pm; export PROOFLINE_BATCH_PGMETHOD
      expect_msg "method $pm" 'batch: no way to start a headless session in its own process group on this machine (' BB run )
    [ -z "$(calls)" ] || die "method $pm: a session started: $(calls)"
    ls .agents/local/batch/sessions/*.rec >/dev/null 2>&1 && die "method $pm: a session record was written"
    pg_alive_any && die "method $pm: a descendant exists"
    [ ! -f .agents/local/batch/state.tsv ] || [ "$(state_of T-1 2)" = pending ] || die "method $pm: T-1 is not pending: $(cat .agents/local/batch/state.tsv)"
  done
  # the probe itself prints "<pid> <pgid>"
  sh ./.agents/scripts/batch.sh _pgprobe "$base/probe.out" || die "_pgprobe failed"
  grep -Eq '^[0-9]+ [0-9]+$' "$base/probe.out" || die "_pgprobe output: $(cat "$base/probe.out")"
  ok "process group: method none or an unavailable one refuses the batch with one line, no session, no record, tasks stay pending; _pgprobe prints pid and pgid"
}
sc_pgroup_not_leader() { # the probe passes but the session is not its own group leader: it exits 125, the batch stops, the task stays pending
  command -v perl >/dev/null 2>&1 || { ok "not-leader stop: no perl here, skipped"; return 0; }
  pg_setup; mkdir -p "$FAKE/fakebin"
  cat > "$FAKE/fakebin/setsid" <<'EOF'
#!/bin/sh
# a setsid that only really leads a group for the probe; the session stays in the driver's group
case "$*" in *_pgprobe*) exec perl -e 'use POSIX; setpgid(0, 0); exec @ARGV' "$@" ;; *) exec "$@" ;; esac
EOF
  chmod +x "$FAKE/fakebin/setsid"
  ( PATH=$FAKE/fakebin:$PATH; PROOFLINE_BATCH_PGMETHOD=setsid; PROOFLINE_BATCH_MINUTE=3; export PATH PROOFLINE_BATCH_PGMETHOD PROOFLINE_BATCH_MINUTE; BB run > "$base/run.out" 2>&1 ) || :
  grep -q 'a session could not be started as the leader of its own process group (method setsid)' "$base/run.out" || die "no stop message: $(tail -4 "$base/run.out")"
  [ -z "$(calls)" ] || die "the session ran: $(calls)"
  [ "$(state_of T-1 2)" = pending ] || die "T-1 after the 125 stop: $(cat .agents/local/batch/state.tsv)"
  [ "$(state_of T-3 2)" = pending ] || die "the batch went on after the stop: $(cat .agents/local/batch/state.tsv)"
  grep -qx 'exit=125' .agents/local/batch/sessions/T-1.1.rec || die "record: $(cat .agents/local/batch/sessions/T-1.1.rec)"
  ok "a session that is not its own group leader exits 125: the batch stops with the method named, nothing ran, the task stays pending"
}

# --- 9c. (A161, #135) the morning report: sessions from records; an old state has none; a session without an end is said so -------
sc_session_records() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve
  printf 'merge\n' > "$FAKE/behave/T-1"; printf 'question\n' > "$FAKE/behave/T-2"
  BB run >/dev/null 2>&1 || :
  ls .agents/local/batch/sessions/T-1.1.rec .agents/local/batch/sessions/T-2.1.rec >/dev/null || die "no session records"
  BB status > "$base/st.out" || die "status failed"
  grep '^T-2 | 1 | claude | ' "$base/st.out" | grep -q '| 0 | question | ' || die "T-2 session row (exit 0, park reason question): $(grep '^T-2 |' "$base/st.out")"
  # a record without an end (a driver that was stopped)
  printf 'id=T-1\nn=2\nruntime=codex\nmethod=perl\nlog=.agents/local/batch/logs/T-1.log\nstart=1700000000\n' > .agents/local/batch/sessions/T-1.2.rec
  BB status > "$base/st.out"; grep '^T-1 | 2 | codex | ' "$base/st.out" | grep -q 'no end recorded' || die "no 'no end recorded' row: $(grep '^T-1 |' "$base/st.out")"
  # a state from before the records: no sessions section, the table still works
  rm -rf .agents/local/batch/sessions
  BB status > "$base/st.out" || die "status of an old state failed"
  grep -q '^sessions' "$base/st.out" && die "an old state shows a sessions section: $(cat "$base/st.out")"
  grep 'T-1' "$base/st.out" | grep -q 'merged' || die "the old state's table is gone: $(cat "$base/st.out")"
  ok "batch status: session rows from records (exit, park reason), 'no end recorded' for an open record, no sessions section for an old state"
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

# --- 9c. (A161) codex-cli floor: an explicit codex runtime refuses an old or unparsable version, a fallback is left out with one line ---
cv_plan() { # re-plan and approve the current fixture (T-1 merges)
  rm -rf .agents/local/batch .agents/runs/T-1; : > "$FAKE/codex.argv"; : > "$FAKE/calls.log"; printf 'merge\n' > "$FAKE/behave/T-1"
  BP all >/dev/null || die "batch-plan failed"; batch_approve
}
cv_run() { # VERSION: the driver run with PROOFLINE_CODEX_VERSION=VERSION (set, possibly empty); output in run.out
  cv_rc=0; ( PROOFLINE_CODEX_VERSION=$1; export PROOFLINE_CODEX_VERSION; BB run > "$base/run.out" 2>&1 ) || cv_rc=$?
}
sc_codex_version() {
  bnew; mktask T-1 COMPLEX; cfg_batch 40; cfg_extra '  runtimes: codex'; binstall
  cv_plan
  # refused for a runtime the configuration names: no session starts
  for v in 0.162.9 0.163.0-alpha.1 0.100.0; do
    cv_run "$v"
    [ "$cv_rc" != 0 ] && grep -q "^batch: codex-cli $v is below the minimum 0.163.0 the proofline_night profile was verified on; update Codex or use runtime claude" "$base/run.out" || die "batch.runtimes codex, version $v not refused as below: rc=$cv_rc $(cat "$base/run.out")"
    [ -z "$(calls)" ] && [ ! -s "$FAKE/codex.argv" ] || die "a session started on codex-cli $v"
  done
  for v in '' garbage 'codex-cli'; do
    cv_run "$v"
    [ "$cv_rc" != 0 ] && grep -q '^batch: codex --version gave no parsable version (minimum 0.163.0, ' "$base/run.out" || die "batch.runtimes codex, version '$v' not refused as unparsable: rc=$cv_rc $(cat "$base/run.out")"
    [ -z "$(calls)" ] || die "a session started with an unparsable codex version '$v'"
  done
  # accepted (a fresh approved plan each: a finished run leaves state behind)
  for v in 0.163.0 0.163.1 0.164.0-alpha.1 1.0.0; do
    cv_plan; cv_run "$v"
    [ "$cv_rc" = 0 ] && [ "$(calls)" = "T-1" ] && [ -s "$FAKE/codex.argv" ] || die "codex-cli $v refused or not run: rc=$cv_rc calls='$(calls)' $(cat "$base/run.out")"
    grep -q 'is below the minimum\|no parsable version' "$base/run.out" && die "codex-cli $v produced a refusal text: $(cat "$base/run.out")"
  done
  # the lead runtime codex (no batch.runtimes) is refused the same way
  bnew; mktask T-1 COMPLEX; cfg_batch 40; binstall; sed 's/^  lead: .*/  lead: codex/' .agents/config.yaml > .agents/config.tmp && mv .agents/config.tmp .agents/config.yaml
  git add -A; git commit -qm 'lead codex'; cv_plan; cv_run 0.162.9
  [ "$cv_rc" != 0 ] && grep -q '^batch: codex-cli 0.162.9 is below the minimum 0.163.0 ' "$base/run.out" && [ -z "$(calls)" ] || die "lead codex, 0.162.9 not refused: rc=$cv_rc $(cat "$base/run.out")"
  cv_plan; cv_run ''
  [ "$cv_rc" != 0 ] && grep -q '^batch: codex --version gave no parsable version' "$base/run.out" || die "lead codex, empty version not refused: rc=$cv_rc $(cat "$base/run.out")"
  # a fallback (claude lead, codex installed, claude hits its limit): codex is left out with one line on stderr, the batch goes on with claude only
  bnew; mktask T-1 COMPLEX; cfg_batch 40; binstall
  cv_plan; printf 'limit\n' > "$FAKE/behave/T-1"; cv_run 0.162.9
  [ "$(grep -c 'Codex is left out of this batch' "$base/run.out")" = 1 ] && grep -q '^batch: codex-cli 0.162.9 is below the minimum 0.163.0 the proofline_night profile was verified on: Codex is left out of this batch$' "$base/run.out" || die "fallback codex below the floor: no single left-out line: $(cat "$base/run.out")"
  [ ! -s "$FAKE/codex.argv" ] || die "a left-out codex was used as the fallback: $(cat "$FAKE/codex.argv")"
  cv_plan; printf 'limit\n' > "$FAKE/behave/T-1"; cv_run ''
  grep -q '^batch: codex --version gave no parsable version (minimum 0.163.0, .*): Codex is left out of this batch$' "$base/run.out" && [ ! -s "$FAKE/codex.argv" ] || die "fallback codex unparsable: $(cat "$base/run.out")"
  # an accepted version keeps the fallback: claude hits its limit, codex takes the task
  cv_plan; printf 'limit\n' > "$FAKE/behave/T-1"; cv_run 0.163.0
  grep -q 'left out' "$base/run.out" && die "an accepted codex was left out: $(cat "$base/run.out")"
  [ -s "$FAKE/codex.argv" ] || die "an accepted codex was not tried as the fallback after claude's limit: $(cat "$base/run.out")"
  ok "codex version floor: 0.162.9, 0.163.0-alpha.1, empty and garbage refused for batch.runtimes/lead codex; 0.163.0, 0.163.1, 0.164.0-alpha.1 accepted; a fallback below the floor is left out with one stderr line"
}

# summary: the verified package managers and the codex version line (A161)
sc_codex_summary_version() {
  bnew; mktask T-1 COMPLEX; cfg_batch 40; cfg_extra '  runtimes: codex'; binstall
  bp_v() { ( PROOFLINE_CODEX_VERSION=$1; export PROOFLINE_CODEX_VERSION; BP all >/dev/null 2>&1 ) || die "batch-plan failed with codex version '$1'"; }
  bp_v 0.163.0
  grep -q '^codex sandbox: proofline_night profile (.*verified for: npm, pnpm, yarn, pip, go; ' "$summary" || die "sandbox line: $(grep '^codex sandbox' "$summary")"
  grep -qx 'codex version: 0.163.0 (minimum 0.163.0)' "$summary" || die "version line (ok): $(grep '^codex version' "$summary")"
  bp_v 0.162.9
  grep -qx 'codex version: 0.162.9 (below the minimum 0.163.0; the driver refuses it)' "$summary" || die "version line (below): $(grep '^codex version' "$summary")"
  bp_v ''
  grep -q '^codex version: unknown (' "$summary" && grep -q 'minimum 0.163.0)' "$summary" || die "version line (unknown): $(grep '^codex version' "$summary")"
  # the version is part of what is approved: the summary hash differs between versions
  bp_v 0.164.0; [ "$(grep -c '^codex version: 0.164.0' "$summary")" = 1 ] || die "version not shown: $(grep '^codex version' "$summary")"
  # a claude-only batch (no codex runtime in the list) carries no codex lines
  bnew; mktask T-1 COMPLEX; cfg_batch 40; binstall no
  ( PATH=$(path_without codex); export PATH; BP all >/dev/null 2>&1 ) || die "batch-plan failed without codex"
  grep -q '^codex version:\|^WARNING' "$summary" && die "codex version or nesting lines in a claude-only batch: $(grep '^codex version\|^WARNING' "$summary")"
  ok "summary: the sandbox line names the verified package managers; the codex version line shows ok, below-minimum or unknown; no version line without a codex runtime"
}

# the package-manager caches go into the writable temp dir through shell_environment_policy.set, never into $HOME (A161)
sc_codex_pkg_env() {
  bnew; mktask T-1 COMPLEX; cfg_batch 40; cfg_extra '  runtimes: codex'; binstall
  mkdir -p "$base/tmp" "$base/home"
  cv_plan
  ( TMPDIR=$base/tmp; HOME=$base/home; export TMPDIR HOME; BB run > "$base/run.out" 2>&1 ) || :
  [ "$(calls)" = "T-1" ] || die "the codex session did not run: $(cat "$base/run.out")"
  argv=$(cat "$FAKE/codex.argv")
  pe=$(printf '%s\n' "$argv" | sed -n 's/.*-c shell_environment_policy\.set=\({[^}]*}\).*/\1/p')
  [ -n "$pe" ] || die "no shell_environment_policy.set in the codex argv: $argv"
  pkg=$base/tmp/proofline-pkg-$(id -u)
  case "$pe" in *"npm_config_cache=\"$pkg/npm\""*) ;; *) die "npm_config_cache is not under $pkg/npm: $pe" ;; esac
  [ -d "$pkg" ] || die "the cache folder $pkg was not created"
  for kv in $(printf '%s' "$pe" | tr -d '{}"' | tr ',' ' '); do
    case "$kv" in *=*) ;; *) continue ;; esac
    val=${kv#*=}
    case "$val" in "$base/home"*|'~'*|'$HOME'*) die "a cache variable points into \$HOME: $kv" ;; esac
    case "$kv" in npm_config_update_notifier=false) ;; *) case "$val" in "$pkg"/*) ;; *) die "a cache variable is not under $pkg: $kv" ;; esac ;; esac
  done
  for var in npm_config_store_dir YARN_CACHE_FOLDER YARN_GLOBAL_FOLDER PIP_CACHE_DIR GOCACHE GOPATH; do
    case "$pe" in *"$var="*) ;; *) die "$var missing from the environment policy: $pe" ;; esac
  done
  # the danger case runs without the sandbox profile and without the environment redirection
  cv_plan; BP all --codex-danger-full-access >/dev/null || die "batch-plan with the flag failed"; batch_approve
  ( TMPDIR=$base/tmp; HOME=$base/home; export TMPDIR HOME; BB run > "$base/run.out" 2>&1 ) || :
  grep -q -- '-s danger-full-access' "$FAKE/codex.argv" && ! grep -q 'shell_environment_policy' "$FAKE/codex.argv" || die "danger argv: $(cat "$FAKE/codex.argv")"
  ok "codex argv: shell_environment_policy.set puts npm/pnpm/yarn/pip/go caches under the proofline-pkg temp dir, none under \$HOME; absent with --codex-danger-full-access"
}

# --- 9e. (A161) plan-time WARNING: a Codex lead whose workers also run on Codex ------------------------------------------------------
wn_setup() { # LEAD WORKER [QA-RUNTIME]: the real exec-policy.sh (the fixture stubs it) and the runtime keys
  bnew; mktask T-1 COMPLEX; cfg_batch 40; binstall no; cp "$tl_agents/scripts/exec-policy.sh" .agents/scripts/exec-policy.sh
  sed "s/^  lead: .*/  lead: $1/; s/^  worker: .*/  worker: $2/" .agents/config.yaml > .agents/config.tmp && mv .agents/config.tmp .agents/config.yaml
  if [ -n "${3:-}" ]; then awk -v r="    qa: $3" '{ print } /^  roles:/ { print r }' .agents/config.yaml > .agents/config.tmp && mv .agents/config.tmp .agents/config.yaml; fi
}
path_without() { # CMD: a PATH where CMD is not found. A directory that holds CMD is replaced by a folder of symlinks to its other tools,
  # so a machine with a real codex installed (next to git, sh, ...) does not leak it into the test.
  pw_o=''; pw_ifs=$IFS; IFS=:; for pw_d in $PATH; do
    if [ -x "$pw_d/$1" ]; then
      pw_n=$base/nocmd-$(printf '%s' "$pw_d" | tr -c 'A-Za-z0-9' _); mkdir -p "$pw_n"
      for pw_f in "$pw_d"/*; do [ -x "$pw_f" ] && [ "${pw_f##*/}" != "$1" ] && ln -sf "$pw_f" "$pw_n/${pw_f##*/}" || :; done
      pw_o="$pw_o:$pw_n"
    else pw_o="$pw_o:$pw_d"; fi
  done; IFS=$pw_ifs; printf '%s\n' "${pw_o#:}"
}
sc_codex_lead_warning() {
  wn_setup codex codex; BP all > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q '^WARNING: the lead runs on Codex and these roles also run on Codex: task_author explorer architect data_architect designer implementer\. ' "$summary" || die "codex lead + codex worker: $(grep -i 'WARNING' "$summary")"
  sed -n 's/^WARNING: the lead runs on Codex and these roles also run on Codex:\([^.]*\)\..*/\1/p' "$summary" | grep -Eq '(^| )(qa|reviewer|security_reviewer|verifier)( |$)' && die "claude roles listed: $(grep '^WARNING' "$summary")"
  wn_setup codex claude codex; BP all > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q '^WARNING: the lead runs on Codex and these roles also run on Codex: qa\. ' "$summary" || die "only roles.qa codex: $(sed -n 12,18p .agents/config.yaml) / $(tail -3 "$base/p.out")"
  BP all --codex-danger-full-access > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q 'the lead runs on Codex' "$summary" && die "the nesting warning shows with --codex-danger-full-access"
  grep -q '^WARNING: you chose --codex-danger-full-access' "$summary" || die "danger warning gone: $(grep WARNING "$summary")"
  wn_setup codex claude; BP all > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q '^WARNING' "$summary" && die "a codex lead with only claude roles got a warning: $(grep WARNING "$summary")"
  # A161 (maintainer-approved change): a claude lead with Codex on PATH as the fallback runtime and Codex workers now DOES get the warning
  wn_setup claude codex; BP all > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q '^WARNING: a lead session can run on Codex (runtimes tried, in order: claude codex) and these roles also run on Codex: task_author explorer ' "$summary" || die "claude lead + codex fallback + codex workers: $(grep -i 'WARNING' "$summary")"
  grep -q 'the lead runs on Codex' "$summary" && die "a claude lead's warning says the lead runs on Codex: $(grep WARNING "$summary")"
  # codex not installed and no codex runtime in rt_list: no warning
  wn_setup claude codex; wn_rc=0; ( PATH=$(path_without codex); export PATH; BP all > "$base/p.out" 2>&1 ) || wn_rc=$?
  [ "$wn_rc" = 0 ] || die "plan refused without codex installed: $(cat "$base/p.out")"
  grep -q '^WARNING' "$summary" && die "no codex installed and no codex runtime, yet a warning: $(grep WARNING "$summary")"
  grep -q '^codex version:' "$summary" && die "a codex version line without a codex runtime"
  # the danger flag removes it
  wn_setup claude codex; BP all --codex-danger-full-access > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q 'a lead session can run on Codex' "$summary" && die "the nesting warning shows with --codex-danger-full-access on a claude lead"
  # a claude lead whose batch.runtimes names codex: the same wording, runtimes in the configured order
  wn_setup claude codex; cfg_extra '  runtimes: claude codex'; BP all > "$base/p.out" 2>&1 || die "plan refused: $(cat "$base/p.out")"
  grep -q '^WARNING: a lead session can run on Codex (runtimes tried, in order: claude codex) and ' "$summary" || die "batch.runtimes claude codex: $(grep WARNING "$summary")"
  ok "plan WARNING: codex lead + codex workers (roles listed), only roles.qa codex lists qa; a claude lead with codex as fallback warns (new wording); none without codex installed or with --codex-danger-full-access; all-claude roles none"
}

# --- 10. (A160) the CI that gates the next task is the one of the merge commit ---------------------------------------------------
ci_setup() {
  bnew; mktask T-1 COMPLEX; mktask T-2 COMPLEX; cfg_batch 40; cfg_extra '  ci_appear_minutes: 1'; binstall
  BP all >/dev/null || die "batch-plan failed"; batch_approve; printf 'merge\n' > "$FAKE/behave/T-1"; printf 'merge\n' > "$FAKE/behave/T-2"; rm -f "$FAKE/ci"/*
}
ci_run() { ( PROOFLINE_BATCH_MINUTE=1; export PROOFLINE_BATCH_MINUTE; BB run > "$base/run.out" 2>&1 ) || :; }
sc_merge_commit_ci() {
  # an old green run on main exists (the fake answers green to any query that is not about the merge commit); the merge commit's run is red
  ci_setup; printf '[{"status":"completed","conclusion":"failure"}]\n' > "$FAKE/ci/$MSHA"; ci_run
  [ "$(calls)" = "T-1" ] || die "a red run of the merge commit did not stop the batch: '$(calls)'; $(tail -3 "$base/run.out")"
  grep -q '^# stopped: main CI is red (run of 0123456)' .agents/local/batch/state.tsv || die "stop reason: $(tail -2 .agents/local/batch/state.tsv)"
  [ "$(state_of T-2 2)" = pending ] || die "T-2 after the stop: $(state_of T-2 2)"
  # a running run next to a red one is red
  ci_setup; printf '[{"status":"in_progress","conclusion":""},{"status":"completed","conclusion":"failure"}]\n' > "$FAKE/ci/$MSHA"; ci_run
  [ "$(calls)" = "T-1" ] || die "red + running did not stop the batch: '$(calls)'"
  # no run for the merge commit appears within ci_appear_minutes
  ci_setup; : > "$FAKE/ci/$MSHA.none"; ci_run
  [ "$(calls)" = "T-1" ] || die "no run for the merge commit did not stop the batch: '$(calls)'; $(tail -3 "$base/run.out")"
  grep -q '^# stopped: no CI run appeared for 0123456' .agents/local/batch/state.tsv || die "stop reason: $(tail -2 .agents/local/batch/state.tsv)"
  # a green run for the merge commit lets the batch go on
  ci_setup; printf '[{"status":"completed","conclusion":"success"}]\n' > "$FAKE/ci/$MSHA"; ci_run
  [ "$(calls)" = "T-1 T-2" ] && [ "$(state_of T-2 2)" = merged ] || die "a green run of the merge commit stopped the batch: '$(calls)'; $(tail -3 "$base/run.out")"
  ok "merge-commit CI: red run of the SHA stops (an old green main run does not count), no run in ci_appear_minutes stops, green run continues"
}

run_sc sc_order_and_cycle
run_sc sc_no_approval_no_start
run_sc sc_cover_limits
run_sc sc_mutation_cap
run_sc sc_cover_delivery
run_sc sc_critical_excluded
run_sc sc_late_critical
run_sc sc_park_skip_continue
run_sc sc_lock
run_sc sc_status_from_records
run_sc sc_stale_log
run_sc sc_task_timeout
run_sc sc_codex_sandbox
run_sc sc_codex_sandbox_tamper
run_sc sc_codex_version
run_sc sc_codex_summary_version
run_sc sc_codex_pkg_env
run_sc sc_pgroup_method setm
run_sc sc_pgroup_method setsid
run_sc sc_pgroup_method perl
run_sc sc_pgroup_method python
run_sc sc_pgroup_refuse
run_sc sc_pgroup_not_leader
run_sc sc_session_records
run_sc sc_adapter_refused
run_sc sc_codex_lead_warning
run_sc sc_merge_commit_ci
echo 'batch tests passed'
