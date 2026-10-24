#!/bin/sh
# shellcheck disable=SC2010,SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: assertion chains
# A172 self-tests: one identity for ids (a producer's output is accepted by its checker, any case) and the quotable
# product text of the language check.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# implemented ORCH: scaffolded run with RED/GREEN evidence and handoff IMPLEMENTED (as gates-test.sh)
implemented() { worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null; }
TR='Siparişleriniz başarıyla kaydedildi, teşekkürler'   # a Turkish product sentence
# qa_rows: one blocking-free info row (severity|path:line|finding|evidence)
rows() { printf 'info|impl.txt:1|a note about the lookup|seen in the plan\n' > "$base/r.rows"; }

# The real bug: a QA plan-step submit produced QA-1 and record demanded qa-<n>.
sc_qa_plan_submit() {
  scaffold orchestrated; rows
  out=$(AS qa submit LC --result DONE --confidence high --findings "$base/r.rows" --agent qa1 2>&1) || die "qa plan step submit with rows was rejected: $out"
  printf '%s' "$out" | grep -q 'invalid finding' && die "invalid finding id: $out"
  ok "submit: a QA plan step with rows is recorded (no 'invalid finding id QA-1 (want qa-<n>)')"
}

# Producer -> checker, for every id kind; a differently cased spelling is accepted and recorded as written.
sc_id_identity() {
  scaffold orchestrated; implemented orchestrated; rows
  rec() { # ROLE RESULT PREFIX-SPELLING -> record a hand-written task result
    ARTIFACT=QA_PLAN.md
    printf 'ROLE: %s\nTASK: LC\nRESULT: %s\nCONFIDENCE: high\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| %s-1 | info | impl.txt:1 | a note | seen |\n' \
      "$1" "$2" "$(A fingerprint LC)" "$ARTIFACT" "$(tsha .agents/runs/LC/$ARTIFACT)" "$3" > "$base/rec.md"
    AS "$1" record LC --file "$base/rec.md" 2>&1
  }
  for sp in qa QA Qa; do rec qa DONE "$sp" >/dev/null || die "record refused finding id spelling $sp-1 for qa"; done
  grep -rl 'QA-1' .agents/runs/LC/results .agents/runs/LC/reports 2>/dev/null | head -1 | grep -q . || die "the recorded spelling QA-1 was not kept as written"
  # gate ids: submit writes <GATE>-<n>; record takes any case
  small=.agents/runs/LC/reviews/proof-review/small; mkdir -p "$small"; printf 'review of the tree\n' > "$small/REPORT.md"
  AS reviewer submit LC --focus rules+tests --confidence high --findings "$base/r.rows" --agent g1 >/dev/null || die "gate id submit->record failed"
  grep -q '^finding: REVIEW_SMALL-1|' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "gate finding id is not <GATE>-<n> as produced"
  f=$(result_for REVIEW_SMALL PASS high 'review_small-1|info|impl.txt:1|a note|seen')
  AS reviewer record LC --file "$f" >/dev/null 2>&1 || die "a lower-case gate finding id review_small-1 was refused"
  grep -q '^finding: review_small-1|' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "the recorded gate id spelling changed"
  # QA-n scenarios and AC-n in QA_PLAN.md: lower case and zero padded spellings
  d=.agents/runs/LC
  printf '# QA plan\n\n- qa-01 (ac-1): lookup returns the stored value\n' > "$d/QA_PLAN.md"; qa_bind LC
  A verify-qa-plan LC >/dev/null 2>&1 || die "verify_qa_plan_bound refused qa-01 (ac-1)"
  ok "identity: finding ids (qa-n, QA-n, gate ids) and QA-n/AC-n spellings are accepted by their checker and recorded as written"
}

