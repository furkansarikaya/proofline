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
gate_rec LC 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|impl.txt:1|empty key returns nil|traced' 'REVIEW_SMALL-2|info|impl.txt:2|style note|none'
src=gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1

# --- ITEM 1: derive, and a candidate without a source cannot be written ---
d=$(L derive LC); [ "$(printf '%s\n' "$d" | wc -l | tr -d ' ')" = 1 ] && printf '%s' "$d" | grep -Fq "$src | kind=REVIEW_SMALL:rules+tests | empty key returns nil" || die "derive: $d"
ok "derive lists the non-info finding with its source and kind"
expect_msg "no source" 'no valid source' L write LC "" "always check the empty key"
expect_msg "a source that is no gate record" 'is not gate:' L write LC "REVIEW_SMALL-1" "always check the empty key"
expect_msg "a finding the record lacks" 'no non-info finding' L write LC gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-9 "always check the empty key"
expect_msg "an info finding" 'no non-info finding' L write LC gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-2 "style"
expect_msg "a gate record the run lacks" 'no gate record' L write LC gate:LC/009-QA "always check the empty key"
[ ! -f "$page" ] || die "a refused candidate created the page"
L write LC "$src" "Check the empty key before the lookup." > "$base/w.out" || die "a sourced candidate was refused"
cand=$(sed -n 's/^candidate written: \(lc-[0-9a-f]*\).*/\1/p' "$base/w.out"); [ -n "$cand" ] || die "no candidate id: $(cat "$base/w.out")"
L validate >/dev/null || die "a sourced candidate does not validate"
expect_msg "the same candidate twice" 'already written' L write LC "$src" "Check the empty key before the lookup."
expect_fail "a reviewer wrote a candidate" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh lessons write LC "$src" "x"
printf -- '- lc-deadbeef | kind=REVIEW_SMALL:rules+tests | run=LC | source= | status=candidate | invented lesson\n' >> "$page"
expect_msg "a hand-added row without a source" 'no source' L validate
sed -i.bak '/lc-deadbeef/d' "$page"; rm -f "$page.bak"
printf -- '- lc-cafe0000 | kind=QA:- | run=LC | source=gate:LC/004-QA#QA-1 | status=candidate | no such record\n' >> "$page"
expect_msg "a row whose gate record does not exist" 'invalid source' L validate
sed -i.bak '/lc-cafe0000/d' "$page"; rm -f "$page.bak"
L validate >/dev/null || die "the page stays valid after the bad rows are removed"
ok "a candidate without a source is refused by write and validate"

# --- ITEM 3: repeat count over different runs ---
gate_rec LC2 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|other.txt:3|same kind again|traced'
gate_rec LC2 002-QA QA "" 'QA-1|blocking|-|different kind|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=no" ] || die "count of two runs: $c"
c=$(L count QA:-); [ "$c" = "QA:- | runs=1 | repeats=0 | propose=no" ] || die "count of one run: $c"
gate_rec LC2 003-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|other.txt:4|again, same run|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=no" ] || die "a second record of one run counted twice: $c"
rm -rf .agents/runs/LC2   # a cleaned run is still counted from the page row it left
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=1 | repeats=0 | propose=no" ] || die "page row of the live run: $c"
gate_rec LC3 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|a.txt:1|third run|traced'
gate_rec LC4 001-REVIEW_SMALL REVIEW_SMALL rules+tests 'REVIEW_SMALL-1|blocking|a.txt:1|fourth run|traced'
c=$(L count REVIEW_SMALL:rules+tests); [ "$c" = "REVIEW_SMALL:rules+tests | runs=3 | repeats=2 | propose=yes" ] || die "second repeat does not propose: $c"
ok "the repeat count is per distinct run; the second repeat proposes promotion"

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
