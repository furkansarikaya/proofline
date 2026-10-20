#!/bin/sh
# Command discovery for `proofline init` (D8): fills D_BUILD, D_TEST and D_LINT from the project's own
# files. Order: the ecosystem's build files (package.json scripts, Makefile, go.mod, Cargo.toml, pyproject,
# *.csproj, pom.xml, gradle), then CI configuration, then the README. A command is only a candidate until
# `--verify-commands` proves it with a trial run. Sourced by bin/proofline.

D_BUILD=''; D_TEST=''; D_LINT=''

d_set() { # KIND CMD: first writer wins
  case "$1" in
    build) [ -n "$D_BUILD" ] || D_BUILD=$2 ;;
    test) [ -n "$D_TEST" ] || D_TEST=$2 ;;
    lint) [ -n "$D_LINT" ] || D_LINT=$2 ;;
  esac
}

# d_pkg_script ROOT NAME: the package.json script body, empty when absent.
d_pkg_script() {
  if command -v jq >/dev/null 2>&1; then jq -r --arg n "$2" '.scripts[$n] // empty' "$1/package.json" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then node -e 'try { const s = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts || {})[process.argv[2]]; if (s) console.log(s) } catch (e) {}' "$1/package.json" "$2"
  else grep -Eq "\"$2\"[[:space:]]*:" "$1/package.json" 2>/dev/null && echo present; fi
}

d_node() { # ROOT
  [ -f "$1/package.json" ] || return 0
  if [ -f "$1/pnpm-lock.yaml" ]; then dn_run='pnpm run'; dn_test='pnpm test'
  elif [ -f "$1/yarn.lock" ]; then dn_run='yarn'; dn_test='yarn test'
  elif [ -f "$1/bun.lockb" ] || [ -f "$1/bun.lock" ]; then dn_run='bun run'; dn_test='bun test'
  else dn_run='npm run'; dn_test='npm test'; fi
  [ -z "$(d_pkg_script "$1" build)" ] || d_set build "$dn_run build"
  dn_t=$(d_pkg_script "$1" test)
  case "$dn_t" in ''|*"no test specified"*) ;; *) d_set test "$dn_test" ;; esac
  [ -z "$(d_pkg_script "$1" lint)" ] || d_set lint "$dn_run lint"
}

d_make() { # ROOT
  for dm_f in Makefile makefile GNUmakefile; do
    [ -f "$1/$dm_f" ] || continue
    for dm_k in build test lint; do
      grep -Eq "^${dm_k}[[:space:]]*:" "$1/$dm_f" && d_set "$dm_k" "make $dm_k"
    done
    return 0
  done
}

d_misc() { # ROOT
  if [ -f "$1/go.mod" ]; then d_set build 'go build ./...'; d_set test 'go test ./...'; d_set lint 'go vet ./...'; fi
  if [ -f "$1/Cargo.toml" ]; then d_set build 'cargo build'; d_set test 'cargo test'; d_set lint 'cargo clippy'; fi
  if [ -f "$1/pyproject.toml" ] || [ -f "$1/pytest.ini" ] || [ -f "$1/setup.cfg" ]; then
    if grep -qs pytest "$1/pyproject.toml" "$1/pytest.ini" "$1/setup.cfg" || [ -d "$1/tests" ]; then d_set test pytest; fi
    if grep -qs '^\[tool\.ruff' "$1/pyproject.toml" || [ -f "$1/ruff.toml" ]; then d_set lint 'ruff check .'; fi
  fi
  if [ -n "$(find "$1" -maxdepth 2 \( -name '*.sln' -o -name '*.csproj' \) -not -path '*/node_modules/*' -print 2>/dev/null | head -1)" ]; then
    d_set build 'dotnet build'; d_set test 'dotnet test'
  fi
  if [ -f "$1/pom.xml" ]; then d_set build 'mvn -B package'; d_set test 'mvn -B test'; fi
  if [ -f "$1/build.gradle" ] || [ -f "$1/build.gradle.kts" ]; then
    if [ -f "$1/gradlew" ]; then dm_g=./gradlew; else dm_g=gradle; fi
    d_set build "$dm_g build"; d_set test "$dm_g test"
  fi
}

