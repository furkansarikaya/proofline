#!/bin/sh
# Tests for lessons.sh: candidates need a source, a promotion needs the user's approval, the repeat count
# is a script's count over different runs.
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents, base come from test-lib.sh
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
scaffold standalone no STANDARD manual
cp "$tl_agents/scripts/lessons.sh" .agents/scripts/
L() { A lessons "$@"; }
page=docs/wiki/lessons/observations.md
# gate_rec RUN GATE-FILE-NAME GATE FOCUS ROWS... : a failing gate record as write_gate lays it out
gate_rec() {
  gr_run=$1 gr_name=$2 gr_gate=$3 gr_focus=$4; shift 4
  mkdir -p ".agents/runs/$gr_run/gates"
  { printf 'task_id: "%s"\ngate: "%s"\nresult: "fail"\nfocus: "%s"\n' "$gr_run" "$gr_gate" "$gr_focus"
    for gr_row in "$@"; do printf 'finding: %s\n' "$gr_row"; done; } > ".agents/runs/$gr_run/gates/$gr_name.yaml"
}
gate_rec LC 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|impl.txt:1|empty key returns nil|traced' 'REVIEW_SMALL-2|info|impl.txt:2|style note|none' 'REVIEW_SMALL-3|blocking|impl.txt:3|second finding|traced'
g1=$(tsha .agents/runs/LC/gates/001-REVIEW_SMALL.yaml)
src=gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@$g1

# --- ITEM 1: derive, and a candidate without a source cannot be written ---
d=$(L derive LC); [ "$(printf '%s\n' "$d" | wc -l | tr -d ' ')" = 2 ] && printf '%s' "$d" | grep -Fq "$src | kind=REVIEW_SMALL:rules+tests | empty key returns nil" || die "derive: $d"
ok "derive lists the non-info finding with its source and kind"
expect_msg "no source" 'no valid source' L write LC "" "always check the empty key"
expect_msg "a source that is no gate record" 'is not gate:' L write LC "REVIEW_SMALL-1" "always check the empty key"
expect_msg "a finding the record lacks" 'no non-info finding' L write LC "gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-9@$g1" "always check the empty key"
expect_msg "an info finding" 'no non-info finding' L write LC "gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-2@$g1" "style"
expect_msg "a gate record the run lacks" 'no gate record' L write LC "gate:LC/009-QA@$g1" "always check the empty key"
expect_msg "a source without a record hash" 'is not gate:' L write LC gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1 "always check the empty key"
expect_msg "a wrong record hash" 'hash differs' L write LC "gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@$(printf 0%.0s $(seq 64))" "always check the empty key"
expect_msg "an invented run id" 'source is run' L write LC "gate:INVENTED/001-REVIEW_SMALL#REVIEW_SMALL-1@$g1" "always check the empty key"
[ ! -f "$page" ] || die "a refused candidate created the page"
L write LC "$src" "Check the empty key before the lookup." > "$base/w.out" || die "a sourced candidate was refused"
cand=$(sed -n 's/^candidate written: \(lc-[0-9a-f]*\).*/\1/p' "$base/w.out"); [ -n "$cand" ] || die "no candidate id: $(cat "$base/w.out")"
L validate >/dev/null || die "a sourced candidate does not validate"
expect_msg "the same candidate twice" 'already written' L write LC "$src" "Check the empty key before the lookup."
expect_fail "a reviewer wrote a candidate" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh lessons write LC "$src" "x"
printf -- '- lc-deadbeef | kind=REVIEW_SMALL:rules+tests | run=LC | source= | status=candidate | invented lesson\n' >> "$page"
expect_msg "a hand-added row without a source" 'no source' L validate
sed -i.bak '/lc-deadbeef/d' "$page"; rm -f "$page.bak"
printf -- '- lc-cafe0000 | kind=QA:- | run=LC | source=gate:LC/004-QA#QA-1@%s | status=candidate | no such record\n' "$g1" >> "$page"
expect_msg "a row whose gate record does not exist" 'invalid source' L validate
sed -i.bak '/lc-cafe0000/d' "$page"; rm -f "$page.bak"
printf -- '- lc-1ee70000 | kind=REVIEW_SMALL:rules+tests | run=GHOST | source=gate:GHOST/001-REVIEW_SMALL#REVIEW_SMALL-1@%s | status=candidate | invented run\n' "$g1" >> "$page"
expect_msg "a row of an invented run id" 'neither seen' L validate
sed -i.bak '/lc-1ee70000/d' "$page"; rm -f "$page.bak"
L validate >/dev/null || die "the page stays valid after the bad rows are removed"
ok "a candidate without a source is refused by write and validate"

