#!/bin/sh
# shellcheck disable=SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: assertion chains
# Self-tests of the risk-adaptive pipeline (A78): every signal -> check mapping, the missing-flag FAIL, the
# focus results a gate needs, UNSUPPORTED (never a PASS; reported, A98), frozen flags and the frozen mapping.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# snap: one `pipeline` per state; has/hasnt/pv read the snapshot.
snap() { PO=$(A pipeline "$RID"); }
pv() { printf '%s\n' "$PO" | sed -n "s/^$1=//p"; }
has() { printf '%s\n' "$PO" | grep -Fq -- "$1" || die "pipeline lacks '$1': $(printf '%s\n' "$PO" | grep -E '^(signal|missing_flag|focus|gates)' | tr '\n' ';')"; }
hasnt() { ! printf '%s\n' "$PO" | grep -Fq -- "$1" || die "pipeline has '$1'"; }
# rrun CLASS "NEW-PATH..." [PLAN-BODY-LINES]: an unfrozen standalone run whose scope adds new paths.
rrun() {
  scaffold standalone no "$1" manual
  { printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl_test.txt' '    criteria: [AC-1]'
    for rr_p in $2; do printf '  - path: %s\n    new: true\n    criteria: [AC-1]\n    tdd_exemption: "static artifact with no executable behavior; the risk focus checks it"\n' "$rr_p"; done
    printf '%s\n' '---' '# Plan' '' '## Assumptions' 'none' '' '## Architecture' 'one storage map; no new module'
    [ -z "${3:-}" ] || printf '%s\n' "$3"; } > .agents/runs/LC/PLAN.md
}
# frozen: approve when supervised, freeze, IMPLEMENTING.
frozen() {
  case "$(rv pipeline classification)" in COMPLEX|CRITICAL) approve_as_user plan 'approve the plan' ;; esac
  A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
}
# implement FILE CONTENT: RED/GREEN by the lead (standalone) with FILE created at GREEN; then IMPLEMENTED.
implement() {
  solo RED fail impl_test.txt 'test: lookup returns the stored value'
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"
  solo GREEN pass impl.txt 'impl: lookup returns the stored value' "impl.txt,impl_test.txt,$1"
  A handoff LC IMPLEMENTED >/dev/null
}
gate_st() { snap; pv "gate.$1"; }
focus_st() { snap; pv "focus.$1.$2"; }

# Every default diff signal and its check; the traps carry no signal; content hints only when configured.
sc_mapping() {
  scaffold standalone no CRITICAL manual
  mkdir -p api db/migrations web docs src migrations
  printf 'openapi: 3.0.0\n' > api/openapi.yaml
  printf 'create table t (id int);\n' > db/migrations/001_init.sql
  printf '<main></main>\n' > web/index.html
  printf '{}\n' > package.json
  printf 'KEY=\n' > .env.example
  printf '# How to migrate\n' > docs/migration-guide.md                 # trap: a guide named like a migration
  printf '# migrations\n' > migrations/README.md                        # trap: documentation inside migrations/
  printf 'export const contract = {};\n' > src/contract.js              # trap: named like a contract, not one
  printf 'export const s = {};\n' > src/user.schema.ts                  # trap: a schema in code, not a schema file
  snap; has 'signal.contract_file=source=diff:api/openapi.yaml(**/openapi*.yaml) check=REVIEW_RULES:contract flag=contract_change:no design_role=architect'
  has 'signal.migration=source=diff:db/migrations/001_init.sql(**/migrations/**) check=REVIEW_DATA:migration flag=data_change:no design_role=data_architect'
  has 'signal.ui_path=source=diff:web/index.html(*.html) check=QA:visual flag=ui:no design_role=designer'
  has 'signal.dependency_manifest=source=diff:package.json(package.json) check=SECURITY:dependencies flag=- design_role=-'
  has 'signal.config_env=source=diff:.env.example(.env.*) check=REVIEW_RULES:config flag=- design_role=-'
  hasnt 'migration-guide'; hasnt 'migrations/README.md'; hasnt 'src/contract.js'; hasnt 'user.schema.ts'
  has 'missing_flag.contract_file=diff:api/openapi.yaml needs PLAN.md contract_change: yes'
  has 'missing_flag.migration=diff:db/migrations/001_init.sql needs PLAN.md data_change: yes'
  has 'missing_flag.ui_path=diff:web/index.html needs PLAN.md ui: yes'
  hasnt 'missing_flag.dependency_manifest'; hasnt 'missing_flag.config_env'
  [ "$(pv gates)" = 'SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY' ] || die "a migration signal adds REVIEW_DATA: $(pv gates)"
  for fx in REVIEW_RULES.config REVIEW_RULES.contract REVIEW_DATA.migration SECURITY.dependencies QA.visual; do has "focus.$fx=missing"; done
  has 'design_role.architect=contract_file'; has 'design_role.data_architect=migration'; has 'design_role.designer=ui_path'
  # content hints are off by default and fire on added text once the project configures them
  snap; hasnt 'signal.concurrency_hint'
  awk '/^  concurrency_hint:/ { print; getline; print "    content: \"go func|sync\\.Mutex\""; next } /^  performance_hint:/ { print; getline; print "    content: \"for .* range\""; next } { print }' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml
  printf 'package x\nfunc f() { go func() {}() }\n' > src/worker.go
  snap; has 'signal.concurrency_hint=source=diff:src/worker.go(content /go func/sync\.Mutex/) check=REVIEW_RULES:concurrency flag=concurrency:no design_role=architect'
  has 'missing_flag.concurrency_hint=diff:src/worker.go'
  hasnt 'signal.performance_hint'
  printf 'package x\nfunc g(a []int) { for _, v := range a { _ = v } }\n' > src/loop.go
  snap; has 'signal.performance_hint=source=diff:src/loop.go(content /for .* range/) check=REVIEW_RULES:performance'
  ok "mapping: contract, migration, ui, dependency, config and content signals -> their gate focus; traps carry none"
}

