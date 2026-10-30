#!/bin/sh
# shellcheck disable=SC1010,SC2015,SC2016,SC2034,SC2086,SC2154,SC2329 # test code: assertion chains, literal $( ) in fixtures, vars used by the sourced lib
# The status block (A202): ONE live status per task, updated in place at every lifecycle event. Markdown (a marked section of the task
# file) and GitHub (one comment, edited by its marker; a fake gh) through the real adapters and agent.sh; Jira and Linear against a
# stateful fake curl. Also: the block is excluded from the task contract hash and nothing can be smuggled through it, nothing local
# or secret reaches it (planted values), a parked task reads differently from a running one, and an unreachable tracker never
# fails a run.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
CP=$repo/control-plane/agents
# shellcheck source-path=SCRIPTDIR/../../control-plane/agents/scripts source=test-lib.sh
. "$CP/scripts/test-lib.sh"
tl_agents=$CP
command -v jq >/dev/null 2>&1 || { echo "status-block-test: jq is required"; exit 0; }
has() { grep -Fq -- "$2" "$1" || die "expected '$2' in $1"; }
hasnt() { if grep -Fq -- "$2" "$1"; then die "unexpected '$2' in $1"; fi; }
count() { grep -Fc -- "$2" "$1" || true; }
# the fixture repository with the REAL adapters (the shared fixture carries a markdown stub)
new_repo() {
  fx=$(mktemp -d "$base/fx.XXXXXX"); install_control_plane "$fx"
  cp "$CP"/task-integrations/* "$fx/.agents/task-integrations/"; chmod +x "$fx/.agents/task-integrations/"*.sh
  cd "$fx" || exit 1; git init -q -b main; printf '.agents/runs/\n.agents/local/\n' > .gitignore
}
TF=tasks/in-progress/LC.md
# a planted value of every kind that must never reach a block
PLANT_PATH=/Users/planted/secret-dir/notes.txt
PLANT_KEY=ghp_PLANTEDSECRET1234567890abcdef
PLANT_MAIL=planted.person@example.invalid
plant_check() { # FILE
  for pv in "$PLANT_PATH" '/Users/' 'planted' "$PLANT_KEY" "$PLANT_MAIL" 'AKIAPLANTED' 'hunter2'; do hasnt "$1" "$pv"; done
}

# ======================= markdown adapter: one section, replaced wholesale ===============================
MD=.agents/task-integrations/markdown.sh
new_repo; mkdir -p tasks/in-progress
printf '%s\n' '# Task: SB-1 — Status block' '' '**Status:** in-progress' '' '## Goal' '' 'Keep it small.' '' '## Acceptance criteria' '' '- AC-1: it works' > tasks/in-progress/SB-1.md
mkdir -p .agents/runs/SB-1; printf '%s\n' 'task_source:' '  type: local_markdown' '  path: tasks/in-progress/SB-1.md' '  revision: x' > .agents/runs/SB-1/RUN.yaml
f=tasks/in-progress/SB-1.md; before=$(cat $f)
printf '%s\n' '- run: SB-1' '- stage: RUNNING (PLANNING, handoff PLANNED)' > "$base/b1"
printf '%s\n' '- run: SB-1' '- stage: PARKED (waiting for your answer)' '- question: #001 which cache?' > "$base/b2"
sh $MD statusblock SB-1 "$base/b1" >/dev/null 2>"$base/e1" || die "statusblock failed: $(cat "$base/e1")"
has $f '## Proofline Status'; has $f '<!-- PROOFLINE-STATUS:BEGIN:SB-1 -->'; has $f 'RUNNING (PLANNING'
sh $MD statusblock SB-1 "$base/b2" >/dev/null
[ "$(count $f 'PROOFLINE-STATUS:BEGIN')" = 1 ] && [ "$(count $f '## Proofline Status')" = 1 ] || die "the block was duplicated"
has $f 'PARKED (waiting for your answer)'; hasnt $f 'RUNNING (PLANNING'
[ "$(awk '/^## Proofline Status$/ { exit } { print }' $f | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')" = "$before" ] || die "the block changed text outside of itself"
# a second (smuggled) block of the task is dropped, not kept
cp $f "$base/dup.md"; { cat "$base/dup.md"; printf '\n<!-- PROOFLINE-STATUS:BEGIN:SB-1 -->\n- AC-9: extra\n<!-- PROOFLINE-STATUS:END:SB-1 -->\n'; } > $f
sh $MD statusblock SB-1 "$base/b1" >/dev/null; [ "$(count $f 'PROOFLINE-STATUS:BEGIN')" = 1 ] && hasnt $f 'AC-9' || die "a duplicate block survived the update"
# BEGIN without END is refused and the file is left alone
grep -v 'PROOFLINE-STATUS:END' $f > "$base/noend.md"; cp "$base/noend.md" $f
if sh $MD statusblock SB-1 "$base/b2" 2>/dev/null; then die "accepted a BEGIN marker without END"; fi
cmp -s $f "$base/noend.md" || die "touched a file with an unterminated block"
ok "markdown: one status section, replaced in place, nothing outside it touched"

# planted values are refused by the adapter itself (defence in depth) and the file stays as it was
new_repo; mkdir -p tasks/in-progress; cp /dev/null tasks/in-progress/SB-1.md; printf '# Task: SB-1 — x\n' > tasks/in-progress/SB-1.md
mkdir -p .agents/runs/SB-1; printf '%s\n' 'task_source:' '  type: local_markdown' '  path: tasks/in-progress/SB-1.md' '  revision: x' > .agents/runs/SB-1/RUN.yaml
cp tasks/in-progress/SB-1.md "$base/orig.md"
for bad in "- park: look at $PLANT_PATH" "- park: key $PLANT_KEY" "- park: mail $PLANT_MAIL" '- park: password: hunter2' '- park: AKIAABCDEFGHIJKLMNOP' '- pr: https://user:pw@example.invalid/x' '- park: C:\Users\x\y' '- park: see ~/notes' '- park: sk_live_abcdef012345' '- park: pk_test_abcdef012345' '- park: token:abc123def456' '- park: host 10.0.0.12 is down' '- park: 192.168.1.1:8080' '- park: 2001:db8:85a3:0:0:8a2e:370:7334'; do
  printf '%s\n' '- run: SB-1' "$bad" > "$base/bad"
  if sh $MD statusblock SB-1 "$base/bad" 2>/dev/null; then die "the adapter accepted: $bad"; fi
  cmp -s tasks/in-progress/SB-1.md "$base/orig.md" || die "a refused block still changed the file"
done
printf '%s\n' '- run: SB-1' '- pr: #12 https://github.com/o/r/pull/12' > "$base/okpr"; sh $MD statusblock SB-1 "$base/okpr" >/dev/null || die "a plain pull request link was refused"
ok "adapter refuses planted paths, keys and addresses"

# ======================= through agent.sh: events, hash, scrub, park ====================================
new_repo; RID=LC
scaffold standalone yes
A freshness LC >/dev/null || die "fresh before any status"
frozen=$(rv task_source revision)
# the ask event: a question carrying planted values; the block names the question and how to answer, scrubbed
printf '1. Use %s with %s for %s and password: hunter2? key=AKIAPLANTEDKEYVALUE12\n   a) yes b) no\n' "$PLANT_PATH" "$PLANT_KEY" "$PLANT_MAIL" | A ask LC >/dev/null
has $TF '<!-- PROOFLINE-STATUS:BEGIN:LC -->'; has $TF '- run: LC'; has $TF 'PARKED (waiting for your answer)'; has $TF '- question: #001'; has $TF 'agent.sh answer LC 001 --captured'
plant_check $TF
hasnt $TF 'RUNNING'
A freshness LC >/dev/null || die "a status update made the task stale"
[ "$(rv task_source revision)" = "$frozen" ] || die "a status update moved the frozen revision"
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "not one block after ask"
ok "ask: the block shows the park, the question and how to answer; planted values scrubbed; freshness intact"
# the scrubber itself: a short key wrapped in quotes, brackets or after a colon is redacted too (else the adapter would refuse the whole update)
eval "$(awk '/^sb_scrub\(\)/ { p = 1 } p { print } p && /^}/ { exit }' "$CP/scripts/agent.sh")"
for wrapped in '(AKIAABCDEFGHIJKLMNOP)' '"sk-abc123def"' "'ghp_abcd1234'" 'key:ghp_abcd1234' '[xoxb-123]' 'token:abc' 'see C:foo' 'sk_live_abcdef012345' 'sk_test_abc' 'token:abc123def456' '10.0.0.12' '192.168.1.1:8080' '2001:db8:85a3:0:0:8a2e:370:7334' 'x.y.z.w1234567890abcdefghijklmnopqrstuvwxyzzzzz'; do
  case "$(printf 'use %s now' "$wrapped" | sb_scrub)" in *AKIA*|*sk-abc*|*sk_*|*ghp_*|*xoxb*|*:abc*|*C:foo*|*abc123def456*|*10.0.0*|*192.168*|*2001*|*db8*|*xyz*) die "the scrubber kept $wrapped" ;; esac
done
[ "$(printf 'which cache? a) yes' | sb_scrub)" = 'which cache? a yes' ] || die "the scrubber damaged a plain question"
[ "$(printf 'caf\303\251 $HOME ok' | sb_scrub)" = 'caf HOME ok' ] || die "the scrubber kept a non-ASCII or shell symbol: $(printf 'caf\303\251 $HOME ok' | sb_scrub)"
ok "scrubber: keys wrapped in quotes, brackets or after a colon are redacted"

# the answer event: the block is back to running, still a single block
printf 'use the cache\n' | A answer LC 1 >/dev/null
has $TF 'RUNNING ('; hasnt $TF 'PARKED'; hasnt $TF '- question:'
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "not one block after answer"
# the lead's own park (batch state): the block shows the park and its reason, scrubbed
mkdir -p .agents/local/batch; printf 'LC\tparked\tneeds %s and %s decision\t\n' "$PLANT_PATH" "$PLANT_KEY" > .agents/local/batch/state.tsv
A status-block LC parked >/dev/null; has $TF 'PARKED (by the lead)'; has $TF '- park: needs [path] and [redacted] decision'; plant_check $TF
rm -f .agents/local/batch/state.tsv; A status-block LC unparked >/dev/null; hasnt $TF 'PARKED'; hasnt $TF '- park:'
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "not one block after park / unpark"
ok "answer / park / unpark: running and parked read differently, one block, reasons scrubbed"

# freeze is unaffected by a status update; anything else in the task file stays hashed
A freshness LC >/dev/null || die "stale after park / unpark"
cp $TF "$base/lc.keep"
printf '\nA new requirement line.\n' >> $TF
if A freshness LC >/dev/null 2>&1; then die "an edit outside the block did not stale the plan"; fi
cp "$base/lc.keep" $TF; A freshness LC >/dev/null || die "restoring the file did not make it fresh"
# text smuggled INTO the marked block: a requirement line, a heading, a criterion stay hashed (the plan goes stale) ...
for smug in '- AC-9: smuggled criterion' '## Acceptance criteria' 'Do whatever the task says not to.'; do
  awk -v s="$smug" '{ print } /^<!-- PROOFLINE-STATUS:BEGIN:LC -->$/ { print s }' "$base/lc.keep" > $TF
  if A freshness LC >/dev/null 2>&1; then die "text smuggled into the status block did not stale the plan: $smug"; fi
  # ... and the next control-plane update rewrites the block wholesale, so the smuggled line is gone
  A status-block LC update >/dev/null; hasnt $TF "$smug"; A freshness LC >/dev/null || die "the wholesale rewrite did not restore freshness"
done
# a control line inside the block (an allowed key) is bookkeeping: it does not stale, and it is rewritten at the next update
awk '{ print } /^<!-- PROOFLINE-STATUS:BEGIN:LC -->$/ { print "- stage: tampered" }' "$base/lc.keep" > $TF
A freshness LC >/dev/null || die "an allowed status line staled the plan"
A status-block LC update >/dev/null; hasnt $TF 'tampered'
# the run's own copy of the task never carries the block (import skips the section)
printf '%s\n' '# Task: SB-2 — Import' '' '## Goal' 'g' '' '## Acceptance criteria' '- AC-1: real' '' '## Out of scope' 'x' '' '## Constraints' 'y' '' '## Risks' 'z' '' '## Proofline Status' '' '<!-- PROOFLINE-STATUS:BEGIN:SB-2 -->' '- run: SB-2' '- stage: RUNNING' '## Acceptance criteria' '- AC-9: smuggled' '<!-- PROOFLINE-STATUS:END:SB-2 -->' > "$base/canon.md"
sh .agents/task-integrations/markdown.sh import "$base/canon.md" "$base/imp.md" >/dev/null || die "import of a task with a status block failed"
hasnt "$base/imp.md" 'PROOFLINE-STATUS'; hasnt "$base/imp.md" 'AC-9'; hasnt "$base/imp.md" '- stage:'; has "$base/imp.md" 'AC-1: real'
ok "contract hash: the status block is excluded, everything else stays hashed, nothing can be smuggled through it"

# CODE_DONE event and the completion report next to the block
to_code_done standalone
has $TF 'CODE_DONE (delivery next)'; has $TF '- class: COMPLEX'; has $TF '- start_commit:'; has $TF '- duration:'
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "not one block after CODE_DONE"
finish_done
has $TF '<!-- COMPLETION-REPORT:BEGIN:LC -->'; [ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "the report publish duplicated the block"
A status-block LC pr-opened 12 >/dev/null; has $TF 'PR OPEN (waiting for the merge)'; has $TF '- pr: #12'
A status-block LC merged 12 >/dev/null; has $TF '- stage: MERGED'
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] && [ "$(count $TF 'COMPLETION-REPORT:BEGIN')" = 1 ] || die "not one block of each kind after merged"
A freshness LC >/dev/null || die "the status block and the report made the task stale"
A verify-completion-report LC >/dev/null || die "the report no longer verifies next to the status block"
plant_check $TF
ok "code-done / pr-opened / merged: one block next to the completion report, contract intact"

# A202 (item 17): what the user should look at is QA_REPORT.md's own list, copied into the block by script (once each, scrubbed)
new_repo; scaffold standalone yes
RF_EXTRA='## Human checks

- The error text reads naturally in Turkish
- The empty state looks balanced, see '"$PLANT_PATH" to_code_done standalone
has $TF '- look_at: The error text reads naturally in Turkish'
[ "$(count $TF '- look_at:')" = 2 ] || die "the Human checks list is not in the block exactly once: $(grep look_at $TF)"
plant_check $TF
A status-block LC update >/dev/null; [ "$(count $TF '- look_at:')" = 2 ] || die "an update doubled the look_at lines"
ok "the QA report's Human checks list reaches the status block by script, once, scrubbed"

# FAILED / BLOCKED event
new_repo; scaffold standalone yes
printf 'reason: the build keeps failing on %s with %s attempts\nevidence: the failing gate records and the failing command output (long enough)\n' "$PLANT_PATH" "$PLANT_KEY" | A terminate LC BLOCKED >/dev/null
has $TF 'PARKED (BLOCKED)'; has $TF '- failure: BLOCKED: the build keeps failing on [path]'; plant_check $TF
[ "$(count $TF 'PROOFLINE-STATUS:BEGIN')" = 1 ] || die "not one block after terminate"
ok "terminate: the block shows the failure reason, scrubbed"

# ======================= GitHub: one comment, edited by its marker (stateful fake gh) ====================
fb=$base/bin; mkdir -p "$fb"; gx=$base/ghstate; mkdir -p "$gx/c"; : > "$gx/next"; echo 100 > "$gx/next"
cat > "$fb/gh" <<'GHEOF'
#!/bin/sh
# stateful fake gh: comments are files c/<id>.body; --jq filters run through jq over {"comments":[{body,url}]}
n=$(cat "$GX/next")
case "$1 $2" in
  "auth status") exit 0 ;;
  "issue view")
    jqf=''; while [ $# -gt 0 ]; do [ "$1" = --jq ] && jqf=$2; shift; done
    { printf '{"comments":['; sep=''; for f in "$GX"/c/*.body; do [ -f "$f" ] || continue; id=$(basename "$f" .body)
        printf '%s{"body":%s,"url":"https://github.com/o/r/issues/42#issuecomment-%s"}' "$sep" "$(jq -Rs . < "$f")" "$id"; sep=','; done; printf ']}'; } | jq -r "$jqf" ;;
  "issue comment") while [ $# -gt 0 ]; do [ "$1" = --body-file ] && { cp "$2" "$GX/c/$n.body"; echo $((n + 1)) > "$GX/next"; echo created >> "$GX/log"; }; shift; done ;;
  "api -X") id=''; for a in "$@"; do case "$a" in repos/*/issues/comments/*) id=${a##*/} ;; body=@*) cp "${a#body=@}" "$GX/c/$id.body"; echo patched >> "$GX/log" ;; esac; done ;;
  *) exit 1 ;;