# Language check: product text may be quoted, anything else may not.
lang_run() { # sets up a scaffolded run whose TASK.md holds $TR
  SC_TASK_EXTRA="- AC-2: the page says \`$TR\`" scaffold standalone no STANDARD manual
  git add -A >/dev/null 2>&1 || :
}
lang_ok() { printf '%s\n' "$2" > "$base/q.md"; A language-check "$base/q.md" >/dev/null 2>&1 || die "$1 was refused: $2"; }
lang_no() { printf '%s\n' "$2" > "$base/q.md"; expect_msg "$1" 'language: run artifacts are English' A language-check "$base/q.md"; }
sc_language_quotable() {
  lang_run
  q=.agents/runs/LC/QA_PLAN.md
  for form in "Expect \`$TR\` on the page." "Expect \"$TR\" on the page." "> $TR" "{\"text\": \"$TR\"}"; do
    printf '# QA plan\n\n%s\n' "$form" > "$q"; A language-check "$q" >/dev/null 2>&1 || die "a quoted product sentence was refused: $form"
  done
  printf '# QA plan\n\n```\n%s\n```\n' "$TR" > "$q"; A language-check "$q" >/dev/null 2>&1 || die "a fenced product sentence was refused"
  ok "language: a Turkish sentence of TASK.md is accepted in backticks, double quotes, a '>' block, a fence and a JSON value"
}
sc_language_foreign() {
  lang_run
  q=.agents/runs/LC/QA_PLAN.md; other='Hesabınız silindi, lütfen tekrar giriş yapın şimdi'
  for form in "Expect \`$other\` on the page." "Expect \"$other\" on the page." "> $other" "{\"text\": \"$other\"}"; do
    printf '# QA plan\n\n%s\n' "$form" > "$q"; expect_msg "an invented sentence passed: $form" 'language: run artifacts are English' A language-check "$q"
  done
  printf '# QA plan\n\n```\n%s\n```\n' "$other" > "$q"; expect_msg "an invented sentence passed in a fence" 'language: run artifacts' A language-check "$q"
  printf '%s\n' "$other" > untracked-note.txt   # exists only in an UNTRACKED file
  printf '# QA plan\n\nExpect `%s` on the page.\n' "$other" > "$q"
  expect_msg "a sentence found only in an untracked file was accepted" 'language: run artifacts' A language-check "$q"
  ok "language: an invented sentence is refused in every quote form; an untracked file is no source"
}
sc_language_tracked() {
  lang_run
  q=.agents/runs/LC/QA_PLAN.md; prod='Sepetiniz şu anda boş görünüyor, ürün ekleyin'
  printf '<p>%s</p>\n' "$prod" > page.html; git add page.html
  printf '# QA plan\n\nExpect `%s` on the page.\n' "$prod" > "$q"
  A language-check "$q" >/dev/null 2>&1 || die "a sentence of a git-tracked product file was refused"
  ok "language: a sentence of a tracked product file is quotable"
}
sc_language_machine_output() {
  lang_run
  d=.agents/runs/LC; mkdir -p "$d/reviews/visual-proof" "$d/reports/qa-evidence"
  printf '{"screens":[{"text":"Hesabınız silindi, lütfen tekrar giriş yapın şimdi"}]}\n' > "$d/reviews/visual-proof/report.json"
  printf '# Evidence\n\nEkranda: Hesabınız silindi, lütfen tekrar giriş yapın şimdi\n' > "$d/reports/qa-evidence/shot.md"
  A language-check "$d/reviews/visual-proof/report.json" >/dev/null 2>&1 || die "visual-proof output was blocked"
  A language-check "$d/reports/qa-evidence/shot.md" >/dev/null 2>&1 || die "qa-evidence was blocked"
  ok "language: reviews/visual-proof and reports/qa-evidence hold screen text"
}
sc_language_message() {
  scaffold standalone no STANDARD manual
  printf 'Hesabınız silindi, lütfen tekrar giriş yapın şimdi\n' > "$base/m.md"
  msg=$(A language-check "$base/m.md" 2>&1) && die "unquoted Turkish passed"
  for want in 'Do NOT transliterate' 'do NOT ask the user' 'quote the text that exists in the project'; do
    printf '%s' "$msg" | grep -q "$want" || die "the reject message lacks: $want"
  done
  ok "language: the reject message says quote the project's text, do not transliterate, do not ask"
}

run_sc sc_qa_plan_submit
run_sc sc_id_identity
run_sc sc_language_quotable
run_sc sc_language_foreign
run_sc sc_language_tracked
run_sc sc_language_machine_output
run_sc sc_language_message
echo 'identity tests passed'
