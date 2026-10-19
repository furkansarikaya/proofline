#!/bin/sh
# Friction report (A152) and calibration suggestions (A153). Run through `agent.sh friction ...` / `agent.sh calibrate`.
#   friction.sh report <ID>   build .agents/local/friction/latest.md from the run's LEDGER.log and records.jsonl
#                             (called by agent.sh when a run ends); counts only, anonymous, validated before it is written
#   friction.sh show          print the report
#   friction.sh issue-cmd     print the `gh issue create` command a send would run; runs nothing
#   friction.sh send          lead only: consume the user's `report` approval (bound to the report's sha256), then
#                             run that command. Without the approval nothing is sent and gh is never started.
#   friction.sh calibrate     print config suggestions from metrics and plans. Read-only: it never edits a file.
# The report holds counts and controlled identifiers only (roles, gates, runtimes, models). It never holds the run
# id, a path, a name or free text, and a scrub check refuses to write it if a line has a character outside a small
# set or mentions the project directory, the git user, the git email or $USER.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
out=$root/.agents/local/friction
repo=furkansarikaya/proofline
gh_bin=gh
[ "${PROOFLINE_TEST:-}" != 1 ] || gh_bin=${PROOFLINE_GH:-gh}   # test seam only: the env never picks the binary that runs after an approval
cfgv() { sh "$here/agent.sh" config-get "$1" 2>/dev/null || echo "$2"; }
# jsum FILE ID KEY: sum of the non-null integer KEY over the records of run ID, then "reported/total"
tokens_of() {
  awk -v id="$1" '
    function jv(s, k,   p, i, r) { p = "\"" k "\":"; i = index(s, p); if (!i) return ""; r = substr(s, i + length(p)); sub(/[,}].*/, "", r); return r }
    index($0, "\"task\":\"" id "\"") && jv($0, "kind") != "\"run\"" { n++; for (j = 1; j <= 3; j++) { k = (j == 1 ? "tokens_in" : j == 2 ? "tokens_out" : "tokens_total"); v = jv($0, k); if (v ~ /^[0-9]+$/) { s[j] += v; c[j]++ } } }
    END { for (j = 1; j <= 3; j++) printf "%s%s", (c[j] ? s[j] " (" c[j] " of " n " records)" : "n/a"), (j < 3 ? "|" : "\n") }' "$2" 2>/dev/null
}
scrub() { # FILE: 0 when it is safe to share
  sc_bad=$(grep -n -v '^[A-Za-z0-9 _.:,;=()%+<>#*|-]*$' "$1" | head -1)
  [ -z "$sc_bad" ] || { echo "friction: line $sc_bad has a character outside the allowed set" >&2; return 1; }
  for sc_w in "$(basename "$root")" "$(git -C "$root" config user.name 2>/dev/null)" "$(git -C "$root" config user.email 2>/dev/null)" "${USER:-}"; do
    [ "${#sc_w}" -ge 4 ] || continue
    # the word "proofline" is the report's own header, not the project name
    if sed 's/proofline//g' "$1" | grep -qiF -- "$sc_w"; then echo "friction: the report mentions the project directory, the git identity or the user name; not written" >&2; return 1; fi
  done
}
report() {
  id=${1:-}; case "$id" in ''|*[!A-Za-z0-9_-]*) echo "usage: friction.sh report <ID>" >&2; exit 2 ;; esac
  led=$root/.agents/runs/$id/LEDGER.log; rec=$root/.agents/local/metrics/records.jsonl
  [ -f "$led" ] || { echo "friction: no ledger for the run" >&2; exit 1; }
  [ "$(sh "$here/agent.sh" config-get metrics 2>/dev/null || echo on)" != off ] || rec=/dev/null
  tk=$(tokens_of "$id" "$rec")
  mkdir -p "$out" || exit 1
  tmp=$out/.latest.$$
  {
    printf '# proofline friction report\n\nschema: proofline.friction.v1\n\n'
    awk '
      function w(s) { gsub(/[^A-Za-z0-9_.+:-]/, "", s); return s }
      / event=classify / { cls = $0; sub(/.* detail=/, "", cls); sub(/ .*/, "", cls); cls = w(cls) }
      / event=ask / { ask++ }
      / event=answer / { if ($0 ~ /answered_by=user/) au++; else al++ }
      / event=approval-request / { ar++ }
      / event=decide / { dec++ }
      / event=terminate / { term = $0; sub(/.* to=/, "", term); sub(/ .*/, "", term); term = w(term) }
      / event=handoff:DONE / { done = 1 }
      / event=note .*failover/ { fo++; if ($0 ~ /reason=timeout/) fot++ }
      match($0, / event=gate:[A-Z_]+:fail /) { g = substr($0, RSTART + 12, RLENGTH - 18); gf[w(g)]++; gft++ }
      match($0, / event=record:[a-z_]+:BLOCKED /) { b = substr($0, RSTART + 14, RLENGTH - 23); bl[w(b)]++; blt++ }
      END {
        printf "outcome: %s\nclassification: %s\n\n", (done ? "done" : (term ? tolower(term) : "open")), (cls ? cls : "n/a")
        printf "## User interruptions\n\n- questions asked: %d (answered by the user: %d, by an assumption: %d)\n- approval requests: %d\n- total times the user was asked: %d\n\n", ask, au, al, ar, ask + ar
        printf "## Blocked and failed gates\n\n- gate failures: %d\n", gft
        for (k in gf) printf "  - gate %s failed %d times\n", k, gf[k]
        printf "- steps that returned blocked: %d\n", blt
        for (k in bl) printf "  - role %s blocked %d times\n", k, bl[k]
        printf "\n## Timeouts\n\n- runtime failovers: %d (of them by timeout: %d)\n", fo, fot
      }' "$led"
    awk -v id="$id" '
      function jv(s, k,   p, i, r) { p = "\"" k "\":"; i = index(s, p); if (!i) return ""; r = substr(s, i + length(p)); sub(/[,}].*/, "", r); gsub(/"/, "", r); return r }
      index($0, "\"task\":\"" id "\"") { k = jv($0, "kind"); r = jv($0, "result")
        if (k == "dispatch") { nd++; if (r == "timeout") dt++ }
        if (k == "run" && !seen) { seen = 1; fr = jv($0, "fix_rounds"); de = jv($0, "delegations"); du = jv($0, "duration_s") } }
      END { printf "- dispatch timeouts: %d (of %d dispatches)\n\n## Repeated rounds\n\n- fix rounds used: %s\n- delegated steps: %s\n\n## Cost\n\n- run duration seconds: %s\n", dt, nd, (fr ~ /^[0-9]+$/ ? fr : "n/a"), (de ~ /^[0-9]+$/ ? de : "n/a"), (du ~ /^[0-9]+$/ ? du : "n/a") }' "$rec"
    printf '%s\n' "$tk" | awk -F'|' '{ printf "- tokens in: %s\n- tokens out: %s\n- tokens total: %s\n", $1, $2, $3 }'
  } > "$tmp" || { rm -f "$tmp"; exit 1; }
  scrub "$tmp" || { rm -f "$tmp"; exit 1; }
  mv "$tmp" "$out/latest.md" && echo "friction report: .agents/local/friction/latest.md (review it; sending needs your approval)"
}
issue_cmd() {
  [ -f "$out/latest.md" ] || { echo "friction: no report yet" >&2; exit 1; }
  printf '%s issue create --repo %s --title "proofline friction report" --body-file .agents/local/friction/latest.md\n' "$gh_bin" "$repo"
}
send() {
  [ "${AGENT_ROLE:-lead}" = lead ] || { echo "friction: only the lead sends" >&2; exit 2; }
  [ -f "$out/latest.md" ] || { echo "friction: no report yet" >&2; exit 1; }
  scrub "$out/latest.md" || exit 1
  sh "$here/agent.sh" approval-consume - report || { echo "friction: nothing sent. Ask the user: agent.sh request-approval - report (relay it verbatim)" >&2; exit 1; }
  # the command issue-cmd prints, run from the project root
  # shellcheck disable=SC2086
  (cd "$root" && $gh_bin issue create --repo "$repo" --title "proofline friction report" --body-file .agents/local/friction/latest.md)
}
calibrate() {
  bud=$(cfgv test_trust.mutation_budget 20); to=$(cfgv dispatch.timeout_seconds 1800); mfr=$(cfgv review.max_fix_rounds 2)
  runs=0 maxn=0
  for p in "$root"/.agents/runs/*/PLAN.md; do
    [ -f "$p" ] || continue
    n=$(awk '/^## /{ i = ($0 ~ /^## Tests/); next } i && match($0, /^[ \t]*[-*][ \t]+AC-[0-9]+:/) { a = substr($0, RSTART, RLENGTH); sub(/^[^A]*/, "", a); seen[a] = 1 } END { n = 0; for (k in seen) n++; print n }' "$p")
    runs=$((runs + 1)); [ "$n" -le "$maxn" ] || maxn=$n
  done
  rec=$root/.agents/local/metrics/records.jsonl; s=0
  echo "calibration suggestions (read-only; nothing was changed, edit .agents/config.yaml yourself if you agree)"
  echo "seen: $runs plans, most criteria in one plan: $maxn; test_trust.mutation_budget: $bud"
  if [ "$maxn" -gt "$bud" ]; then s=1; echo "suggest: test_trust.mutation_budget $maxn (a plan names $maxn criteria, one mutant each is the minimum; today that costs an approval per run)"
  elif [ "$maxn" -gt 0 ] && [ "$bud" -gt $((maxn * 2)) ]; then s=1; echo "suggest: test_trust.mutation_budget $((maxn + maxn / 2)) (the budget is more than twice the largest plan; a lower budget shortens the mutation step)"; fi
  if [ -f "$rec" ]; then
    mx=$(awk 'function jv(s, k,   p, i, r) { p = "\"" k "\":"; i = index(s, p); if (!i) return ""; r = substr(s, i + length(p)); sub(/[,}].*/, "", r); return r }
      /"kind":"dispatch"/ { d = jv($0, "duration_s") + 0; if (d > m) m = d; if (jv($0, "result") == "\"timeout\"") t++ } END { print m + 0, t + 0 }' "$rec")
    if [ "${mx% *}" -ge $((to * 8 / 10)) ] || [ "${mx#* }" -gt 0 ]; then s=1; echo "suggest: dispatch.timeout_seconds $((to * 2)) (slowest dispatch ${mx% *}s of ${to}s, timeouts ${mx#* })"; fi
    ex=$(awk 'function jv(s, k,   p, i, r) { p = "\"" k "\":"; i = index(s, p); if (!i) return ""; r = substr(s, i + length(p)); sub(/[,}].*/, "", r); return r }
      /"kind":"run"/ && jv($0, "fix_rounds") + 0 >= m { c++ } END { print c + 0 }' m="$mfr" "$rec")
    if [ "$ex" -ge 2 ]; then s=1; echo "suggest: review.max_fix_rounds is reached by $ex runs; read their repeated findings (proofline insights) before raising $mfr"; fi
  else echo "no metrics recorded: timeout and fix-round checks skipped"; fi
  [ "$s" = 1 ] || echo "no change suggested"
}
case "${1:-}" in
  report) report "${2:-}" ;;
  show) cat "$out/latest.md" 2>/dev/null || { echo "friction: no report yet" >&2; exit 1; } ;;
  issue-cmd) issue_cmd ;;
  send) send ;;
  calibrate) calibrate ;;
  *) echo "usage: friction.sh <report ID|show|issue-cmd|send|calibrate>" >&2; exit 2 ;;
esac