esac
GHEOF
chmod +x "$fb/gh"; GX=$gx; export GX
GHS=.agents/task-integrations/github.sh
new_repo; : > "$gx/log"
printf '# Completion Report: GH-42\n\n## Implementation Summary\ndone\n' > "$base/ghrep.md"
for ev in run-start ask code-done pr-opened merged; do
  printf '%s\n' '- run: GH-42' "- event: $ev" "- stage: after $ev" > "$base/ghb"
  PATH=$fb:$PATH sh $GHS statusblock GH-42 "$base/ghb" || die "github statusblock $ev"
  [ "$(grep -l 'proofline:status:GH-42' "$gx"/c/*.body | wc -l | tr -d ' ')" = 1 ] || die "not exactly one status comment after $ev"
done
PATH=$fb:$PATH sh $GHS publish GH-42 "$base/ghrep.md" >/dev/null 2>&1 || :
PATH=$fb:$PATH sh $GHS statusblock GH-42 "$base/ghb" || die "statusblock after publish"
[ "$(grep -l 'proofline:status:GH-42' "$gx"/c/*.body | wc -l | tr -d ' ')" = 1 ] || die "a second status comment appeared after the report"
[ "$(grep -l 'proofline:completion-report:GH-42' "$gx"/c/*.body | wc -l | tr -d ' ')" = 1 ] || die "the completion-report comment was lost or doubled"
sc=$(grep -l 'proofline:status:GH-42' "$gx"/c/*.body); has "$sc" 'after merged'; hasnt "$sc" 'after run-start'
[ "$(grep -c created "$gx/log")" -le 2 ] && [ "$(grep -c patched "$gx/log")" -ge 5 ] || die "events created new comments instead of editing: $(tr '\n' ' ' < "$gx/log")"
printf '%s\n' '- run: GH-42' "- park: $PLANT_PATH" > "$base/ghbad"
if PATH=$fb:$PATH sh $GHS statusblock GH-42 "$base/ghbad" 2>/dev/null; then die "github accepted a local path"; fi
ok "github: one status comment, edited in place at every event, next to the report comment"

# ======================= Jira / Linear: stateful fake curl ===============================================
cb=$base/cbin; mkdir -p "$cb"; cx=$base/curlstate; mkdir -p "$cx"; echo '[]' > "$cx/jira"; echo '[]' > "$cx/lin"; : > "$cx/log"; echo 500 > "$cx/next"
cat > "$cb/curl" <<'CEOF'
#!/bin/sh
# stateful fake curl for the comment calls of jira.sh and linear.sh
cat > /dev/null
[ -z "${CX_FAIL:-}" ] || exit 7
url=''; method=GET; data=''
while [ $# -gt 0 ]; do case "$1" in -X) method=$2; shift ;; --data-binary) data=${2#@}; shift ;; http*) url=$1 ;; esac; shift; done
n=$(cat "$CX/next")
case "$url" in
  */rest/api/3/issue/*/comment/*) id=${url##*/}; jq --argjson id "$id" --slurpfile d "$data" 'map(if .id == ($id|tostring) then .body = $d[0].body else . end)' "$CX/jira" > "$CX/jira.t" && mv "$CX/jira.t" "$CX/jira"; echo "jira PUT $id" >> "$CX/log"; echo '{}' ;;
  */rest/api/3/issue/*/comment*) if [ "$method" = POST ]; then jq --slurpfile d "$data" --arg id "$n" '. + [{id:$id, body:$d[0].body}]' "$CX/jira" > "$CX/jira.t" && mv "$CX/jira.t" "$CX/jira"; echo $((n + 1)) > "$CX/next"; echo "jira POST" >> "$CX/log"; echo '{}'
      else jq '{comments: .}' "$CX/jira"; fi ;;
  */graphql) q=$(jq -r .query "$data")
    case "$q" in
      *commentUpdate*) id=$(jq -r .variables.i "$data"); b=$(jq -r .variables.b "$data"); jq --arg id "$id" --arg b "$b" 'map(if .id == $id then .body = $b else . end)' "$CX/lin" > "$CX/lin.t" && mv "$CX/lin.t" "$CX/lin"; echo "linear UPDATE $id" >> "$CX/log"; echo '{"data":{"commentUpdate":{"success":true}}}' ;;
      *commentCreate*) b=$(jq -r .variables.b "$data"); jq --arg id "$n" --arg b "$b" '. + [{id:$id, body:$b}]' "$CX/lin" > "$CX/lin.t" && mv "$CX/lin.t" "$CX/lin"; echo $((n + 1)) > "$CX/next"; echo "linear CREATE" >> "$CX/log"; echo '{"data":{"commentCreate":{"success":true}}}' ;;
      *comments*) jq '{data:{issue:{comments:{nodes: .}}}}' "$CX/lin" ;;
      *) echo '{"data":{}}' ;;
    esac ;;
  *) echo '{}' ;;
