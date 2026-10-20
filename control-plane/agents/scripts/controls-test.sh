#!/bin/sh
# shellcheck disable=SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code
# Layer tests ported from the source agent.sh self-tests: the base state machine (freeze, freshness, scope,
# handoff, delivery), the implementer role boundary, worker evidence and TDD under both topologies, the
# fail-closed evidence write, the knowledge-transaction scope at DONE/delivery-check/validate and task
# branch isolation. Runs omit `lifecycle_gates` here to test one layer at a time.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# layer_run ID SCOPE-PATH... : a run directory with a RUN.yaml of the base layer; extra blocks via $EXTRA.
layer_run() {
  lr_id=$1; shift; d=.agents/runs/$lr_id; mkdir -p "$d"; printf '%s\n' "$lr_id" > .agents/local/ACTIVE_RUN
  printf '# Task: %s\n\n## Acceptance criteria\n\n- AC-1: behaviour\n' "$lr_id" > "$d/TASK.md"; printf '%s\n' '# Evidence' '' '## Assumptions' 'none' '' '## Claims' > "$d/EVIDENCE.md"
  { printf '%s\n' '---' 'scope:'; for lr_p in "$@"; do printf '  - path: %s\n    criteria: [AC-1]\n' "$lr_p"; done; printf '%s\n' "${PLAN_EXTRA:-}" '---' '# Plan' '## Assumptions' 'none' '## Behavior' 'unchanged'; } | sed '/^$/d' > "$d/PLAN.md"
  printf '%s\n' 'task:' "  id: $lr_id" 'repository:' '  base_sha: PENDING' "${REPO_EXTRA:-}" 'task_source:' "${SOURCE:-  type: none}" "${SOURCE_REV:-  revision: not_applicable}" \
    'execution:' '  mode: deterministic' '  state: PLANNING' '  knowledge_state: not_started' '  knowledge_reason: ""' "  topology: ${TOPO:-orchestrated}" \
    'freeze:' '  task_sha256: PENDING' '  evidence_sha256: PENDING' '  plan_sha256: PENDING' '  policy_sha256: PENDING' \
    'baseline:' '  status: pending' 'handoff:' '  state: PLANNED' '  implemented_patch_sha256: PENDING' '  code_done_patch_sha256: PENDING' \
    "${EXTRA:-}" | sed '/^$/d' > "$d/RUN.yaml"
}
POLICY_KEYS='worker_evidence:
  required: true
tdd:
  required: true
completion_report:
  required: true
  adapter: PENDING
  published: false
  receipt: PENDING'
report() {
  printf '%s\n' "# Completion Report: $1" '' '## Implementation Summary' 'impl.txt gained Find(); config.txt is a constant, TDD-exempt.' '' \
    '## TDD Evidence' 'RED failed for the expected reason; GREEN passed.' '' '## Verification' 'go test ./... passed.' '' '## Assumptions' 'none' '' '## Known Limitations / Follow-up' 'None.' > ".agents/runs/$1/COMPLETION_REPORT.md"
}
ev() { # ROLE ID PHASE RESULT TARGET
  ev_ef=''; [ "$3" = RED ] && ev_ef='expected_failure: TestImpl fails: Find() does not exist yet, specifically'
  printf 'command: go test ./...\ntarget: %s\n%s\n' "$5" "$ev_ef" | AGENT_ROLE=$1 sh ./.agents/scripts/agent.sh worker-evidence "$2" "$3" "$4"
}

