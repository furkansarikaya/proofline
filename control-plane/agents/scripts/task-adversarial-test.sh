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
# Review B1: every token of a scope bullet counts, a token that is no path refuses the freeze, a heading with trailing text and any case is read.
sc_scope_tokens() {
  scaffold standalone no TRIVIAL manual
  t=.agents/runs/LC/TASK.md; cp "$t" "$base/task.orig"
  for forb in '`other/x.js`, `impl.txt`' 'other/x.js, impl.txt' '`other/` and `impl.txt`' '`other/` `impl_test.txt`'; do
    cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- %s\n' "$forb" >> "$t"
    expect_msg "Forbidden scope [$forb] dropped its second entry" "inside the task's Forbidden scope" A freeze LC
  done
  for head in '## Forbidden scope (do not touch)' '## FORBIDDEN SCOPE' '### forbidden scope - legacy'; do
    cp "$base/task.orig" "$t"; printf '\n%s\n\n- `impl.txt`\n' "$head" >> "$t"
    expect_msg "the heading [$head] was not recognised" "inside the task's Forbidden scope" A freeze LC
  done
  cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\r\n\r\n- `impl.txt`\r\n' >> "$t"
  expect_msg "a CRLF Forbidden scope was not applied" "inside the task's Forbidden scope" A freeze LC
  for sec in 'Forbidden scope' 'Allowed scope' 'Existing pattern references'; do
    for bad in '- Do not modify the billing module' 'keep away from impl.txt please' '- `src/ and more`'; do
      cp "$base/task.orig" "$t"; printf '\n## %s\n\n%s\n' "$sec" "$bad" >> "$t"
      expect_msg "[$sec: $bad] was read as an entry" "is not a path or glob" A freeze LC
    done
  done
  cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- `src/{a,b}.js`\n' >> "$t"
  expect_msg "a brace group was read as one path" '"src/{a"' A freeze LC
  cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- `src/foo.js:`\n- src/bar.js:\n' >> "$t"
  [ "$(A task-scope-entries "$t" 'Forbidden scope' | tr '\n' ' ')" = 'src/foo.js src/bar.js ' ] || die "a trailing colon was not stripped: $(A task-scope-entries "$t" 'Forbidden scope')"
  cp "$base/task.orig" "$t"; printf '\n## Forbidden scope\n\n- Do not modify the billing module\n' >> "$t"
  A freeze LC 2>&1 | grep -F '"Do"' >/dev/null || die "the refusal does not name the token Do"
  [ "$(A task-scope-entries "$t" 'Forbidden scope')" = "" ] || die "a prose bullet produced entries"
  cp "$base/task.orig" "$t"
  ok "A202 review B1: all tokens of a scope bullet are read, a non-path token refuses the freeze"
}
# Review B2: an unreadable task type is refused (never read as a feature); CRLF front matter and a trailing comment are read.
sc_type_unreadable() {
  scaffold standalone no STANDARD manual
  t=.agents/runs/LC/TASK.md; cp "$t" "$base/task.orig"
  for ty in bugfix hotfix 'bug fix' Bug2; do
    awk -v ty="$ty" 'NR == 2 { print "---"; print "type: " ty; print "---" } { print }' "$base/task.orig" > "$t"
    [ "$(A task-type "$t")" = invalid ] || die "type: $ty was not invalid: $(A task-type "$t")"
    expect_msg "classify accepted type: $ty" "cannot be read" A classify LC TRIVIAL
    expect_msg "freeze accepted type: $ty" "cannot be read" A freeze LC
  done
  awk 'NR == 2 { print "---"; print "type: bug"; print "type: chore"; print "---" } { print }' "$base/task.orig" > "$t"
  [ "$(A task-type "$t")" = invalid ] || die "a duplicate type: line was not invalid"
  expect_msg "classify accepted two type: lines" "cannot be read" A classify LC TRIVIAL
  awk 'NR == 2 { print "---"; print "type: bug # a note"; print "---" } { print }' "$base/task.orig" > "$t"
  [ "$(A task-type "$t")" = bug ] || die "type: bug # note was not read as bug"
  expect_msg "TRIVIAL accepted for type: bug # note" "typed bug" A classify LC TRIVIAL
  awk 'NR == 2 { print "---"; print "type: bug"; print "---" } { print }' "$base/task.orig" | sed 's/$/\r/' > "$t"
  [ "$(A task-type "$t")" = bug ] || die "CRLF front matter was not read as bug: $(A task-type "$t")"
  expect_msg "TRIVIAL accepted for CRLF type: bug" "typed bug" A classify LC TRIVIAL
  cp "$base/task.orig" "$t"
  ok "A202 review B2: an unreadable type is refused, CRLF and a trailing comment are read"
}
# Review B3: the run copy of TASK.md must say what the task file says about type and boundaries before the first freeze.
sc_run_copy_vs_source() {
  scaffold standalone no STANDARD manual
  t=.agents/runs/LC/TASK.md
  printf '# Task: LC \xe2\x80\x94 lookup\n\n---\ntype: bug\n---\n\n## Acceptance criteria\n\n- AC-1: lookup behavior\n\n## Forbidden scope\n\n- `other/x.js`\n' > tasks/LC.md
  cp tasks/LC.md "$base/src.task"
  sed 's/^type: bug$/type: chore/' "$base/src.task" > "$t"
  expect_msg "a retyped run copy froze" "says type chore but the task file" A freeze LC
  sed '/^## Forbidden scope/,$d' "$base/src.task" > "$t"
  expect_msg "a run copy without the Forbidden scope froze" "differs from the task file" A freeze LC
  sed 's|other/x.js|other/y.js|' "$base/src.task" > "$t"
  expect_msg "a run copy with another Forbidden entry froze" "differs from the task file" A freeze LC
  cp "$base/src.task" "$t"; fo=$(A freeze LC 2>&1 || :)
  printf '%s' "$fo" | grep -Fq 'differs from the task file' && die "an identical run copy was refused as different: $fo"
  printf '%s' "$fo" | grep -Fq 'says type' && die "an identical run copy was refused on its type: $fo"
  ok "A202 review B3: the run copy is compared with the task file before the first freeze"
}
run_sc sc_type_relabel_after_freeze
run_sc sc_scope_tokens
run_sc sc_type_unreadable
run_sc sc_run_copy_vs_source
run_sc sc_forbidden_paths
echo 'task adversarial tests passed'
