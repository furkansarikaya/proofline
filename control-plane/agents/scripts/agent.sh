#!/bin/sh
# proofline control plane launcher (A245). The whole control plane is Node code: this file only finds the project's core and starts it.
# Installed as <project>/.agents/scripts/agent.sh; the project root is two directories above this file. Normative description: .agents/WORKFLOW.md.
# A run worktree's scripts are tracked content a task could have rewritten (security round 3, A207): from a linked worktree that proofline made under
# <main>/.agents/local/worktrees/ the PROJECT's (main tree's) core runs; --pl-argv0 hands this file's own $0 over, which tells the core which folder is the root.
# No core beside this file in an installed project fails closed (exit 127, a guard that needs this command must deny). There is no shell fallback.
case "$0" in */*) self_dir=${0%/*}; [ -n "$self_dir" ] || self_dir=/ ;; *) self_dir=. ;; esac
root=$(CDPATH='' cd "$self_dir/../.." && pwd)
core_dir=$self_dir
if [ -f "$root/.git" ]; then
  main=$(git -C "$root" worktree list --porcelain 2>/dev/null | head -n 1); main=${main#worktree }
  here=$(cd "$root" && pwd -P)
  case "$here" in "$main"/.agents/local/worktrees/*) [ -z "$main" ] || { root=$main; core_dir=$main/.agents/scripts; } ;; esac
fi
if [ ! -f "$core_dir/proofline-core.mjs" ] || [ ! -d "$core_dir/core" ]; then
  if [ -f "$root/.agents/.proofline-manifest" ]; then
    echo "proofline: $core_dir/proofline-core.mjs or $core_dir/core/ is missing: the command $1 runs in Node 22.13 or newer and needs both (run: proofline upgrade)" >&2
  else
    echo "proofline: no control-plane core beside $0 and no .agents/.proofline-manifest: this is not an installed project (run: proofline init)" >&2
  fi
  exit 127
fi
exec node "$core_dir/proofline-core.mjs" --pl-argv0 "$0" "$@"
