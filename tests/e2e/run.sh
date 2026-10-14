#!/bin/sh
# Run one proofline scenario in a disposable, isolated playground copy.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
usage() { echo 'usage: tests/e2e/run.sh <TRIVIAL|STANDARD|STANDARD.tr|COMPLEX|CRITICAL|FAILOVER> <claude|codex|mixed> [--dry-run] [--keep]' >&2; exit 2; }
[ $# -ge 2 ] || usage
scenario=$1 config=$2; shift 2
case $scenario in TRIVIAL|STANDARD|STANDARD.tr|COMPLEX|CRITICAL|FAILOVER) ;; *) usage ;; esac
case $config in
  claude) lead=claude worker=claude reviewers=claude runtimes=claude ;;
  codex) lead=codex worker=codex reviewers=codex runtimes=codex ;;
  mixed) lead=claude worker=codex reviewers=claude runtimes=claude,codex ;;
  *) usage ;;
esac
[ "$scenario" != FAILOVER ] || [ "$config" = mixed ] || { echo 'FAILOVER requires mixed' >&2; exit 2; }
dry=no keep=no
for arg do case $arg in --dry-run) dry=yes ;; --keep) keep=yes ;; *) usage ;; esac; done
task=$scenario; [ "$task" != FAILOVER ] || task=STANDARD
# Reference profile (D5): balanced with an Opus lead for COMPLEX, CRITICAL and FAILOVER; economy with a Sonnet lead
# for TRIVIAL, STANDARD and STANDARD.tr. E2E_PROFILE / E2E_LEAD_MODEL override.
case $scenario in COMPLEX|CRITICAL|FAILOVER) def_profile=balanced; def_model=opus ;; *) def_profile=economy; def_model=sonnet ;; esac
profile=${E2E_PROFILE:-$def_profile}; lead_model=${E2E_LEAD_MODEL:-$def_model}
reply_file=$here/replies/$scenario.txt
[ -f "$here/tasks/$task.md" ] && [ -f "$reply_file" ] || { echo 'task or reply file missing' >&2; exit 2; }
root=${E2E_ROOT:-${TMPDIR:-/tmp}/proofline-e2e}
mkdir -p "$root"
run=$root/$scenario-$config-$(date -u +%Y%m%dT%H%M%SZ)
[ ! -e "$run" ] || run=$run-$$
project=$run/project out=$run/out
mkdir -p "$project" "$out" "$run/codexhome/.codex"
# C-18 evidence: the user's global git config, recorded (never written) before and after the run.
hash_stdin() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
hash_of() { hash_stdin < "$1"; }
global_git() { # output file name
  {
    for f in "${HOME:-/nonexistent}/.gitconfig" "${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/git/config"; do
      if [ -f "$f" ]; then printf 'file=%s sha256=%s\n' "$f" "$(hash_of "$f")"; else printf 'file=%s absent\n' "$f"; fi
    done
    list=$(git config --global --list 2>/dev/null || true)
    if [ -n "$list" ]; then printf 'list_sha256=%s\n' "$(printf '%s\n' "$list" | hash_stdin)"; else echo 'list=absent'; fi
  } > "$out/$1"
}
global_git git-global-before.txt
cp -R "$repo/playground/." "$project/"
# Write identity only into this throwaway repository's own config. Git plumbing avoids hooks.
git -C "$project" init -q -b main
printf '\n[user]\n\tname = E2E Runner\n\temail = e2e@example.invalid\n' >> "$project/.git/config"
(cd "$project" && node src/migrate.js && node src/seed.js) > "$out/prepare.txt" 2>&1
baseline() {
  message=$1
  git -C "$project" add -A
  tree=$(git -C "$project" write-tree)
  parent=$(git -C "$project" rev-parse -q --verify HEAD 2>/dev/null || true)
  if [ -n "$parent" ]; then set -- -p "$parent"; else set --; fi
  sha=$(printf '%s\n' "$message" | GIT_AUTHOR_NAME='E2E Runner' GIT_AUTHOR_EMAIL=e2e@example.invalid \
    GIT_COMMITTER_NAME='E2E Runner' GIT_COMMITTER_EMAIL=e2e@example.invalid \
    git -C "$project" commit-tree "$tree" "$@")
  git -C "$project" update-ref refs/heads/main "$sha"
}
baseline 'chore: baseline'
(cd "$project" && "$repo/bin/proofline" init --yes --runtimes "$runtimes" --lead "$lead" --worker "$worker" --reviewers "$reviewers" --profile "$profile" --task-adapter markdown) > "$out/install.txt" 2>&1
baseline 'chore: install proofline'
(cd "$project" && "$repo/bin/proofline" doctor) > "$out/doctor.txt" 2>&1 || true
if [ -f "$HOME/.codex/auth.json" ]; then ln -s "$HOME/.codex/auth.json" "$run/codexhome/.codex/auth.json"; fi
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$project" > "$run/codexhome/.codex/config.toml"
export PROOFLINE_CODEX_HOME_DIR="$run/codexhome"
# The Codex lead runs with HOME=$run/codexhome; a Claude specialist it dispatches (failover, mixed teams) must
# get the operator's own HOME back, or it is "not logged in" (dispatch.sh restores it from this variable).
export PROOFLINE_REAL_HOME="$HOME"
# Cheapest Codex lead (A100): both empty keeps the runtime default; -m and -c work on exec and exec resume.
cx_m=${E2E_CODEX_MODEL:-} cx_e='' codex_cheap=''
cx_e=${E2E_CODEX_EFFORT:-}
[ -z "$cx_m" ] || codex_cheap=" -m '$cx_m'"
[ -z "$cx_e" ] || codex_cheap="$codex_cheap -c 'model_reasoning_effort=\"$cx_e\"'"
request=$(cat "$here/tasks/$task.md"; printf '.')
request=${request%.}
if [ "$dry" = yes ]; then
  echo "run_dir=$run"
  echo "project=$project"
  echo "scenario=$scenario config=$config task=$task"
  echo 'prepared=baseline,install,doctor,codex-isolation'
  echo "setup: cp -R '$repo/playground/.' '$project/'; git init -q -b main; node src/migrate.js; node src/seed.js; baseline 'chore: baseline'; '$repo/bin/proofline' init --yes --runtimes '$runtimes' --lead '$lead' --worker '$worker' --reviewers '$reviewers' --profile $profile --task-adapter markdown; baseline 'chore: install proofline'; '$repo/bin/proofline' doctor"
  if [ "$lead" = claude ]; then
    echo "lead: (cd '$project' && claude -p '<whole $task task file>' --setting-sources project,local --permission-mode bypassPermissions --model '${lead_model}' --output-format stream-json --verbose --max-turns '${E2E_MAX_TURNS:-250}') > '$out/lead-1.jsonl' 2> '$out/lead-1.err'"
  else
    echo "lead: HOME='$run/codexhome' CODEX_HOME='$run/codexhome/.codex' codex exec$codex_cheap --dangerously-bypass-hook-trust -C '$project' -s danger-full-access -c 'approval_policy=\"never\"' --json -o '$out/lead-1.last.txt' '<whole $task task file>' > '$out/lead-1.jsonl'"
    echo "lead resume: codex exec resume$codex_cheap -c 'sandbox_mode=\"danger-full-access\"' -c 'approval_policy=\"never\"' <thread> <reply>"
  fi
  [ "$scenario" != FAILOVER ] || echo 'failover: poll implementer ledger every 10s; terminate Claude process group; resume under Codex with proofline resume'
  echo "replies: up to ${E2E_MAX_REPLIES:-6} lines from '$reply_file' when a plan or question stop is pending"
  echo 'collect: git log/status/diff/branches, runs, metrics, agent status/next/pipeline, final messages, durations, exit codes, database probe'
  echo 'collect (A95): git-global-before/after.txt, replies-log.txt, agent-pipeline.txt, insights.txt, metrics/*, visual-artifacts.txt'
  echo "doctor=$out/doctor.txt"
  # The dry run records the global config twice and creates placeholders for the collected files, so the layout is testable.
  global_git git-global-after.txt
  for f in agent-pipeline.txt insights.txt visual-artifacts.txt replies-log.txt; do echo 'not collected (dry run)' > "$out/$f"; done
  mkdir -p "$out/metrics"; echo 'not collected (dry run)' > "$out/metrics/note.txt"
  exit 0