# The base state machine: baseline, scope, freeze, freshness, handoff, delivery-check, artifacts, status.
sc_base() {
  new_repo; mkdir -p tasks; SOURCE='  type: local_markdown
  path: tasks/FIX.md' SOURCE_REV='  revision: PENDING' layer_run FIX authorized.txt
  : > authorized.txt; : > user-dirty.txt; printf '# canonical task\n' > tasks/FIX.md; git add -A; git commit -qm baseline
  printf 'user work\n' > user-dirty.txt; : > user-untracked.txt
  A baseline FIX >/dev/null; printf 'discovered\n' >> .agents/runs/FIX/EVIDENCE.md; printf 'planned\n' >> .agents/runs/FIX/PLAN.md
  A verify-scope FIX >/dev/null; A freeze FIX >/dev/null; A verify-freeze FIX >/dev/null; A freshness FIX >/dev/null
  expect_fail "IMPLEMENTED straight from PLANNED" A handoff FIX IMPLEMENTED
  cp tasks/FIX.md "$base/src.orig"; printf 'changed source\n' >> tasks/FIX.md
  expect_fail "freshness with a changed task source" A freshness FIX
  cp "$base/src.orig" tasks/FIX.md
  cp .agents/runs/FIX/RUN.yaml "$base/run.orig"; sed 's#path: tasks/FIX.md#path: ../outside.md#' "$base/run.orig" > .agents/runs/FIX/RUN.yaml
  expect_fail "a task source outside the repository" A freshness FIX
  cp "$base/run.orig" .agents/runs/FIX/RUN.yaml
  printf 'changed contract\n' >> .agents/runs/FIX/TASK.md; expect_fail "verify-freeze with an edited TASK.md" A verify-freeze FIX
  sed '$d' .agents/runs/FIX/TASK.md > "$base/t"; cp "$base/t" .agents/runs/FIX/TASK.md
  printf '\n# changed\n' >> .agents/modes/deterministic.yaml; expect_fail "verify-freeze with an edited mode policy" A verify-freeze FIX
  sed '$d' .agents/modes/deterministic.yaml | sed '$d' > "$base/m"; cp "$base/m" .agents/modes/deterministic.yaml; A verify-freeze FIX >/dev/null
  A handoff FIX IMPLEMENTING >/dev/null
  expect_fail "CODE_DONE from IMPLEMENTING" A handoff FIX CODE_DONE
  printf 'agent touched dirty path\n' >> user-dirty.txt; expect_fail "a change to a user-dirty file" A verify-scope FIX
  printf 'user work\n' > user-dirty.txt
  printf 'x\n' >> user-untracked.txt; expect_fail "a change to a user-untracked file" A verify-scope FIX
  : > user-untracked.txt
  printf 'change\n' > authorized.txt; A verify-scope FIX >/dev/null
  printf 'unexpected\n' > unexpected.txt; expect_fail "an unmapped path" A verify-scope FIX; rm unexpected.txt
  printf 'random\n' > .agents/runs/FIX/random.txt; expect_fail "an unknown run file" A validate FIX; rm .agents/runs/FIX/random.txt
  A handoff FIX IMPLEMENTED >/dev/null; A verify-handoff FIX >/dev/null
  printf 'again\n' >> authorized.txt
  expect_fail "CODE_DONE on content changed after IMPLEMENTED" A handoff FIX CODE_DONE
  expect_fail "verify-handoff on stale content" A verify-handoff FIX
  A handoff FIX IMPLEMENTED >/dev/null; A handoff FIX CODE_DONE >/dev/null
  expect_fail "delivery-check before the knowledge step" A delivery-check FIX
  A knowledge-done FIX not_applicable "nothing durable changed in this synthetic test run" >/dev/null; A delivery-check FIX >/dev/null
  printf 'post-review\n' >> authorized.txt; expect_fail "delivery-check after a post-review edit" A delivery-check FIX
  printf 'MISSING\n' > .agents/local/ACTIVE_RUN; expect_fail "status with a dangling selector" A status
  : > .agents/local/ACTIVE_RUN; A status | grep -Fxq 'active_task=none'
  rm .agents/local/ACTIVE_RUN; A status | grep -Fxq 'active_task=none'
  ok "base state machine"
}