# Plan flags add their checks without a matching path; a rules-gate focus lands on REVIEW_SMALL at tier small.
sc_flags() {
  rrun CRITICAL '' "$(printf '%s\n' '' '## Risk' '' 'contract_change: yes' '- concurrency: yes' 'performance_critical: yes  # p95 of /search' '' '## UI' '' 'one status badge' '' '## Data' '' 'destructive: yes')"
  printf 'x = 1\n' > app.py
  snap; has 'signal.contract_change=source=plan:PLAN.md(## Risk contract_change: yes) check=REVIEW_RULES:contract'
  has 'signal.concurrency=source=plan:PLAN.md(## Risk concurrency: yes) check=REVIEW_RULES:concurrency'
  has 'signal.performance_critical=source=plan:PLAN.md(## Risk performance_critical: yes) check=REVIEW_RULES:performance'
  has 'signal.ui=source=plan:PLAN.md(## UI section) check=QA:visual'
  has 'signal.destructive=source=plan:PLAN.md(## Data destructive: yes) check=REVIEW_DATA:migration'
  hasnt 'missing_flag.'
  # a flag set with no matching path in the diff: the check is still required (the plan says it is needed)
  hasnt 'signal.contract_file'; has 'focus.REVIEW_RULES.contract=missing'; has 'focus.QA.visual=missing'
  # an invalid ## Risk line is refused at freeze
  rrun STANDARD '' "$(printf '%s\n' '' '## Risk' '' 'contract_change: maybe')"
  expect_msg "an invalid ## Risk line was frozen" "PLAN.md '## Risk' holds only flag lines" A freeze LC
  # tier small: the contract focus is carried by REVIEW_SMALL
  rrun STANDARD 'api/openapi.yaml' "$(printf '%s\n' '' '## Risk' '' 'contract_change: yes')"
  sed 's/^  small_max_files: 2/  small_max_files: 4/' .agents/config.yaml > "$base/cfg.small"; cp "$base/cfg.small" .agents/config.yaml   # room for the run's own scope files
  git add -A; git commit -qm 'small tier room'
  sed "s/^  base_sha:.*/  base_sha: \"$(git rev-parse HEAD)\"/" .agents/runs/LC/RUN.yaml > "$base/run.base"; cp "$base/run.base" .agents/runs/LC/RUN.yaml
  A classify LC STANDARD review >/dev/null; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  mkdir -p api; printf 'openapi: 3.0.0\n' > api/openapi.yaml   # one exempt file: tier small
  snap; [ "$(pv tier)" = small ] || die "tier is $(pv tier), want small"
  has 'check=REVIEW_SMALL:contract'; has 'focus.REVIEW_SMALL.contract=missing'
  # A92 (F8): the metrics record of a contract focus at tier small names REVIEW_SMALL, not REVIEW_RULES
  implement api/openapi.yaml 'openapi: 3.0.0'
  mkdir -p .agents/runs/LC/reviews/contract-proof; printf '# contract\n\nNo breaking change found.\n' > .agents/runs/LC/reviews/contract-proof/REPORT.md
  AS reviewer submit LC --focus contract --confidence high --artifact reviews/contract-proof/REPORT.md >/dev/null
  grep -Fq '"focus":"contract","gate":"REVIEW_SMALL"' .agents/local/metrics/records.jsonl || die "metrics gate label at tier small: $(cat .agents/local/metrics/records.jsonl 2>/dev/null)"
  # TRIVIAL has no QA gate: a ui signal names no gate instead of inventing one
  # A96: a copy fix in a UI file of a TRIVIAL run: no designer, no ui flag, no missing flag, plan freezes as is
  rrun TRIVIAL ''; rm -f .agents/runs/LC/EVIDENCE.md .agents/runs/LC/QA_PLAN.md
  printf '<p></p>\n' > page.html
  printf '%s\n' '---' 'scope:' '  - path: page.html' '    criteria: [AC-1]' '    tdd_exemption: "single-word copy fix in static markup; verified by an absence grep"' \
    '---' '# Plan' '' '## Assumptions' 'none' > .agents/runs/LC/PLAN.md
  snap; has 'signal.ui_path=source=diff:page.html(*.html),scope:page.html(*.html) check=- (class TRIVIAL: no design phase / no QA gate) flag=ui:no design_role=-'
  hasnt 'missing_flag.'; hasnt 'design_role.'
  A next LC | grep -Fq 'designer' && die "TRIVIAL ui_path dispatches a designer: $(A next LC)"
  A freeze LC >/dev/null || die "TRIVIAL plan touching an .html file does not freeze"
  [ ! -d .agents/runs/LC/design ] || die "design folder exists for TRIVIAL"
  ok "flags: ## Risk, ## UI and ## Data add their checks; invalid flag refused; REVIEW_SMALL carries rules focuses; no gate invented"
}