# d_scan FILE...: candidate command lines (YAML `run:` / `- ` items, README code lines) of known tools.
d_scan() {
  awk '
    { l = $0
      sub(/^[[:space:]]+/, "", l); sub(/^[-][[:space:]]+/, "", l); sub(/^(run|script):[[:space:]]*/, "", l)
      sub(/^[$][[:space:]]+/, "", l); sub(/^`/, "", l); sub(/`$/, "", l); gsub(/^["\047]|["\047]$/, "", l)
      # shell control operators, redirections, substitutions and templating: never a candidate (it would be trial-run)
      if (l ~ /^(npm|pnpm|yarn|bun|go|cargo|dotnet|make|pytest|mvn|gradle|\.\/gradlew|ruff|eslint)[[:space:]]/ && l !~ /[&;|<>`]|[$][{(]|\{\{/ && length(l) < 80) print l
    }' "$@" 2>/dev/null
}

d_ci_readme() { # ROOT
  dc_files=''
  for dc_f in "$1"/.github/workflows/*.yml "$1"/.github/workflows/*.yaml "$1/.gitlab-ci.yml" "$1/.circleci/config.yml" "$1/azure-pipelines.yml" "$1/Jenkinsfile" "$1/bitbucket-pipelines.yml" "$1"/README*; do
    [ -f "$dc_f" ] && dc_files="$dc_files $dc_f"
  done
  [ -n "$dc_files" ] || return 0
  # shellcheck disable=SC2086 # the file list has no spaces by construction of the loop above
  dc_c=$(d_scan $dc_files)
  [ -n "$dc_c" ] || return 0
  dc_l=$(printf '%s\n' "$dc_c" | grep -E ' (build|compile|package)( |$)' | head -1); [ -z "$dc_l" ] || d_set build "$dc_l"
  dc_l=$(printf '%s\n' "$dc_c" | grep -E ' (test|tests|pytest)( |$)|^pytest' | head -1); [ -z "$dc_l" ] || d_set test "$dc_l"
  dc_l=$(printf '%s\n' "$dc_c" | grep -E ' (lint|vet|clippy)( |$)|^(ruff|eslint)' | head -1); [ -z "$dc_l" ] || d_set lint "$dc_l"
}

# discover_commands ROOT: sets D_BUILD D_TEST D_LINT (empty when nothing was found).
discover_commands() {
  D_BUILD=''; D_TEST=''; D_LINT=''
  d_node "$1"; d_make "$1"; d_misc "$1"; d_ci_readme "$1"
}

# Process-group helpers. nap, grp_alive and pg_start are the same text as in control-plane/agents/scripts/batch.sh (A161):
# the CLI and the control plane install separately, so each keeps its own copy and a test compares the function bodies.
G_PID=''
nap() { sleep 0.2 2>/dev/null || sleep 1; }
grp_alive() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
# pg_start METHOD OUT CMD...: start CMD in the background as a group leader by METHOD (G_PID is its pid); 1 when the method is unavailable
pg_start() {
  pgs_m=$1; pgs_o=$2; shift 2
  case "$pgs_m" in
    setm) case $- in *m*) ;; *) set -m 2>/dev/null || return 1 ;; esac
      case $- in *m*) ;; *) return 1 ;; esac
      "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$!; set +m 2>/dev/null || : ;;
    setsid) command -v setsid >/dev/null 2>&1 || return 1
      setsid "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    perl) command -v perl >/dev/null 2>&1 || return 1
      perl -e 'use POSIX; setpgid(0, 0) or die "setpgid: $!\n"; exec @ARGV or die "exec: $!\n"' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    python) command -v python3 >/dev/null 2>&1 || return 1
      python3 -c 'import os, sys; os.setpgid(0, 0); os.execvp(sys.argv[1], sys.argv[1:])' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    *) return 1 ;;
  esac
}
# pg_probe METHOD: 0 when a process started by that method is the leader of a group of its own
pg_probe() {
  pp_f=$(mktemp "${TMPDIR:-/tmp}/proofline-pg.XXXXXX") || return 1; G_PID=''
  pg_start "$1" "$pp_f" sh -c 'ps -o pgid= -p $$' || { rm -f "$pp_f"; G_PID=''; return 1; }
  pp_p=$G_PID; G_PID=''; wait "$pp_p" 2>/dev/null || :
  pp_v=$(tr -d ' \n' < "$pp_f" 2>/dev/null || :); rm -f "$pp_f"
  case "$pp_p" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ "$pp_v" = "$pp_p" ]
}
# pg_pick: prints the first method that works on this machine (none when no method works). Under PROOFLINE_TEST=1,
# PROOFLINE_PGMETHOD=<method> tries only that method.
pg_pick() {
  pk_l='setm setsid perl python'
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_PGMETHOD:-}" ]; then pk_l=$PROOFLINE_PGMETHOD; fi
  for pk_m in $pk_l; do if pg_probe "$pk_m"; then printf '%s\n' "$pk_m"; return 0; fi; done
  return 1
}
# pg_close PID: TERM, a short grace, then KILL, to the process group PID leads. Only a group verified to be led by PID
# is signalled (never 0, 1 or this shell's own group); otherwise only PID itself gets TERM.
pg_close() {
  pc_g=$1
  case "$pc_g" in ''|*[!0-9]*|0|1|"$$") return 0 ;; esac
  pc_own=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
  if [ "$pc_g" = "$pc_own" ] || [ "$(ps -o pgid= -p "$pc_g" 2>/dev/null | tr -d ' ')" != "$pc_g" ]; then kill "$pc_g" 2>/dev/null || :; return 0; fi
  kill -TERM "-$pc_g" 2>/dev/null || :
  pc_i=0; while [ "$pc_i" -lt 15 ] && grp_alive "$pc_g"; do nap; pc_i=$((pc_i + 1)); done
  ! grp_alive "$pc_g" || kill -KILL "-$pc_g" 2>/dev/null || :
  pc_i=0; while [ "$pc_i" -lt 10 ] && grp_alive "$pc_g"; do nap; pc_i=$((pc_i + 1)); done
}

# run_with_timeout SECONDS CMD...: runs CMD with output to $RW_OUT (default: discarded); 124 on timeout. CMD runs as the
# leader of its own process group, and a timeout closes the whole group, so no grandchild of a hung `sh -c` lingers.
run_with_timeout() {
  rw_s=$1; shift; rw_m=$(pg_pick) || rw_m=''
  : > "${RW_OUT:-/dev/null}"
  if [ -n "$rw_m" ] && pg_start "$rw_m" "${RW_OUT:-/dev/null}" "$@"; then rw_p=$G_PID; G_PID=''
  else
    # shortcut: with no process-group method a timeout kills the direct child only; improve when a platform without set -m, setsid, perl and python3 must be supported.
    rw_m=''; "$@" >"${RW_OUT:-/dev/null}" 2>&1 < /dev/null &
    rw_p=$!
  fi
  rw_t=0
  while kill -0 "$rw_p" 2>/dev/null; do
    if [ "$rw_t" -ge "$rw_s" ]; then
      if [ -n "$rw_m" ]; then pg_close "$rw_p"; else kill "$rw_p" 2>/dev/null; fi
      wait "$rw_p" 2>/dev/null; return 124
    fi
    sleep 1; rw_t=$((rw_t + 1))
  done
  wait "$rw_p"
} 2>/dev/null   # the shell's own "Terminated" job notices

# d_safe CMD: no shell control operator, redirection or substitution (a trial run would execute it).
# shellcheck disable=SC2016 # literal $( and ${ patterns
d_safe() { case "$1" in *['&;|<>`']*|*'$('*|*'${'*|*'{{'*) return 1 ;; esac; return 0; }

# verify_commands ROOT: trial-runs every discovered command (timeout 600 s each); a failing one is dropped.
verify_commands() {
  for vc_k in build test lint; do
    case "$vc_k" in build) vc_c=$D_BUILD ;; test) vc_c=$D_TEST ;; lint) vc_c=$D_LINT ;; esac
    [ -n "$vc_c" ] || continue
    d_safe "$vc_c" || { say "  commands.$vc_k has shell operators, not trial-run and left empty: $vc_c"; case "$vc_k" in build) D_BUILD='' ;; test) D_TEST='' ;; lint) D_LINT='' ;; esac; continue; }
    if (cd "$1" && run_with_timeout 600 sh -c "$vc_c"); then say "  verified commands.$vc_k: $vc_c"
    else
      say "  commands.$vc_k trial failed, left empty: $vc_c"
      case "$vc_k" in build) D_BUILD='' ;; test) D_TEST='' ;; lint) D_LINT='' ;; esac
    fi
  done
}