fi
if [ "$lead" = claude ]; then command -v claude >/dev/null 2>&1 || { echo 'claude unavailable' >&2; exit 127; }
else command -v codex >/dev/null 2>&1 || { echo 'codex unavailable' >&2; exit 127; }; fi
[ "$scenario" != FAILOVER ] || command -v codex >/dev/null 2>&1 || { echo 'codex unavailable' >&2; exit 127; }
# A new process session lets the failover watchdog stop the lead and all its children.
start_group() {
  if command -v setsid >/dev/null 2>&1; then setsid "$@" &
  else python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1],sys.argv[1:])' "$@" & fi
  lead_pid=$!
}
run_lead() { # runtime, number, message, resumed?
  runtime=$1 number=$2 message=$3 resumed=$4
  started=$(date +%s)
  if [ "$runtime" = claude ]; then
    if [ "$resumed" = yes ]; then
      # shellcheck disable=SC2016
      start_group sh -c 'cd "$1" && shift && exec env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 "$@"' sh "$project" claude -p "$message" --resume "$session" --setting-sources project,local --permission-mode bypassPermissions --model "${lead_model}" --output-format stream-json --verbose --max-turns "${E2E_MAX_TURNS:-250}" > "$out/lead-$number.jsonl" 2> "$out/lead-$number.err"
    else
      # shellcheck disable=SC2016
      start_group sh -c 'cd "$1" && shift && exec env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 "$@"' sh "$project" claude -p "$message" --setting-sources project,local --permission-mode bypassPermissions --model "${lead_model}" --output-format stream-json --verbose --max-turns "${E2E_MAX_TURNS:-250}" > "$out/lead-$number.jsonl" 2> "$out/lead-$number.err"
    fi
  else
    if [ "$resumed" = yes ]; then
      start_group env HOME="$run/codexhome" CODEX_HOME="$run/codexhome/.codex" codex exec resume ${cx_m:+-m "$cx_m"} ${cx_e:+-c 'model_reasoning_effort="'"$cx_e"'"'} -c 'sandbox_mode="danger-full-access"' -c 'approval_policy="never"' --json -o "$out/lead-$number.last.txt" "$thread" "$message" > "$out/lead-$number.jsonl" 2> "$out/lead-$number.err"
    else
      start_group env HOME="$run/codexhome" CODEX_HOME="$run/codexhome/.codex" codex exec ${cx_m:+-m "$cx_m"} ${cx_e:+-c 'model_reasoning_effort="'"$cx_e"'"'} --dangerously-bypass-hook-trust -C "$project" -s danger-full-access -c 'approval_policy="never"' --json -o "$out/lead-$number.last.txt" "$message" > "$out/lead-$number.jsonl" 2> "$out/lead-$number.err"
    fi
  fi
  elapsed=0 timed_out=no killed=no
  while kill -0 "$lead_pid" 2>/dev/null; do
    if [ "$scenario" = FAILOVER ] && [ "$runtime" = claude ] && [ "$elapsed" -gt 0 ] && [ $((elapsed % 10)) -eq 0 ]; then
      if awk '/event=freeze / { frozen=1 } frozen && /event=window-open.*implementer|event=decide.*implementer|event=note.*dispatch.*implementer/ { found=1 } END { exit !found }' "$project"/.agents/runs/*/LEDGER.log 2>/dev/null; then
        date -u +%Y-%m-%dT%H:%M:%SZ > "$out/failover.txt"
        killed=yes; kill -TERM -- "-$lead_pid" 2>/dev/null || kill -TERM "$lead_pid" 2>/dev/null || true
        break
      fi
    fi
    if [ "$elapsed" -ge "${E2E_TIMEOUT:-5400}" ]; then
      timed_out=yes; kill -TERM -- "-$lead_pid" 2>/dev/null || kill -TERM "$lead_pid" 2>/dev/null || true
      break
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  rc=0; wait "$lead_pid" || rc=$?
  printf 'lead_%s_runtime=%s\nlead_%s_exit=%s\nlead_%s_duration=%s\nlead_%s_timeout=%s\nlead_%s_killed=%s\n' "$number" "$runtime" "$number" "$rc" "$number" "$(( $(date +%s) - started ))" "$number" "$timed_out" "$number" "$killed" >> "$out/summary.txt"
  if [ "$runtime" = claude ]; then
    node -e 'const fs=require("fs");let id="",last="";for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);if(!id&&e.type==="system"&&e.subtype==="init")id=e.session_id||"";if(e.type==="result")last=e.result||""}catch{}}fs.writeFileSync(process.argv[2],last);if(id)console.log(id)' "$out/lead-$number.jsonl" "$out/lead-$number.final.txt" > "$out/lead-$number.session"
    session=$(cat "$out/lead-$number.session")
  else
    node -e 'const fs=require("fs");let id="";for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);id ||= e.thread_id||e.threadId||e.session_id||""}catch{}}if(id)console.log(id)' "$out/lead-$number.jsonl" > "$out/lead-$number.session"
    thread=$(cat "$out/lead-$number.session")
    cp "$out/lead-$number.last.txt" "$out/lead-$number.final.txt" 2>/dev/null || : > "$out/lead-$number.final.txt"
  fi
}
run_lead "$lead" 1 "$request" no
number=1
if [ "$scenario" = FAILOVER ] && [ "$killed" = yes ]; then
  number=2; run_lead codex "$number" 'proofline resume' no
fi
max=${E2E_MAX_REPLIES:-6}; replies=0 plan_replies=0 question_replies=0
: > "$out/replies-log.txt"
while [ "$replies" -lt "$max" ]; do
  id=$(cd "$project" && sh .agents/scripts/agent.sh status 2>/dev/null | sed -n 's/^active_task=//p' | head -1)
  case $id in ''|none) id=none ;; esac
  state=$(cd "$project" && sh .agents/scripts/agent.sh next "$id" 2>/dev/null || true)
  printf '%s\n' "$state" | grep -Eiq 'state=(DONE|FAILED|TERMINATED)|run DONE|terminated' && break
  pending=$(cd "$project" && sh .agents/scripts/agent.sh questions "$id" 2>/dev/null || true)
  last=$out/lead-$number.final.txt
  # Which approval is the run waiting for? `agent.sh next` names it. A plan approval is answered every time it
  # is asked (a refreeze asks again); a destructive, single_step, scope, budget, commit, push or waive request
  # is never answered by the harness. Any other stop of the lead (a question) gets the scripted question reply.
  kind=$(printf '%s\n' "$state" | sh "$here/pending-kind.sh")
  qline=$(sed -n 1p "$reply_file"); pline=$(sed -n 2p "$reply_file")
  case $kind in
    plan) line=$pline ;;
    destructive|single_step|scope|budget|commit|push|waive:*) break ;;
    *)
      asked=$(printf '%s\n' "$state $pending $(cat "$last")")
      if printf '%s\n' "$asked" | grep -Eiq 'approve (the )?(commit|push)|commit approval|push approval|commit it|push it'; then break; fi
      line=$qline ;;
  esac
  [ -n "$line" ] || break
  replies=$((replies + 1)); printf '%s\n' "$line" >> "$out/replies.txt"
  # plan = an approval (the user's reply is the approval); question = a scripted question reply.
  case $kind in plan) rkind=plan-approval; plan_replies=$((plan_replies + 1)) ;; *) rkind=question; question_replies=$((question_replies + 1)) ;; esac
  printf 'reply=%s kind=%s task=%s request=%s | %s\n' "$replies" "$rkind" "$id" "$(printf '%s\n' "$state" | sed -n 's/^next=//p' | head -1)" "$line" >> "$out/replies-log.txt"
  number=$((number + 1))
  if [ "$scenario" = FAILOVER ]; then lead=codex; fi
  run_lead "$lead" "$number" "$line" yes
  [ "$timed_out" = no ] || break
done
printf 'scenario=%s\nconfig=%s\nrun_dir=%s\nreplies=%s\nplan_approval_replies=%s\nquestion_replies=%s\n' "$scenario" "$config" "$run" "$replies" "$plan_replies" "$question_replies" >> "$out/summary.txt"
(git -C "$project" log --oneline --all || true) > "$out/git-log.txt"
git -C "$project" status --short > "$out/git-status.txt"
git -C "$project" diff main...HEAD > "$out/git-diff-main-head.patch" || true
git -C "$project" diff > "$out/git-diff-working.patch" || true
git -C "$project" diff --cached > "$out/git-diff-staged.patch" || true
git -C "$project" branch --list > "$out/git-branches.txt"
git -C "$project" ls-files --others --exclude-standard > "$out/git-untracked.txt"
if [ -d "$project/.agents/runs" ]; then cp -R "$project/.agents/runs" "$out/runs"; else echo 'runs cleaned' > "$out/runs-note.txt"; fi
if [ -d "$project/.agents/local/metrics" ]; then cp -R "$project/.agents/local/metrics" "$out/metrics"; else echo 'metrics absent' > "$out/metrics-note.txt"; fi
(cd "$project" && sh .agents/scripts/agent.sh status) > "$out/agent-status.txt" 2>&1 || true
id=$(sed -n 's/^active_task=//p' "$out/agent-status.txt" | head -1)
if [ -n "$id" ] && [ "$id" != none ]; then
  (cd "$project" && sh .agents/scripts/agent.sh next "$id") > "$out/agent-next.txt" 2>&1 || true
  (cd "$project" && sh .agents/scripts/agent.sh pipeline "$id") > "$out/agent-pipeline.txt" 2>&1 || true
fi
[ -e "$out/agent-pipeline.txt" ] || echo 'no active task id: pipeline not collected' > "$out/agent-pipeline.txt"
# N-6: insights is read-only; the hash of .agents is taken around the call and recorded.
agents_hash() { (cd "$project" && find .agents -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$(hash_of "$f")" "$f"; done | hash_stdin); }
before_ins=$(agents_hash)
ins_rc=0; (cd "$project" && "$repo/bin/proofline" insights) > "$out/insights.txt" 2>&1 || ins_rc=$?
after_ins=$(agents_hash)
printf 'insights_exit=%s\nagents_hash_before_insights=%s\nagents_hash_after_insights=%s\n' "$ins_rc" "$before_ins" "$after_ins" >> "$out/summary.txt"
# N-4: screenshots and other visual-proof artifacts of the runs, hashed.
(cd "$project" && find .agents/runs \( -ipath '*screenshot*' -o -ipath '*visual*' \) -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$(hash_of "$f")" "$f"; done) > "$out/visual-artifacts.txt"
[ -s "$out/visual-artifacts.txt" ] || echo 'none' > "$out/visual-artifacts.txt"
global_git git-global-after.txt
(cd "$project" && node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("data/reading-list.db",{readOnly:true});const cols=db.prepare("PRAGMA table_info(books)").all().map(x=>x.name);console.log("columns="+cols.join(","));console.log("legacy_notes_non_null="+(cols.includes("legacy_notes")?db.prepare("SELECT COUNT(*) AS n FROM books WHERE legacy_notes IS NOT NULL").get().n:"not-applicable"))') > "$out/db-probe.txt" 2>&1 || true
echo "run_dir=$run"
echo "summary=$out/summary.txt"
if [ "$keep" = no ]; then rm -rf "$project" "$run/codexhome"; fi
