#!/bin/sh
# shellcheck disable=SC2016,SC2086,SC2154 # literal command text; fixture variables come from test-lib.sh
# Real Codex sandbox check (A199), no model call: the permission profile that dispatch.sh gives a Codex worker (`dispatch.sh codex-profile <ID>`) is
# applied with `codex sandbox -P`, and inside it a worker must be able to write product files and its own record paths and to run `agent.sh submit` and
# the evidence recorder, and must NOT be able to write .agents/local/windows, approvals, prompts or batch (nor the run's approvals). Run for a run in
# the main tree and for a run in a worktree. Needs the Codex CLI; without it the script says so and exits 0.
#   sh tests/real-session/codex-sandbox.sh
set -u
if [ -z "${CSB_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  command -v codex >/dev/null 2>&1 || { echo 'codex-sandbox: the Codex CLI is not installed; nothing checked'; exit 0; }
  CSB_INNER=1 CSB_REPO=$repo exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/real-session/codex-sandbox.sh"
fi

CODEX_HOME=$base/chome; export CODEX_HOME; mkdir -p "$CODEX_HOME"   # no user config, no login: the sandbox command needs neither
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID

# csb DIR SCRIPT: run `sh SCRIPT` (an absolute path) inside the Codex sandbox with the worker profile of the run LC, working directory DIR
csb() {
  csb_d=$1; csb_s=$2
  set --
  while IFS= read -r csb_a; do set -- "$@" "$csb_a"; done <<EOF_CSB
$(sh "$csb_prof/.agents/scripts/dispatch.sh" codex-profile LC)
EOF_CSB
  mkdir -p "$base/sbtmp"; TMPDIR=$base/sbtmp codex sandbox -C "$csb_d" -P proofline-worker "$@" -- sh "$csb_s"
}

# the probe: what a worker tries. Prints WROTE <path> or DENIED <path> per path, then runs submit
probe() { # RUNROOT-relative paths are tried from the current directory of the sandbox
  cat > "$1" <<'EOF_PROBE'
try() { ( : > "$1" ) 2>/dev/null && echo "WROTE $1" || echo "DENIED $1"; }
try impl.txt
try .agents/runs/LC/scratch/own.txt
try .agents/local/locks/own.lock-probe
try .agents/local/submissions/own.probe
try .agents/local/windows/forged
try .agents/local/approvals/forged
try .agents/local/prompts/forged
try .agents/local/batch/forged
try .agents/runs/LC/approvals/forged
try .agents/local/escalate
try .agents/roles.conf.probe
EOF_PROBE
}
want() { # OUT PATH wrote|denied
  grep -qx "$(printf '%s' "$3" | tr '[:lower:]' '[:upper:]' | sed 's/WROTE/WROTE/') $2" "$1" || die "A199 $4: expected $3 for $2; got: $(head -c 600 "$1")"
}

for where in main worktree; do
  scaffold orchestrated no STANDARD
  cp "$CSB_REPO/control-plane/agents/scripts/dispatch.sh" .agents/scripts/dispatch.sh
  mkdir -p .agents/local/locks .agents/local/submissions .agents/local/windows .agents/local/approvals .agents/local/prompts .agents/local/batch .agents/runs/LC/approvals .agents/runs/LC/scratch
  git add -A >/dev/null 2>&1; git commit -q -m fixture >/dev/null 2>&1 || :
  if [ "$where" = worktree ]; then
    main=$PWD
    rw=$(A worktree-add RW-1) || die "A199 worktree-add: $rw"
    wt=$(cd "$main/.agents/local/worktrees/RW-1" && pwd -P)
    mkdir -p "$wt/.agents/runs" "$wt/.agents/local/locks" "$wt/.agents/local/submissions" "$wt/.agents/local/windows" "$wt/.agents/local/approvals" "$wt/.agents/local/prompts" "$wt/.agents/local/batch"
    cp -R "$main/.agents/runs/LC" "$wt/.agents/runs/LC"
    for e in scripts hooks; do [ ! -d "$main/.agents/$e" ] || { rm -rf "$wt/.agents/$e"; cp -R "$main/.agents/$e" "$wt/.agents/$e"; }; done
    cp "$main/.agents/config.yaml" "$wt/.agents/config.yaml"
    run_root=$wt
  else
    run_root=$PWD
  fi
  csb_prof=$run_root
  cd "$run_root" || exit 1
  : > impl.txt
  printf '%s\n' "$where" > "$base/where"
  probe "$base/probe.sh"
  out=$base/probe-$where.out
  csb "$run_root" "$base/probe.sh" > "$out" 2>&1 || :
  for ok_p in impl.txt .agents/runs/LC/scratch/own.txt .agents/local/locks/own.lock-probe .agents/local/submissions/own.probe; do want "$out" "$ok_p" wrote "($where) a worker's own path"; done
  for no_p in .agents/local/windows/forged .agents/local/approvals/forged .agents/local/prompts/forged .agents/local/batch/forged .agents/runs/LC/approvals/forged .agents/local/escalate .agents/roles.conf.probe; do want "$out" "$no_p" denied "($where) a path a worker must not write"; done
  ok "A199 ($where) in a real Codex sandbox: product files and the worker's own record paths are writable; windows, approvals, prompts, batch, the run's approvals and the rest of .agents are not"

  # git operations a worker does in its tree (A203). In a worktree: status, diff, add and commit work (own worktree folder plus the common objects/ folder) and
  # nothing else of the git dir is writable: not a branch ref, not another task's worktree folder, not a new worktree (an evidence worktree, D10). In the main
  # tree the whole .git stays read-only (the lead commits there): status and diff work, add and commit are refused.
  cat > "$base/git.sh" <<'EOF_GIT'
g() { n=$1; shift; o=$("$@" 2>&1) && echo "GITOK $n" || echo "GITFAIL $n: $(printf '%s' "$o" | head -c 300 | tr '\n' ' ')"; }
cd=$(git rev-parse --git-common-dir)
echo changed >> impl.txt
g status git status --short
g diff git diff --stat
g add git add impl.txt
g commit git -c user.name=w -c user.email=w@example.invalid commit -q -m worker-probe
g wtadd git worktree add --detach "$TMPDIR/ev-probe" HEAD
g ref git update-ref refs/heads/forged HEAD
g other mkdir "$cd/worktrees/other-task"
EOF_GIT
  gout=$base/git-$where.out; g_head=$(git rev-parse HEAD)
  csb "$run_root" "$base/git.sh" > "$gout" 2>&1 || :
  : > impl.txt; git reset -q --hard "$g_head" 2>/dev/null || :
  gexp() { # NAME ok|fail
    if [ "$2" = ok ]; then grep -q "^GITOK $1\$" "$gout" || die "A203 ($where) git $1 must work inside the Codex sandbox; got: $(grep "GITFAIL $1" "$gout" | head -1). A dispatched Codex worker that reports BLOCKED on this: run the role with --runtime claude"
    else grep -q "^GITFAIL $1:" "$gout" || die "A203 ($where) git $1 must be refused inside the Codex sandbox; got: $(grep "GITOK $1" "$gout" | head -1)"; fi
  }
  gexp status ok; gexp diff ok; gexp ref fail; gexp other fail; gexp wtadd fail
  if [ "$where" = worktree ]; then gexp add ok; gexp commit ok; else gexp add fail; gexp commit fail; fi
  ok "A203 ($where) git: status and diff work; $([ "$where" = worktree ] && echo 'add and commit work (own worktree folder, common objects/)' || echo 'add and commit are refused (.git read-only)'); branch refs, other worktree folders and new worktrees are refused"

  # submit succeeds from inside the sandbox (an explorer report), taking the locks
  art=.agents/runs/LC/scratch/e9-report.md
  printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| C1 | low | impl.txt:1 | x | y |\n' > "$art"
  cat > "$base/submit.sh" <<EOF_SUBMIT
AGENT_ROLE=explorer sh .agents/scripts/agent.sh submit LC --agent e9 --result DONE --confidence high --report $art
EOF_SUBMIT
  csb "$run_root" "$base/submit.sh" > "$base/submit-$where.out" 2>&1 || die "A199 ($where) submit failed inside the sandbox: $(tail -5 "$base/submit-$where.out")"
  grep -qi 'submitted\|recorded\|ok' "$base/submit-$where.out" || die "A199 ($where) submit printed nothing recognisable: $(cat "$base/submit-$where.out")"
  ls .agents/runs/LC/results/* >/dev/null 2>&1 || ls .agents/runs/LC/reports/* >/dev/null 2>&1 || die "A199 ($where) submit left no record"
  ok "A199 ($where) agent.sh submit succeeds inside the real Codex sandbox"
  # the evidence recorder (an implementer's RED record) works inside the sandbox too; the window is opened and closed by dispatch.sh, outside it
  W=$(AGENT_ROLE='' sh .agents/scripts/agent.sh window-open LC) || die "A199 ($where) window-open: $W"
  cat > "$base/rec.sh" <<'EOF_REC'
printf 'command: go test ./...\ntarget: impl.txt,impl_test.txt\nexpected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\n' | AGENT_ROLE=implementer sh .agents/scripts/agent.sh worker-evidence LC RED fail
EOF_REC
  csb "$run_root" "$base/rec.sh" > "$base/rec-$where.out" 2>&1 || die "A199 ($where) the evidence recorder failed inside the sandbox: $(tail -5 "$base/rec-$where.out")"
  ls .agents/runs/LC/worker-evidence/RED-*.yaml >/dev/null 2>&1 || die "A199 ($where) no RED record after the sandboxed recorder"
  AGENT_ROLE='' sh .agents/scripts/agent.sh window-close LC "$W" 0 >/dev/null 2>&1 || :
  ok "A199 ($where) the evidence recorder writes a RED record inside the real Codex sandbox"
  cd "$base" || exit 1
done
echo 'codex-sandbox: passed'