# A contract file changed without contract_change: a blocking finding at REVIEW_RULES focus contract, and the
# focus still runs; the gate needs every required focus result; declaring the flag clears it.
sc_missing_flag() {
  rrun COMPLEX 'api/openapi.yaml'; frozen; implement api/openapi.yaml 'openapi: 3.0.0'
  for g in $(required); do if [ "$g" = SECRETS ]; then A secret-scan "$RID" >/dev/null; else gpass "$g"; fi; done   # every gate's own focus
  [ "$(gate_st REVIEW_RULES)" = missing ] || die "REVIEW_RULES passed without its contract focus: $(gate_st REVIEW_RULES)"
  expect_msg "CODE_DONE without the contract focus" 'REVIEW_RULES' A handoff LC CODE_DONE
  # the reviewer runs the contract check and finds nothing; the script adds the missing-flag finding
  mkdir -p .agents/runs/LC/reviews/contract-proof
  out=$(printf '# contract\n\nNo breaking change found.\n' | AS reviewer submit LC --focus contract --confidence high --artifact reviews/contract-proof/REPORT.md --report -)
  printf '%s' "$out" | grep -Fq 'risk: 1 script finding(s) added to REVIEW_RULES focus contract' || die "no risk notice: $out"
  printf '%s' "$out" | grep -Fq 'submitted: LC reviewer FAIL gate=REVIEW_RULES' || die "submit did not report FAIL: $out"
  rec=$(ls .agents/runs/LC/gates/*-REVIEW_RULES.yaml | tail -1)
  grep -q '^focus: "contract"' "$rec" && grep -q '^result: "fail"' "$rec" || die "the contract record is not a fail"
  grep -Fq 'finding: REVIEW_RULES-1|blocking|api/openapi.yaml|risk signal contract_file without PLAN.md flag contract_change' "$rec" || die "missing-flag finding absent: $(grep finding "$rec")"
  grep -q '^fix_scope: api/openapi.yaml$' "$rec" || die "fix scope: $(grep fix_scope "$rec")"
  [ "$(gate_st REVIEW_RULES)" = fail ] && [ "$(focus_st REVIEW_RULES contract)" = fail ] || die "gate/focus not fail"
  A next LC | grep -Fq 'amend PLAN.md to declare the flag of REVIEW_RULES-1' || die "next does not name the plan amendment"
  # a contract focus that is not triggered is refused
  rrun COMPLEX 'src/a.js'; frozen; implement src/a.js 'export const a = 1;'
  mkdir -p .agents/runs/LC/reviews/contract-proof; printf '# c\n' > .agents/runs/LC/reviews/contract-proof/REPORT.md
  expect_msg "an untriggered focus was recorded" 'focus contract is not required' AS reviewer submit LC --focus contract --confidence high --artifact reviews/contract-proof/REPORT.md
  # declared: the same change passes once every focus passes
  rrun COMPLEX 'api/openapi.yaml' "$(printf '%s\n' '' '## Risk' '' 'contract_change: yes')"; frozen; implement api/openapi.yaml 'openapi: 3.0.0'
  pass_all
  [ "$(gate_st REVIEW_RULES)" = pass ] || die "declared contract change does not pass: $(gate_st REVIEW_RULES)"
  A handoff LC CODE_DONE >/dev/null
  ok "missing flag: blocking finding at the focus, check still runs, gate needs every focus, declared flag passes"
}

# UNSUPPORTED (A78, A98): never a PASS. Default `risk.unsupported: report`: the focus is `unsupported`, the gate
# closes, `next` and `pipeline` name it, the completion report must list it with 'not proven:'. Blocking: under
# `risk.unsupported: block`, for an INCONCLUSIVE reason (both modes) and with a blocking defect row (FAIL).
uns_report() { mkdir -p .agents/runs/LC/reviews/visual-proof; printf '# visual\n\nNo headless browser in the project.\n' > .agents/runs/LC/reviews/visual-proof/REPORT.md; }
uns_visual() { # REASON: the qa visual focus submits UNSUPPORTED
  uns_report; AS qa submit LC --focus visual --result UNSUPPORTED --reason "$1" --confidence high --artifact reviews/visual-proof/REPORT.md
}
uns_run() { # [CONFIG-SED]: a COMPLEX UI run with every other focus passing, frozen under the (edited) config
  rrun COMPLEX 'web/index.html' "$(printf '%s\n' '' '## UI' '' 'one status badge')"
  if [ -n "${1:-}" ]; then   # the project's own config, committed at the run's base
    sed "$1" .agents/config.yaml > "$base/cfg.u"; cp "$base/cfg.u" .agents/config.yaml
    git add .agents/config.yaml; git commit -qm 'project config'
    sed "s/^  base_sha:.*/  base_sha: \"$(git rev-parse HEAD)\"/" .agents/runs/LC/RUN.yaml > "$base/run.base"; cp "$base/run.base" .agents/runs/LC/RUN.yaml
  fi
  frozen; implement web/index.html '<main></main>'
  pass_all >/dev/null 2>&1 || true
}
sc_unsupported() {
  uns_run
  out=$(uns_visual 'visual-proof skill not installed; no headless browser in the project')
  printf '%s' "$out" | grep -Fq 'submitted: LC qa UNSUPPORTED gate=QA' || die "UNSUPPORTED was not recorded as such: $out"
  printf '%s' "$out" | grep -Fq 'QA focus visual is UNSUPPORTED (unproven, reported, A98)' || die "no unsupported notice: $out"
  [ "$(focus_st QA visual)" = unsupported ] || die "focus is not unsupported: $(focus_st QA visual)"
  [ "$(gate_st QA)" = pass ] || die "an unsupported-only focus holds the gate open: $(gate_st QA)"
  rec=$(ls .agents/runs/LC/gates/*-QA.yaml | tail -1)
  grep -q '^result: "unsupported"$' "$rec" && grep -q '^unsupported: "visual"$' "$rec" || die "the focus record is not unsupported: $(cat "$rec")"
  grep -q '^finding: QA-1|info|-|UNSUPPORTED visual: visual-proof skill not installed' "$rec" || die "unsupported row: $(grep finding "$rec")"
  ! grep -q '^result: "pass"' "$rec" || die "UNSUPPORTED recorded as pass"
  snap; has 'unsupported.QA:visual=UNSUPPORTED (unproven, reported): visual: visual-proof skill not installed'
  expect_msg "UNSUPPORTED without a reason" 'needs --reason' AS qa submit LC --focus visual --result UNSUPPORTED --confidence high --artifact reviews/visual-proof/REPORT.md
  expect_msg "UNSUPPORTED on a base focus" 'UNSUPPORTED is a result of a risk focus only' AS reviewer submit LC --focus rules --result UNSUPPORTED --reason 'no tool' --confidence high
  nx=$(A next LC)
  printf '%s\n' "$nx" | grep -Fq 'next=UNSUPPORTED (unproven, reported) QA:visual: visual: visual-proof skill not installed' || die "next does not name the unsupported focus: $nx"
  printf '%s\n' "$nx" | grep -Fq 'next=agent.sh handoff LC CODE_DONE' || die "next does not offer CODE_DONE: $nx"
  ! printf '%s\n' "$nx" | grep -Fq 'waive:' || die "next asks for a waiver of a reported UNSUPPORTED: $nx"
  A handoff LC CODE_DONE >/dev/null; A knowledge-done LC not_applicable >/dev/null
  A next LC | grep -Fq 'next=UNSUPPORTED (unproven, reported) QA:visual' || die "next before the report does not name the unsupported focus"
  write_report
  expect_msg "a report without the UNSUPPORTED section" '## Unsupported Checks' A publish-completion-report LC markdown
  write_report '' '## Unsupported Checks' 'Visual check skipped; not proven: layout at 320px.'
  expect_msg "a report that does not name the check" 'must name the UNSUPPORTED check QA:visual' A publish-completion-report LC markdown
  # A92: the name counts only inside the section it is required under
  write_report '' '## Review Result' 'QA:visual unsupported.' '' '## Unsupported Checks' 'Visual check skipped.'
  expect_msg "a check named outside the section" 'must name the UNSUPPORTED check QA:visual' A publish-completion-report LC markdown
  write_report '' '## Unsupported Checks' '- QA:visual: visual-proof skill not installed.'
  expect_msg "a check without its 'not proven' line" "must say 'not proven: <what>'" A publish-completion-report LC markdown
  write_report '' '## Unsupported Checks' '- QA:visual: visual-proof skill not installed; not proven: the badge renders without overflow at 320px.'
  A publish-completion-report LC markdown >/dev/null
  # INCONCLUSIVE stays blocking under the default: a measurement ran and was unreliable, the user decides
  uns_run
  out=$(uns_visual 'visual INCONCLUSIVE: two identical captures differ by 4% of pixels')
  printf '%s' "$out" | grep -Fq 'submitted: LC qa FAIL gate=QA' || die "INCONCLUSIVE was not a failing focus: $out"
  [ "$(focus_st QA visual)" = fail ] && [ "$(gate_st QA)" = fail ] || die "INCONCLUSIVE did not block: $(focus_st QA visual)"
  snap; has 'unsupported.QA:visual=UNSUPPORTED (blocking: a waiver or a measurement is needed): visual: visual INCONCLUSIVE:'
  fid=$(sed -n 's/^finding: \([^|]*\)|blocking|-|UNSUPPORTED .*/\1/p' "$(ls .agents/runs/LC/gates/*-QA.yaml | tail -1)")
  nx=$(A next LC)
  printf '%s\n' "$nx" | grep -Fq "request-approval LC waive:$fid (blocking UNSUPPORTED visual" || die "next does not offer the user's waiver: $nx"
  # A92: only a script finding fails the gate: no implementer fix round is offered
  ! printf '%s\n' "$nx" | grep -Fq 'handoff LC IMPLEMENTING' || die "next offers a fix round for an UNSUPPORTED-only failure"
  approve_as_user "waive:$fid" "approved, waive $fid"
  A waive LC "$fid" --reason 'unstable rendering in this environment; the user accepts the visual gap' >/dev/null
  [ "$(gate_st QA)" = waived ] || die "waived INCONCLUSIVE gate: $(gate_st QA)"
  A handoff LC CODE_DONE >/dev/null; A knowledge-done LC not_applicable >/dev/null
  write_report '' '## Waivers' 'The user waived the INCONCLUSIVE finding.' '' '## Unsupported Checks' 'Visual check skipped.'
  expect_msg "a waived INCONCLUSIVE not named" 'must name the UNSUPPORTED check QA:visual' A publish-completion-report LC markdown
  write_report '' '## Waivers' 'The user waived the INCONCLUSIVE finding.' '' '## Unsupported Checks' '- QA:visual: visual INCONCLUSIVE, waived by the user; not proven: the badge layout.'
  A publish-completion-report LC markdown >/dev/null
  # a performance INCONCLUSIVE blocks too (the prefix rule, whatever the focus)
  uns_run
  out=$(uns_visual 'performance INCONCLUSIVE: noise 30% over the 10% threshold')
  [ "$(focus_st QA visual)" = fail ] || die "performance INCONCLUSIVE prefix did not block: $out"
  # FAIL + UNSUPPORTED: a defect in the part that could be checked is a FAIL (the contract-proof shape: defect rows
  # plus blocking UNSUPPORTED rows); it blocks, the implementer fixes the defect, the UNSUPPORTED row is listed
  uns_run; uns_report
  printf '%s\n' 'blocking|web/index.html:1|the status badge has no text alternative|traced: <main> holds an img without alt' \
    'blocking|-|UNSUPPORTED visual: no headless browser for the overflow cells|no measurement' > "$base/uns.rows"
  expect_msg "UNSUPPORTED with a blocking row" 'UNSUPPORTED cannot carry blocking findings' AS qa submit LC --focus visual --result UNSUPPORTED --reason 'no browser' --findings "$base/uns.rows" --confidence high --artifact reviews/visual-proof/REPORT.md
  out=$(AS qa submit LC --focus visual --findings "$base/uns.rows" --confidence high --artifact reviews/visual-proof/REPORT.md)
  printf '%s' "$out" | grep -Fq 'submitted: LC qa FAIL gate=QA' || die "FAIL+UNSUPPORTED did not fail: $out"
  [ "$(focus_st QA visual)" = fail ] && [ "$(gate_st QA)" = fail ] || die "FAIL+UNSUPPORTED did not block"
  snap; has 'unsupported.QA:visual=UNSUPPORTED (blocking: a waiver or a measurement is needed): visual: no headless browser'
  A next LC | grep -Fq 'handoff LC IMPLEMENTING (fix round' || die "next does not send the defect to a fix round: $(A next LC)"
  # risk.unsupported: block restores A78: the UNSUPPORTED row is blocking, the gate fails, only the user waives
  uns_run 's/^  unsupported: report$/  unsupported: block/'
  grep -q '^  unsupported: block$' .agents/config.yaml || die "the block edit did not apply"
  A config-check >/dev/null
  out=$(uns_visual 'visual-proof skill not installed')
  printf '%s' "$out" | grep -Fq 'submitted: LC qa FAIL gate=QA' || die "block mode did not fail: $out"
  [ "$(gate_st QA)" = fail ] || die "block mode gate: $(gate_st QA)"
  A next LC | grep -Fq 'request-approval LC waive:QA-1' || die "block mode: next does not offer the waiver"
  # the dependency audit always has a tool-free check
  rrun COMPLEX 'package.json'; frozen; implement package.json '{}'
  mkdir -p .agents/runs/LC/security/dependencies; printf '# deps\n' > .agents/runs/LC/security/dependencies/REPORT.md
  expect_msg "UNSUPPORTED dependency audit" 'UNSUPPORTED is not available' AS security_reviewer submit LC --focus dependencies --result UNSUPPORTED --reason 'no audit tool' --confidence high --artifact security/dependencies/REPORT.md
  ok "UNSUPPORTED: unproven and reported (gate closes, never pass, report lists it with 'not proven:'); INCONCLUSIVE, block mode and a defect row block; not for dependencies"
}

# Flags are frozen with PLAN.md; the mapping is frozen with risk_sha256; config-check refuses foreign checks.
sc_frozen() {
  rrun COMPLEX 'api/openapi.yaml'; frozen
  printf '\n## Risk\n\ncontract_change: yes\nperformance_critical: yes budget_pct=5\n' >> .agents/runs/LC/PLAN.md
  expect_msg "a flag changed after freeze" 'freeze mismatch: plan' A verify-freeze LC
  mkdir -p .agents/runs/LC/amendments; printf '# Amendment 1\n\nDeclare the contract change.\n' > .agents/runs/LC/amendments/001.md
  approve_as_user plan 'approved: the amended plan'
  A refreeze LC 001.md >/dev/null; A verify-freeze LC >/dev/null
  snap; has 'signal.contract_change=source=plan'
  # A87: the performance budget on the flag line is frozen with PLAN.md: raising it after freeze breaks the freeze
  cp .agents/runs/LC/PLAN.md "$base/plan.keep"
  sed 's/^performance_critical: yes budget_pct=5$/performance_critical: yes budget_pct=50/' "$base/plan.keep" > .agents/runs/LC/PLAN.md
  grep -q 'budget_pct=50' .agents/runs/LC/PLAN.md
  expect_msg "a performance budget raised after freeze" 'freeze mismatch: plan' A verify-freeze LC
  cp "$base/plan.keep" .agents/runs/LC/PLAN.md; A verify-freeze LC >/dev/null
  # the mapping: any edit of the risk block after freeze breaks the freeze
  sed 's/^    check: contract$/    check: rules/' .agents/config.yaml > "$base/cfg"; cp .agents/config.yaml "$base/cfg.keep"; cp "$base/cfg" .agents/config.yaml
  expect_msg "a mapping change after freeze" 'freeze mismatch: risk' A verify-freeze LC
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  # A87: the performance thresholds are frozen too: raising regression_pct mid-run breaks the freeze
  sed 's/^  regression_pct: 10$/  regression_pct: 500/' .agents/config.yaml > "$base/cfg3"; grep -q '^  regression_pct: 500$' "$base/cfg3"
  cp "$base/cfg3" .agents/config.yaml
  expect_msg "a performance threshold change after freeze" 'freeze mismatch: risk' A verify-freeze LC
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  # A98: risk.unsupported is part of the frozen mapping and config-check accepts only block|report
  sed 's/^  unsupported: report$/  unsupported: block/' "$base/cfg.keep" > .agents/config.yaml; grep -q '^  unsupported: block$' .agents/config.yaml || die "the unsupported edit did not apply"
  A config-check >/dev/null
  expect_msg "risk.unsupported changed after freeze" 'freeze mismatch: risk' A verify-freeze LC
  sed 's/^  unsupported: report$/  unsupported: maybe/' "$base/cfg.keep" > "$base/cfg.bad"
  expect_msg "an invalid risk.unsupported" 'invalid value for risk.unsupported: maybe (want block|report)' A config-check "$base/cfg.bad"
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  expect_msg "a check outside the focus set" 'invalid value for risk.contract_file.check' A config-check "$base/cfg"
  awk '/^  ui_path:/ { print; print "    paths: \"*.html\""; print "    check: VISUAL_GATE"; skip = 1; next } skip && /^  [a-z]/ { skip = 0 } !skip { print }' .agents/config.yaml > "$base/cfg2"
  expect_msg "a new gate type in the mapping" 'invalid value for risk.ui_path.check' A config-check "$base/cfg2"
  # A88: the shipped config carries the `security:` block (license policy, audit command) and config-check accepts it
  grep -q '^security:' .agents/config.yaml || die "shipped config has no security block"
  A config-check >/dev/null
  # the license policy and audit command are bound by the freeze too: a mid-run edit is refused, restoring it passes
  cp .agents/config.yaml "$base/cfg.keep"
  sed 's/^    deny:.*$/    deny: GPL-3.0-only/' "$base/cfg.keep" > .agents/config.yaml
  grep -q '^    deny: GPL-3.0-only$' .agents/config.yaml || die "the test edit did not apply"
  expect_msg "a license policy edit after freeze" 'freeze mismatch: risk' A verify-freeze LC
  sed 's/^  audit_command:.*$/  audit_command: make audit/' "$base/cfg.keep" > .agents/config.yaml
  expect_msg "an audit command edit after freeze" 'freeze mismatch: risk' A verify-freeze LC
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  # contract-proof's contract.paths / contract.ignore globs are frozen with the mapping (A83)
  printf '\ncontract:\n  ignore: "i18n/**"\n' >> .agents/config.yaml
  A config-check >/dev/null
  expect_msg "contract.ignore added after freeze" 'freeze mismatch: risk' A verify-freeze LC
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  # A92: a RUN.yaml without freeze.risk_sha256 fails closed; a refreeze inserts the key
  cp .agents/runs/LC/RUN.yaml "$base/run.keep"; grep -v '^  risk_sha256:' "$base/run.keep" > .agents/runs/LC/RUN.yaml
  expect_msg "a run without risk_sha256" 'no freeze.risk_sha256' A verify-freeze LC
  printf '# Amendment 2\n\nBind the risk mapping.\n' > .agents/runs/LC/amendments/002.md
  approve_as_user plan 'approved: the amended plan, bind the mapping'
  A refreeze LC 002.md >/dev/null; A verify-freeze LC >/dev/null
  grep -q '^  risk_sha256: "[0-9a-f]\{64\}"' .agents/runs/LC/RUN.yaml || die "refreeze did not insert risk_sha256"
  { cat .agents/config.yaml; printf '\ncontract:\n  skip: "x"\n'; } > "$base/cfg3"
  expect_msg "an unknown contract key" 'unknown contract key: contract.skip' A config-check "$base/cfg3"
  ok "frozen: flags need a refreeze, the mapping, the performance thresholds, the security policy and the contract globs are bound by risk_sha256, config-check refuses foreign checks"
}

# Before FREEZE: a planned contract path without its flag sends `next` to the architect.
sc_prefreeze() {
  rrun STANDARD 'api/openapi.yaml'
  A next LC | grep -Fq 'next=dispatch.sh LC architect (declare contract_change in PLAN.md for risk signal contract_file: api/openapi.yaml' || die "next: $(A next LC)"
  snap; has 'signal.contract_file=source=scope:api/openapi.yaml'
  has 'missing_flag.contract_file=scope:api/openapi.yaml needs PLAN.md contract_change: yes (declare it before FREEZE)'
  rrun STANDARD 'db/migrations/002.sql'
  A next LC | grep -Fq 'next=dispatch.sh LC data_architect (declare data_change' || die "next: $(A next LC)"
  rrun STANDARD 'api/openapi.yaml' "$(printf '%s\n' '' '## Risk' '' 'contract_change: yes')"
  A next LC | grep -Fq 'next=agent.sh freeze LC' || die "next after the flag: $(A next LC)"
  ok "pre-freeze: signals of the planned scope are visible and next dispatches the design role"
}

# A contract under another name is found by its content; a nested .proto by its path; documentation never.
sc_contract_content() {
  scaffold standalone no CRITICAL manual
  mkdir -p spec proto/v1 schemas docs
  printf 'openapi: 3.1.0\ninfo: { title: x }\n' > spec/service.yaml
  printf '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n' > schemas/user.json
  printf 'message User { string id = 1; }\n' > proto/v1/user.proto
  printf '# API notes\n\nThe spec starts with:\n\nopenapi: 3.0.0\n' > docs/api-notes.md          # trap: prose quoting a contract
  printf 'const yaml = "openapi: 3.0.0";\n' > src.js                                              # trap: not at line start
  snap
  has 'signal.contract_file=source=diff:proto/v1/user.proto(*.proto),diff:schemas/user.json(content /^(openapi/asyncapi/swagger):/"\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\.org//^syntax = "proto/),diff:spec/service.yaml(content /^(openapi/asyncapi/swagger):/"\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\.org//^syntax = "proto/) check=REVIEW_RULES:contract'
  hasnt 'api-notes.md'; hasnt 'src.js'
  ok "contract content: OpenAPI root key and JSON Schema found by content, nested .proto by path; prose and code quoting it are not"
}

# A92: a content-recognised contract edited by deleting an operation still signals; config JSON is not a contract.
sc_contract_content_edit() {
  scaffold standalone no CRITICAL manual
  mkdir -p spec; printf 'openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n  /b:\n    get: {}\n' > spec/service.yaml
  printf '{ "compilerOptions": {} }\n' > tsconfig.json
  git add -A; git commit -qm 'add spec and tsconfig'
  # the run's base is the commit that holds the contract, so the edit below is an edit of a file that exists at base
  sed "s/^  base_sha:.*/  base_sha: \"$(git rev-parse HEAD)\"/" .agents/runs/LC/RUN.yaml > "$base/run.base"; cp "$base/run.base" .agents/runs/LC/RUN.yaml
  printf 'openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n' > spec/service.yaml
  snap
  has 'diff:spec/service.yaml(content '; has 'focus.REVIEW_RULES.contract=missing'
  has 'missing_flag.contract_file=diff:spec/service.yaml needs PLAN.md contract_change: yes'
  printf '{ "$schema": "https://json.schemastore.org/tsconfig", "compilerOptions": {} }\n' > tsconfig.json
  printf '{ "$schema": "https://json.schemastore.org/biome.json" }\n' > tooling.json
  printf '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n' > shape.json
  snap
  hasnt 'tsconfig.json'; hasnt 'tooling.json'; has 'diff:shape.json(content '
  printf 'contract:\n  ignore: "shape.json"\n' >> .agents/config.yaml
  snap; hasnt 'shape.json'
  ok "contract content: an edit or deletion in a content-recognised contract signals; tsconfig, a non-json-schema.org schema and contract.ignore do not"
}

# A one-file migration at what would be tier small: the migration signal makes the tier full, so REVIEW_DATA
# carries the check and the missing flag fails it; the tier never decreases afterwards.
sc_migration_small() {
  rrun STANDARD 'queries/drop_theme.sql'
  A classify LC STANDARD review >/dev/null; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  mkdir -p queries; printf 'alter table settings drop column theme;\n' > queries/drop_theme.sql
  snap; [ "$(pv tier)" = full ] || die "a one-file migration is tier $(pv tier), want full"
  has 'gates=SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY'
  has 'signal.migration=source=diff:queries/drop_theme.sql(*.sql)'; has 'focus.REVIEW_DATA.migration=missing'
  has 'missing_flag.migration=diff:queries/drop_theme.sql needs PLAN.md data_change: yes (a blocking finding'
  A tier LC >/dev/null; rm queries/drop_theme.sql
  [ "$(A tier LC)" = full ] || die "the tier decreased after the migration was removed"
  ok "migration at tier small: escalated to full, REVIEW_DATA carries the migration check, tier never decreases"
}

# Every manifest and lockfile the exploit-proof diff parses (or lists unparsed) is a dependency signal (A94).
sc_dependency_manifests() {
  scaffold standalone no CRITICAL manual
  mkdir -p requirements gradle docs
  for dm_f in npm-shrinkwrap.json requirements-dev.txt requirements.in requirements/base.txt requirements/prod.in setup.py setup.cfg gradle/libs.versions.toml \
      .npmrc packages.config environment.yml deno.json Package.swift go.sum Gemfile.lock composer.lock pom.xml build.gradle.kts app.csproj yarn.lock pnpm-lock.yaml poetry.lock; do
    printf 'x\n' > "$dm_f"
  done
  printf '# Requirements\n' > docs/requirements.md      # trap: documentation about requirements
  printf 'x\n' > setup.pyc                              # trap: not a manifest
  snap
  for dm_f in npm-shrinkwrap.json requirements-dev.txt requirements.in requirements/base.txt requirements/prod.in setup.py setup.cfg gradle/libs.versions.toml \
      .npmrc packages.config environment.yml deno.json Package.swift go.sum Gemfile.lock composer.lock pom.xml build.gradle.kts app.csproj yarn.lock pnpm-lock.yaml poetry.lock; do
    has "diff:$dm_f("
  done
  hasnt 'docs/requirements.md'; hasnt 'setup.pyc'
  ok "dependency manifests: every manifest and lockfile the dependency diff reads is a SECURITY:dependencies signal; documentation is not"
}

# Drift guard (A92): the control plane's not-a-contract list is a verbatim copy of contract-proof's.
sc_not_contract_drift() {
  cp_re=$(sed -n "s/^risk_not_contract='\(.*\)'\$/\1/p" "$(dirname "$0")/agent.sh")
  sk=$(dirname "$0")/../../../skills/contract-proof/scripts/diff-contract.mjs
  [ -f "$sk" ] || { ok "not-a-contract drift guard skipped (skill source not present)"; return 0; }
  sk_re=$(sed -n 's#^export const NOT_A_CONTRACT = /\(.*\)/i;$#\1#p' "$sk")
  [ -n "$cp_re" ] && [ "$cp_re" = "$sk_re" ] || die "risk_not_contract drifted from contract-proof NOT_A_CONTRACT"
  ok "not-a-contract list equals contract-proof's"
}

run_sc sc_mapping
run_sc sc_dependency_manifests
run_sc sc_not_contract_drift
run_sc sc_contract_content
run_sc sc_contract_content_edit
run_sc sc_migration_small
run_sc sc_flags
run_sc sc_missing_flag
run_sc sc_unsupported
run_sc sc_frozen
run_sc sc_prefreeze