# --- ITEM 3: repeat count over different runs ---
gate_rec LC2 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|other.txt:3|same kind again|traced'
gate_rec LC2 002-QA QA "" 'QA-1|blocking|-|different kind|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=yes" ] || die "second run does not propose: $c"
c=$(L count QA:-); [ "$c" = "QA:- | runs=1 | repeats=0 | propose=no" ] || die "count of one run: $c"
gate_rec LC2 003-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|other.txt:4|again, same run|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=yes" ] || die "a second record of one run counted twice: $c"
rm -rf .agents/runs/LC2   # a cleaned run is still counted from the page row it left
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=1 | repeats=0 | propose=no" ] || die "page row of the live run: $c"
gate_rec LC3 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|a.txt:1|third run|traced'
gate_rec LC4 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|a.txt:1|fourth run|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=3 | repeats=2 | propose=yes" ] || die "a repeat does not propose: $c"
ok "the repeat count is per distinct run; the first repeat (second run) proposes promotion"
gate_rec LC5 001-QA QA "" 'QA-1|blocking|-|a cleaned run|traced'
L write LC5 "gate:LC5/001-QA#QA-1@$(tsha .agents/runs/LC5/gates/001-QA.yaml)" "Cleaned-run lesson." >/dev/null || die "write for LC5 failed"
rm -rf .agents/runs/LC5
L validate >/dev/null || die "a row of a cleaned run that write saw was rejected"
ok "a cleaned run's row stays valid through the hash write recorded"

# --- ITEM 2: promotion needs the user's approval ---
printf '# Project\n\n## Boot\n\ntext\n' > AGENTS.md
expect_msg "no approval" 'promotion refused' L promote LC "$cand"
grep -q 'empty key' AGENTS.md && die "AGENTS.md changed without an approval"
expect_msg "an unknown candidate" 'no candidate' L promote LC lc-00000000
expect_msg "an approval request for an unknown candidate" 'no candidate' A request-approval LC rule:lc-00000000
A request-approval LC "rule:$cand" > "$base/rq.out" || die "request-approval rule failed"
grep -Fq 'Check the empty key before the lookup.' "$base/rq.out" || die "the user is not shown the rule text: $(cat "$base/rq.out")"
expect_msg "an asked but unanswered approval" 'promotion refused' L promote LC "$cand"
capture 'approve the plan'
expect_fail "another kind's approval word" A approve LC "rule:$cand"
capture "I approve the rule $cand"
A approve LC "rule:$cand" >/dev/null || die "the user's approval sentence was refused"
expect_fail "a reviewer promoted" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh lessons promote LC "$cand"
grep -q 'empty key' AGENTS.md && die "AGENTS.md changed before the promotion"
L promote LC "$cand" >/dev/null || die "an approved candidate was not promoted"
grep -q '^## Project rules' AGENTS.md && grep -Fq -- "- Check the empty key before the lookup. (lesson $cand)" AGENTS.md || die "rule not in AGENTS.md: $(cat AGENTS.md)"
grep -q "status=promoted" "$page" || die "row not marked promoted"
expect_msg "the approval is single use" 'already promoted' L promote LC "$cand"
L validate >/dev/null || die "the page is invalid after promotion"
ok "a rule reaches AGENTS.md only after the user's recorded approval, once"

# --- a lesson with backslashes reaches AGENTS.md verbatim; a refused consume leaves AGENTS.md untouched ---
cand2=$(L write LC "gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-3@$g1" 'Escape \n as \\n in paths like C:\tmp.' | sed -n 's/^candidate written: \(lc-[0-9a-f]*\).*/\1/p')
[ "$(L bound LC "$cand2" | wc -c | tr -d ' ')" = 65 ] || die "the approval binding is not a full sha256"
cp AGENTS.md "$base/agents.before"
expect_msg "no approval for the second candidate" 'promotion refused' L promote LC "$cand2"
cmp -s AGENTS.md "$base/agents.before" || die "AGENTS.md changed although the approval was missing"
ls AGENTS.md.lessons.* >/dev/null 2>&1 && die "a temp file was left behind"
A request-approval LC "rule:$cand2" >/dev/null; capture "I approve the rule $cand2"; A approve LC "rule:$cand2" >/dev/null || die "approval of the second candidate refused"
L promote LC "$cand2" >/dev/null || die "second promotion failed"
grep -Fq -- '- Escape \n as \\n in paths like C:\tmp. (lesson' AGENTS.md || die "backslashes were expanded: $(cat AGENTS.md)"
ok "backslashes survive promotion; a refused approval leaves AGENTS.md untouched; the binding is a full sha256"
