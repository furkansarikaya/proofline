#!/bin/sh
# Tests for rules.sh (A202): the project rules budget proposes, the user decides. Duplicates are found, a contradiction is raised as a
# question, unused rules are counted from review records, and nothing ever changes AGENTS.md.
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents, base come from test-lib.sh
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
scaffold standalone no STANDARD manual
cp "$tl_agents/scripts/rules.sh" .agents/scripts/
R() { A rules "$@"; }
mk_agents() {
  cat > AGENTS.md <<'MD'
# Project

<!-- proofline:begin -->
## Project rules

- this block is proofline's and is never counted
<!-- proofline:end -->

## Project rules

- Always validate the request body before calling the repository layer.
- Validate the request body before calling the repository layer, always.
- Never use raw SQL strings in handlers.
- Always use raw SQL strings in handlers for reports.
- Name test files after the unit they cover. (lesson lc-0a1b2c3d)
  A second line of the same rule.

## Other

- not a rule of the section
MD
}
mk_agents
sum0=$(tsha AGENTS.md)

# --- list: the section only, a lesson keeps its id, continuation lines join ---
l=$(R list); [ "$(printf '%s\n' "$l" | wc -l | tr -d ' ')" = 5 ] || die "list: $l"
printf '%s\n' "$l" | grep -q '^lc-0a1b2c3d	' || die "list: the lesson id is lost"
printf '%s\n' "$l" | grep -q 'A second line of the same rule' || die "list: continuation line lost"
printf '%s\n' "$l" | grep -q 'not a rule of the section' && die "list: read past the section"
ok "list reads the Project rules section only, keeps lesson ids, joins continuation lines"

# --- duplicates are proposed for merging, a contradiction is a question ---
rep=$(R report)
printf '%s\n' "$rep" | grep -q 'merge: .* repeat each other' || die "report: duplicate rules not found: $rep"
ok "report proposes merging duplicate rules"
printf '%s\n' "$rep" | grep -q 'ask the user: .*Never use raw SQL.*Always use raw SQL.*which one holds' || die "report: contradiction not raised as a question: $rep"
ok "report raises contradicting rules as a question to the user"
printf '%s\n' "$rep" | grep -q 'merge: .*Never use raw SQL' && die "report: a contradiction was proposed as a merge"
printf '%s\n' "$rep" | grep -q 'remove:' && die "report: removal proposed without review records"
ok "no removal is proposed before enough reviews are counted"

# --- the budget ---
printf '%s\n' "$rep" | grep -q 'within' || die "report: budget state: $rep"
over=$(RULES_BUDGET_BYTES=50 R report); printf '%s\n' "$over" | grep -q '(OVER)' || die "report: over budget not shown: $over"
ok "the budget is shown, and exceeded when the rules are larger"

# --- unused rules come from review records ---
mkrun() { # RUN CITED-TEXT: a run with a review gate record whose result cites the text
  mkdir -p ".agents/runs/$1/gates" ".agents/runs/$1/results"
  printf 'task_id: "%s"\ngate: "REVIEW_SMALL"\nresult: "pass"\nfocus: "rules+tests"\n' "$1" > ".agents/runs/$1/gates/001-REVIEW_SMALL.yaml"
  printf '%s\n' "$2" > ".agents/runs/$1/results/001-review.result.md"
}
i=1; while [ "$i" -le 10 ]; do
  mkrun "RV$i" "Checked: Never use raw SQL strings in handlers. Also: Always validate the request body before calling the repository layer. (lc-0a1b2c3d)"
  i=$((i + 1)); done
rep=$(R report)
printf '%s\n' "$rep" | grep -q 'remove: .*Always use raw SQL strings in handlers for reports.*' || die "report: an unused rule is not proposed for removal: $rep"
printf '%s\n' "$rep" | grep -q 'remove: .*Never use raw SQL' && die "report: a cited rule was proposed for removal"
printf '%s\n' "$rep" | grep -q 'remove: lc-0a1b2c3d' && die "report: a lesson cited by its id was proposed for removal"
printf '%s\n' "$rep" | grep -q 'cited by none of the 10 reviewed runs' || die "report: count from review records: $rep"
ok "a rule no review record cites is proposed for removal, counted from the review records (cited ones and cited lesson ids are not)"

# --- the counter outlives the run documents; only the lead tallies ---
expect_fail "a reviewer tallied" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh rules tally
R tally >/dev/null || die "tally"
[ -s .agents/local/rule-use.tsv ] || die "tally wrote nothing"
rm -rf .agents/runs/RV*
rep=$(R report); printf '%s\n' "$rep" | grep -q 'cited by none of the 10 reviewed runs' || die "report after the runs were cleaned: $rep"
R tally >/dev/null; [ "$(awk -F'	' '$2 == "-"' .agents/local/rule-use.tsv | wc -l | tr -d ' ')" = 10 ] || die "tally counted a run twice"
ok "the tally keeps the counts after the run documents are gone and counts a run once"

# --- nothing changes ---
[ "$(tsha AGENTS.md)" = "$sum0" ] || die "AGENTS.md changed"
expect_msg "an operation that changes a rule" 'no operation that changes a rule' sh ./.agents/scripts/rules.sh apply
expect_msg "removal" 'no operation that changes a rule' sh ./.agents/scripts/rules.sh remove lc-0a1b2c3d
[ "$(tsha AGENTS.md)" = "$sum0" ] || die "AGENTS.md changed after refused operations"
grep -Eq '^[[:space:]]*(apply|merge|remove|delete|edit|write)\)' .agents/scripts/rules.sh && die "rules.sh has an operation that edits"
ok "report, list and tally never change AGENTS.md, and no operation edits or deletes a rule"

# --- no rules: quiet ---
printf '# Project\n' > AGENTS.md
[ "$(R report)" = 'project rules: none' ] || die "no rules: $(R report)"
ok "a project without rules reports none"
echo "rules-test: all passed"
