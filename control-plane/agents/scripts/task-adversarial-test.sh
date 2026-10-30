#!/bin/sh
# shellcheck disable=SC2015,SC2154,SC2016,SC2329 # test code: assertion chains; base comes from test-lib.sh
# Adversarial cases of the task model (A202), through the real agent.sh: relabelling the task type, and path tricks against Forbidden scope.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# An agent that retypes a bug (in the run's TASK.md) after the freeze makes the run stale: the type is part of the hashed contract.
sc_type_relabel_after_freeze() {
  SC_TASK_FM='type: bug' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  sed -i.bak 's/^type: bug$/type: chore/' .agents/runs/LC/TASK.md; rm -f .agents/runs/LC/TASK.md.bak
  [ "$(A task-type .agents/runs/LC/TASK.md)" = chore ] || die "the relabel did not take effect in the fixture"
  expect_fail "a bug relabelled chore after the freeze reached IMPLEMENTED" A handoff LC IMPLEMENTED
  ok "A202 adversarial: retyping a bug after the freeze is refused (the type is inside the frozen contract)"
}
# Forbidden scope with path tricks: the plan path is compared after normalisation.
sc_forbidden_paths() {
  scaffold standalone no TRIVIAL manual
  t=.agents/runs/LC/TASK.md; cp "$t" "$base/task.orig"; cp .agents/runs/LC/PLAN.md "$base/plan.orig"
  for forb in '`./impl.txt`' '`impl.txt/`' '`sub/../impl.txt`' '`IMPL.TXT`' '`/impl.txt`' '`impl.txt `'; do
    cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- %s\n' "$forb" >> "$t"
    expect_msg "Forbidden scope $forb was not applied to impl.txt" "Forbidden scope" A freeze LC
  done
  cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- `impl.txt`\n' >> "$t"
  for pp in './impl.txt' 'sub/../impl.txt' 'IMPL.txt'; do
    sed "s|path: impl.txt|path: $pp|" "$base/plan.orig" > .agents/runs/LC/PLAN.md
    rc=0; A freeze LC >/dev/null 2>&1 || rc=$?
    [ "$rc" != 0 ] || die "A202 GAP: the plan path $pp walked around the Forbidden scope entry impl.txt"
  done
  cp "$base/task.orig" "$t"; cp "$base/plan.orig" .agents/runs/LC/PLAN.md
  ok "A202 adversarial: Forbidden scope holds against ./, ../, a trailing slash, a leading slash and case"
}
run_sc sc_type_relabel_after_freeze
run_sc sc_forbidden_paths
echo 'task adversarial tests passed'