# The implementer (alias implementation_worker) cannot drive the lifecycle.
sc_roles() {
  new_repo; layer_run ROLE authorized.txt; : > authorized.txt; git add -A; git commit -qm baseline
  A role | grep -Fxq 'role=lead'; AGENT_ROLE=full_lifecycle sh ./.agents/scripts/agent.sh role | grep -Fxq 'role=lead'
  AGENT_ROLE=implementation_worker sh ./.agents/scripts/agent.sh role | grep -Fxq 'role=implementer'
  expect_fail "an unknown role" env AGENT_ROLE=wizard sh ./.agents/scripts/agent.sh role
  A baseline ROLE >/dev/null; A freeze ROLE >/dev/null; printf 'implementation\n' >> authorized.txt
  AS implementer verify-scope ROLE >/dev/null; AS implementation_worker handoff ROLE IMPLEMENTING >/dev/null
  for c in "handoff ROLE IMPLEMENTED" "handoff ROLE CODE_DONE" "freeze ROLE" "refreeze ROLE 001.md" "delivery-check ROLE" "baseline ROLE" "branch ROLE" "decide ROLE implementer" "secret-scan ROLE"; do
    # shellcheck disable=SC2086
    expect_fail "implementer ran: $c" AS implementer $c
  done
  A handoff ROLE IMPLEMENTED >/dev/null
  printf 'unplanned\n' > unplanned.txt; expect_fail "unplanned path" AS implementer verify-scope ROLE
  ok "implementer role boundary"
}

# Orchestrated worker evidence and TDD; DONE needs a published completion report and a knowledge state.
sc_policy() {
  new_repo; mkdir -p tasks
  SOURCE='  type: local_markdown
  path: tasks/POLICY.md' SOURCE_REV='  revision: PENDING' EXTRA=$POLICY_KEYS PLAN_EXTRA='    tdd_exemption: "control-plane configuration constant with no executable behavior to test"' layer_run POLICY impl.txt config.txt
  printf '# POLICY task\n' > tasks/POLICY.md; : > impl.txt; : > config.txt; git add -A; git commit -qm baseline
  A baseline POLICY >/dev/null; printf 'planned\n' >> .agents/runs/POLICY/PLAN.md; A freeze POLICY >/dev/null; A handoff POLICY IMPLEMENTING >/dev/null
  printf 'implemented directly by the lead\n' > impl.txt
  expect_fail "the lead bypassed the worker" A handoff POLICY IMPLEMENTED
  git checkout -q -- impl.txt
  expect_fail "the lead recorded worker evidence under orchestrated" ev lead POLICY GREEN pass impl.txt
  expect_fail "out-of-scope worker evidence" ev implementer POLICY GREEN pass out-of-scope.txt
  expect_fail "GREEN with result fail" ev implementer POLICY GREEN fail impl.txt
  printf 'command: x\ntarget: impl.txt\nexpected_failure: configuration change\n' > "$base/ev"
  expect_fail "RED with a stock expected_failure" sh -c "AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh worker-evidence POLICY RED fail < '$base/ev'"
  expect_fail "GREEN recorded before any RED (A97)" ev implementer POLICY GREEN pass impl.txt
  expect_fail "IMPLEMENTED with no evidence at all" A handoff POLICY IMPLEMENTED
  ev implementation_worker POLICY RED fail impl.txt >/dev/null
  expect_fail "GREEN with no implementation change since RED (A97)" ev implementer POLICY GREEN pass impl.txt
  printf 'implemented\n' >> impl.txt; ev implementer POLICY GREEN pass impl.txt >/dev/null
  A handoff POLICY IMPLEMENTED >/dev/null
  cp .agents/runs/POLICY/worker-evidence/GREEN-1.yaml "$base/g"
  sed 's/^plan_sha256: .*/plan_sha256: "00"/' "$base/g" > .agents/runs/POLICY/worker-evidence/GREEN-1.yaml
  expect_fail "stale worker evidence counted" A verify-worker-evidence POLICY
  cp "$base/g" .agents/runs/POLICY/worker-evidence/GREEN-1.yaml
  A handoff POLICY CODE_DONE >/dev/null
  expect_fail "DONE before the completion report" A handoff POLICY DONE
  expect_fail "publish without a report" A publish-completion-report POLICY markdown
  report POLICY; A publish-completion-report POLICY markdown >/dev/null
  expect_fail "DONE before knowledge-done" A handoff POLICY DONE
  A knowledge-done POLICY not_applicable "nothing durable changed in this synthetic test run" >/dev/null; A handoff POLICY DONE >/dev/null
  sed 's/impl.txt gained.*/tampered/' tasks/POLICY.md > "$base/t"; cp "$base/t" tasks/POLICY.md
  expect_fail "a tampered published report verified" A verify-completion-report POLICY
  ok "orchestrated worker evidence, TDD exemption, completion report"
}