esac
CEOF
chmod +x "$cb/curl"; CX=$cx; export CX
JENV="JIRA_API_TOKEN=SECRET-VALUE-123 JIRA_BASE_URL=https://example.invalid JIRA_EMAIL=a@example.invalid"
LENV="LINEAR_API_KEY=SECRET-VALUE-123 LINEAR_API_URL=https://example.invalid/graphql"
new_repo
for ev in run-start ask code-done pr-opened merged; do
  printf '%s\n' '- run: PROJ-7' "- event: $ev" "- stage: after $ev" > "$base/jb"
  env $JENV PATH="$cb:$PATH" sh .agents/task-integrations/jira.sh statusblock PROJ-7 "$base/jb" || die "jira statusblock $ev"
  env $LENV PATH="$cb:$PATH" sh .agents/task-integrations/linear.sh statusblock ENG-7 "$base/jb" || die "linear statusblock $ev"
  [ "$(jq length "$cx/jira")" = 1 ] || die "jira: not exactly one comment after $ev: $(jq length "$cx/jira")"
  [ "$(jq length "$cx/lin")" = 1 ] || die "linear: not exactly one comment after $ev"
done
jq -e '.[0].body.content | map(.content[0].text) | join(" ") | contains("after merged")' "$cx/jira" >/dev/null || die "jira comment not updated to the last event"
jq -e '.[0].body | contains("after merged") and startswith("<!-- proofline:status:ENG-7 -->")' "$cx/lin" >/dev/null || die "linear comment not updated to the last event"
[ "$(grep -c 'jira POST' "$cx/log")" = 1 ] && [ "$(grep -c 'jira PUT' "$cx/log")" = 4 ] || die "jira calls: $(tr '\n' ' ' < "$cx/log")"
[ "$(grep -c 'linear CREATE' "$cx/log")" = 1 ] && [ "$(grep -c 'linear UPDATE' "$cx/log")" = 4 ] || die "linear calls: $(tr '\n' ' ' < "$cx/log")"
printf '%s\n' '- run: PROJ-7' "- park: key $PLANT_KEY" > "$base/jbad"
if env $JENV PATH="$cb:$PATH" sh .agents/task-integrations/jira.sh statusblock PROJ-7 "$base/jbad" 2>/dev/null; then die "jira accepted a secret"; fi
if env $LENV PATH="$cb:$PATH" sh .agents/task-integrations/linear.sh statusblock ENG-7 "$base/jbad" 2>/dev/null; then die "linear accepted a secret"; fi
ok "jira and linear: one status comment found by its marker and updated at every event (fake curl)"

# ======================= an unreachable tracker never fails a run ========================================
new_repo; scaffold standalone yes
sed 's/^  adapter: markdown$/  adapter: jira/' .agents/config.yaml > .agents/config.yaml.t && mv .agents/config.yaml.t .agents/config.yaml
grep -Fq '  adapter: jira' .agents/config.yaml || die 'config adapter not switched'
rc=0; out=$(env $JENV CX_FAIL=1 PATH="$cb:$PATH" sh ./.agents/scripts/agent.sh status-block LC ask 2>&1) || rc=$?
[ "$rc" = 0 ] || die "an unreachable tracker failed the status-block command (rc=$rc): $out"
printf '%s' "$out" | grep -Fq 'status block of LC was not updated' || die "no note about the failed update: $out"
printf '1. a question?\n   a) yes b) no\n' | env $JENV CX_FAIL=1 PATH="$cb:$PATH" sh ./.agents/scripts/agent.sh ask LC >/dev/null 2>&1 || die "ask failed because the tracker was down"
[ -s .agents/local/status-block.log ] || die "no log note for the failed update"
ok "unreachable tracker: a note, never a failed run"

echo "status-block-test: all passed"
