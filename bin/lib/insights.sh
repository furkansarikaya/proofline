#!/bin/sh
# `proofline insights` (A89): a read-only report on cost and recurring failures. Sourced by bin/proofline.
# Reads .agents/local/metrics/records.jsonl (A80) and, per run, LEDGER.log, gates/*.yaml and results/*.result.md.
# It opens nothing for writing: no rule, skill, config, ledger or metrics file is ever changed.
# Needs say, die, ROOT, CFG, require_installed from bin/proofline and cfg_val from config.sh.

insights_usage() { say "usage: proofline insights [--run <ID>] [--json]"; }

cmd_insights() {
  require_installed
  in_run='' in_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) in_json=1 ;;
      --run) [ $# -ge 2 ] || { insights_usage >&2; die "--run needs a run id"; }; in_run=$2; shift ;;
      --run=*) in_run=${1#--run=} ;;
      -h|--help) insights_usage; return 0 ;;
      *) insights_usage >&2; die "unknown argument: $1" ;;
    esac
    shift
  done
  case "$in_run" in *[!A-Za-z0-9_-]*) die "invalid run id: $in_run" ;; esac
  if [ -n "$in_run" ] && [ ! -d "$ROOT/.agents/runs/$in_run" ]; then
    grep -qF "\"task\":\"$in_run\"" "$ROOT/.agents/local/metrics/records.jsonl" 2>/dev/null || die "no such run: $in_run (see: proofline queue)"
  fi
  set --; [ "$in_json" = 0 ] || set -- --json; [ -z "$in_run" ] || set -- "$@" --run "$in_run"
  core_cli insights "$@" || return $?
  # A202: the size of the text loaded into every session, from the same Node module doctor and the budget test use
  if [ "$in_json" = 0 ] && [ -z "$in_run" ]; then
    printf '\n'; pl_core cli context-size project "$ROOT" report || :
    if [ -f "$A" ]; then printf '\n'; (cd "$ROOT" && sh "$A" rules report) || :; fi
  fi
}