# Standalone: the lead implements and records its own evidence; the implementer role is the wrong owner.
sc_standalone() {
  new_repo; TOPO=standalone EXTRA=$POLICY_KEYS layer_run SOLO impl.txt; : > impl.txt; git add -A; git commit -qm baseline
  A baseline SOLO >/dev/null; A freeze SOLO >/dev/null; A handoff SOLO IMPLEMENTING >/dev/null
  expect_fail "implementer evidence under standalone" ev implementer SOLO RED fail impl.txt
  printf 'implemented by the lead\n' > impl.txt
  expect_fail "standalone IMPLEMENTED without evidence" A handoff SOLO IMPLEMENTED
  ev lead SOLO RED fail impl.txt >/dev/null
  expect_fail "standalone IMPLEMENTED with RED only" A handoff SOLO IMPLEMENTED
  printf 'implemented\n' >> impl.txt; ev lead SOLO GREEN pass impl.txt >/dev/null
  grep -Fq 'role: "lead"' .agents/runs/SOLO/worker-evidence/RED-1.yaml
  A handoff SOLO IMPLEMENTED >/dev/null; A handoff SOLO CODE_DONE >/dev/null
  ok "standalone topology"
}

# A denied evidence write fails closed and leaves nothing behind.
sc_write_failure() {
  new_repo; EXTRA=$POLICY_KEYS layer_run WF impl.txt; : > impl.txt; git add -A; git commit -qm baseline
  A baseline WF >/dev/null; A freeze WF >/dev/null; A handoff WF IMPLEMENTING >/dev/null
  mkdir -p .agents/runs/WF/worker-evidence; chmod 555 .agents/runs/WF/worker-evidence
  if out=$(ev implementer WF RED fail impl.txt 2>&1); then chmod 755 .agents/runs/WF/worker-evidence; die "a denied evidence write succeeded"; fi
  chmod 755 .agents/runs/WF/worker-evidence
  printf '%s' "$out" | grep -qi 'worker evidence' || die "failure message: $out"
  [ -z "$(ls -A .agents/runs/WF/worker-evidence)" ] || die "a partial evidence file was left"
  ev implementer WF RED fail impl.txt >/dev/null; [ -s .agents/runs/WF/worker-evidence/RED-1.yaml ]
  ok "worker evidence write fails closed"
}

