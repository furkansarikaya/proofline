#!/bin/sh
# shellcheck disable=SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: assertion chains
# Self-tests of the risk-adaptive pipeline (A78): every signal -> check mapping, the missing-flag FAIL, the
# focus results a gate needs, UNSUPPORTED (never a PASS), frozen flags and the frozen mapping.
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
  A classify LC STANDARD review >/dev/null; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  mkdir -p api; printf 'openapi: 3.0.0\n' > api/openapi.yaml   # one exempt file: tier small
  snap; [ "$(pv tier)" = small ] || die "tier is $(pv tier), want small"
  has 'check=REVIEW_SMALL:contract'; has 'focus.REVIEW_SMALL.contract=missing'
  # TRIVIAL has no QA gate: a ui signal names no gate instead of inventing one
  rrun TRIVIAL ''; rm -f .agents/runs/LC/EVIDENCE.md .agents/runs/LC/QA_PLAN.md
  printf '<p></p>\n' > page.html
  snap; has 'check=-:visual (no required gate carries it'
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

# UNSUPPORTED: accepted for a risk focus, never a PASS, waivable only by the user, named in the completion report.
sc_unsupported() {
  rrun COMPLEX 'web/index.html' "$(printf '%s\n' '' '## UI' '' 'one status badge')"; frozen; implement web/index.html '<main></main>'
  pass_all >/dev/null 2>&1 || true
  # the qa visual focus has no tool: UNSUPPORTED
  mkdir -p .agents/runs/LC/reviews/visual-proof
  out=$(printf '# visual\n\nNo headless browser in the project.\n' | AS qa submit LC --focus visual --result UNSUPPORTED --reason 'visual-proof skill not installed; no headless browser in the project' --confidence high --artifact reviews/visual-proof/REPORT.md --report -)
  printf '%s' "$out" | grep -Fq 'submitted: LC qa FAIL gate=QA' || die "UNSUPPORTED was not recorded as a failing focus: $out"
  [ "$(focus_st QA visual)" = fail ] && [ "$(gate_st QA)" = fail ] || die "UNSUPPORTED counted as pass: $(focus_st QA visual)"
  snap; has 'unsupported.QA:visual=UNSUPPORTED visual: visual-proof skill not installed'
  expect_msg "UNSUPPORTED without a reason" 'needs --reason' AS qa submit LC --focus visual --result UNSUPPORTED --confidence high --artifact reviews/visual-proof/REPORT.md
  expect_msg "UNSUPPORTED on a base focus" 'UNSUPPORTED is a result of a risk focus only' AS reviewer submit LC --focus rules --result UNSUPPORTED --reason 'no tool' --confidence high
  fid=$(sed -n 's/^finding: \([^|]*\)|blocking|-|UNSUPPORTED .*/\1/p' "$(ls .agents/runs/LC/gates/*-QA.yaml | tail -1)")
  A next LC | grep -Fq "request-approval LC waive:$fid (UNSUPPORTED visual" || die "next does not offer the user's waiver"
  approve_as_user "waive:$fid" "approved, waive $fid"
  A waive LC "$fid" --reason 'no browser in this project; the user accepts the visual gap' >/dev/null
  [ "$(gate_st QA)" = waived ] || die "waived UNSUPPORTED gate: $(gate_st QA)"
  A handoff LC CODE_DONE >/dev/null; A knowledge-done LC not_applicable >/dev/null
  write_report '' '## Waivers' 'The user waived the UNSUPPORTED finding.'
  expect_msg "a report without the UNSUPPORTED section" '## Unsupported Checks' A publish-completion-report LC markdown
  write_report '' '## Waivers' 'The user waived the UNSUPPORTED finding.' '' '## Unsupported Checks' 'Visual check skipped.'
  expect_msg "a report that does not name the check" 'must name the UNSUPPORTED check QA:visual' A publish-completion-report LC markdown
  write_report '' '## Waivers' 'The user waived the UNSUPPORTED finding.' '' '## Unsupported Checks' 'QA:visual - visual-proof skill not installed; waived by the user.'
  A publish-completion-report LC markdown >/dev/null
  # the dependency audit always has a tool-free check
  rrun COMPLEX 'package.json'; frozen; implement package.json '{}'
  mkdir -p .agents/runs/LC/security/dependencies; printf '# deps\n' > .agents/runs/LC/security/dependencies/REPORT.md
  expect_msg "UNSUPPORTED dependency audit" 'UNSUPPORTED is not available' AS security_reviewer submit LC --focus dependencies --result UNSUPPORTED --reason 'no audit tool' --confidence high --artifact security/dependencies/REPORT.md
  ok "UNSUPPORTED: a blocking finding, never a PASS, waivable by the user, listed in the completion report; not for dependencies"
}

# Flags are frozen with PLAN.md; the mapping is frozen with risk_sha256; config-check refuses foreign checks.
sc_frozen() {
  rrun COMPLEX 'api/openapi.yaml'; frozen
  printf '\n## Risk\n\ncontract_change: yes\n' >> .agents/runs/LC/PLAN.md
  expect_msg "a flag changed after freeze" 'freeze mismatch: plan' A verify-freeze LC
  mkdir -p .agents/runs/LC/amendments; printf '# Amendment 1\n\nDeclare the contract change.\n' > .agents/runs/LC/amendments/001.md
  approve_as_user plan 'approved: the amended plan'
  A refreeze LC 001.md >/dev/null; A verify-freeze LC >/dev/null
  snap; has 'signal.contract_change=source=plan'
  # the mapping: any edit of the risk block after freeze breaks the freeze
  sed 's/^    check: contract$/    check: rules/' .agents/config.yaml > "$base/cfg"; cp .agents/config.yaml "$base/cfg.keep"; cp "$base/cfg" .agents/config.yaml
  expect_msg "a mapping change after freeze" 'freeze mismatch: risk' A verify-freeze LC
  cp "$base/cfg.keep" .agents/config.yaml; A verify-freeze LC >/dev/null
  expect_msg "a check outside the focus set" 'invalid value for risk.contract_file.check' A config-check "$base/cfg"
  awk '/^  ui_path:/ { print; print "    paths: \"*.html\""; print "    check: VISUAL_GATE"; skip = 1; next } skip && /^  [a-z]/ { skip = 0 } !skip { print }' .agents/config.yaml > "$base/cfg2"
  expect_msg "a new gate type in the mapping" 'invalid value for risk.ui_path.check' A config-check "$base/cfg2"
  ok "frozen: flags need a refreeze, the mapping is bound by risk_sha256, config-check refuses foreign checks"
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
  has 'signal.contract_file=source=diff:proto/v1/user.proto(*.proto),diff:schemas/user.json(content /^(openapi/asyncapi/swagger):/"\$schema"/^syntax = "proto/),diff:spec/service.yaml(content /^(openapi/asyncapi/swagger):/"\$schema"/^syntax = "proto/) check=REVIEW_RULES:contract'
  hasnt 'api-notes.md'; hasnt 'src.js'
  ok "contract content: OpenAPI root key and JSON Schema found by content, nested .proto by path; prose and code quoting it are not"
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

run_sc sc_mapping
run_sc sc_contract_content
run_sc sc_migration_small
run_sc sc_flags
run_sc sc_missing_flag
run_sc sc_unsupported
run_sc sc_frozen
run_sc sc_prefreeze