# Knowledge transaction scope at DONE, delivery-check and validate.
sc_knowledge() {
  new_repo; mkdir -p tasks docs/design
  SOURCE='  type: local_markdown
  path: tasks/K.md' SOURCE_REV='  revision: PENDING' EXTRA=$POLICY_KEYS layer_run K impl.txt
  printf '# K task\n' > tasks/K.md; : > impl.txt; printf '# Architecture\n' > docs/design/ARCHITECTURE.md; git add -A; git commit -qm baseline
  A baseline K >/dev/null; A freeze K >/dev/null; A handoff K IMPLEMENTING >/dev/null
  ev implementer K RED fail impl.txt >/dev/null; printf 'implemented\n' > impl.txt; ev implementer K GREEN pass impl.txt >/dev/null
  A handoff K IMPLEMENTED >/dev/null; A handoff K CODE_DONE >/dev/null
  report K; A publish-completion-report K markdown >/dev/null; A validate K >/dev/null; expect_fail "delivery-check before knowledge-done" A delivery-check K
  printf 'rogue\n' > rogue.txt
  expect_fail "DONE with an unmapped application path" A handoff K DONE
  expect_fail "validate with an unmapped application path" A validate K
  rm rogue.txt
  printf 'new component\n' >> docs/design/ARCHITECTURE.md
  expect_fail "DONE with a knowledge write and no transaction" A handoff K DONE
  expect_fail "delivery-check with a knowledge write and no transaction" A delivery-check K
  A knowledge-done K not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  expect_fail "DONE with not_applicable and a real knowledge write" A handoff K DONE
  expect_fail "validate with not_applicable and a real knowledge write" A validate K
  A knowledge-done K KNOWLEDGE_DONE >/dev/null; A verify-knowledge-scope K >/dev/null
  A validate K >/dev/null; A handoff K DONE >/dev/null; A delivery-check K >/dev/null; A validate K >/dev/null
  git checkout -q -- docs/design/ARCHITECTURE.md
  expect_fail "KNOWLEDGE_DONE with zero knowledge writes" A handoff K DONE
  expect_fail "delivery-check with KNOWLEDGE_DONE and zero writes" A delivery-check K
  ok "knowledge transaction scope"
}

# Task branch isolation: <git.branch_prefix><ID>-<slug> from the canonical tip; every phase on that branch.
sc_branch() {
  new_repo; mkdir -p tasks
  SOURCE='  type: local_markdown
  path: tasks/BR-sample-feature.md' SOURCE_REV='  revision: PENDING' REPO_EXTRA='  canonical_branch: PENDING
  task_branch: PENDING' layer_run BR authorized.txt
  : > authorized.txt; printf '# sample feature\n' > tasks/BR-sample-feature.md; git add -A; git commit -qm baseline
  tip=$(git rev-parse HEAD)
  expect_fail "baseline before branch" A baseline BR
  expect_fail "implementer created the branch" AS implementer branch BR
  A branch BR >/dev/null
  [ "$(git branch --show-current)" = proofline/BR-sample-feature ] && [ "$(git rev-parse proofline/BR-sample-feature)" = "$tip" ]
  A branch BR >/dev/null; [ "$(git branch --list 'proofline/BR-*' | wc -l | tr -d ' ')" = 1 ]
  A baseline BR >/dev/null; A freeze BR >/dev/null; A handoff BR IMPLEMENTING >/dev/null
  git checkout -q main; expect_fail "handoff on the canonical branch" A handoff BR IMPLEMENTED
  git checkout -q --detach "$tip"; expect_fail "handoff on a detached HEAD" A handoff BR IMPLEMENTED
  git checkout -q -b random-feature; expect_fail "handoff on another branch" A handoff BR IMPLEMENTED
  git checkout -q proofline/BR-sample-feature; git branch -D random-feature >/dev/null
  A handoff BR IMPLEMENTED >/dev/null; A handoff BR CODE_DONE >/dev/null; A knowledge-done BR not_applicable "nothing durable changed in this synthetic test run" >/dev/null; A delivery-check BR >/dev/null
  # an existing same-named branch at another tip is never reused or overwritten
  new_repo; REPO_EXTRA='  canonical_branch: PENDING
  task_branch: PENDING' layer_run CF tracked.txt
  printf 'v1\n' > tracked.txt; git add -A; git commit -qm base; b=$(git rev-parse HEAD)
  git branch proofline/CF-run "$b"; printf 'v2\n' > tracked.txt; git add tracked.txt; git commit -qm advance
  expect_fail "a conflicting branch was reused" A branch CF
  [ "$(git rev-parse proofline/CF-run)" = "$b" ] && [ "$(git branch --show-current)" = main ]
  ok "task branch isolation"
}

run_sc sc_base
run_sc sc_roles
run_sc sc_policy
run_sc sc_standalone
run_sc sc_write_failure
run_sc sc_knowledge
run_sc sc_branch
echo 'control-plane layer tests passed'
