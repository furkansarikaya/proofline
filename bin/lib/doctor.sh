#!/bin/sh
# `proofline doctor` (D8): verifies the install and that each enforced rule is really enforced, with live
# probes in a throwaway repository (the project's own installed hooks and scripts are copied there).
# Prints PASS / WARN / FAIL lines, exits non-zero on any FAIL. Sourced by bin/proofline.

doctor_ms() { dm_v=$(date +%s%N 2>/dev/null); case "$dm_v" in ''|*[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null || echo $(( $(date +%s) * 1000 )) ;; *) echo $((dm_v / 1000000)) ;; esac; }
d_pass() { printf 'PASS %s\n' "$*"; }
d_warn() { printf 'WARN %s\n' "$*"; D_WARNS=$((D_WARNS + 1)); }
d_fail() { printf 'FAIL %s\n' "$*"; D_FAILS=$((D_FAILS + 1)); }

# hook_has FILE EVENT: does the JSON hook file wire a proofline-hook.sh command to EVENT?
hook_has() {
  [ -f "$1" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg e "$2" '[(.hooks[$e] // [])[] | (.hooks // [])[] | .command // ""] | any(contains("proofline-hook.sh"))' "$1" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const g = (j.hooks || {})[process.argv[2]] || [];
      process.exit(g.some((x) => (x.hooks || []).some((h) => String(h.command).includes("proofline-hook.sh"))) ? 0 : 1) } catch (e) { process.exit(1) }' "$1" "$2"
  else grep -q 'proofline-hook.sh' "$1" && grep -q "\"$2\"" "$1"; fi
}

# identity_forbidden CONFIG EMAIL: the same test the pre-commit hook applies (glob or ERE, case-insensitive).
identity_forbidden() {
  set -f
  idf_e=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  for idf_p in $(cfg_val "$1" git.forbidden_identities ''); do
    idf_lp=$(printf '%s' "$idf_p" | tr '[:upper:]' '[:lower:]')
    # shellcheck disable=SC2254 # the pattern is a glob on purpose
    case "$idf_e" in $idf_lp) set +f; return 0 ;; esac
    if printf '%s\n' "$2" | grep -Eiq -e "$idf_p" 2>/dev/null; then set +f; return 0; fi
  done
  set +f
  return 1
}
email_of() { g var "$1" 2>/dev/null | sed -n 's/.*<\([^>]*\)>.*/\1/p'; }

# doctor_platform (A180): platform of origin, the installed tool, the merge rule that will apply.
doctor_platform() {
  dp_o=$(cd "$ROOT" && sh "$A" platform 2>/dev/null) || dp_o=''
  dp_p=$(printf '%s\n' "$dp_o" | sed -n 's/^platform: //p'); dp_c=$(printf '%s\n' "$dp_o" | sed -n 's/^cli: //p')
  dp_w=$(printf '%s\n' "$dp_o" | sed -n 's/^web: //p')
  dp_s=$(printf '%s\n' "$dp_o" | sed -n 's/^source: //p'); dp_src=${dp_s:-auto}
  case "$dp_src" in config) dp_src='config: git.platform' ;; env) dp_src='env: PROOFLINE_PLATFORM' ;; *) dp_src='auto: origin URL' ;; esac
  if [ -z "$(g remote get-url origin 2>/dev/null || true)" ]; then
    d_warn "platform: the project has no origin remote yet, so the platform is unknown; with one, proofline detects GitHub, GitLab, Azure DevOps and Bitbucket from its address"; return 0
  fi
  dp_lw=$(cd "$ROOT" && sh "$A" platform-warn 2>/dev/null) || dp_lw=''
  [ -z "$dp_lw" ] || d_warn "platform: ${dp_lw#warning: }"
  case "$dp_p:$dp_c" in
    github:gh) d_pass "platform: github (source $dp_src), tool gh installed; merge rule: proofline opens and merges the pull request, every check must be green, and a pull request without checks is merged only after build and test pass in a clean copy (verified locally, no CI)" ;;
    gitlab:glab) d_pass "platform: gitlab (source $dp_src), tool glab installed; merge rule: proofline opens and merges the merge request, the pipeline must be green, and a merge request without a pipeline is merged only after build and test pass in a clean copy (verified locally, no CI)" ;;
    azure:az) d_pass "platform: azure devops (source $dp_src), tool az installed; merge rule: proofline opens and merges the pull request, every build policy must be approved, and a pull request without one is merged only after build and test pass in a clean copy (verified locally, no CI)" ;;
    github:*|gitlab:*|azure:*) d_warn "platform: $dp_p (source $dp_src), but its tool ($(case $dp_p in gitlab) echo glab ;; azure) echo az ;; *) echo gh ;; esac) is not installed; merge rule: manual. proofline pushes the branch and prints the pull request address ($dp_w); YOU open and merge it" ;;
    bitbucket:*) d_warn "platform: bitbucket (source $dp_src); merge rule: manual. proofline has no adapter: it pushes the branch and prints the pull request address ($dp_w); YOU open and merge it" ;;
    *) d_warn "platform: not recognized (${dp_w:-the origin address}; source $dp_src; a private host is named with git.platform and git.platform_host in .agents/config.yaml); merge rule: manual. proofline pushes the branch and prints the manual steps; YOU open and merge the pull request" ;;
  esac
}

# doctor_context (A202): the size of the text loaded into every session and every role (one script, bin/lib/context-size.sh).
doctor_context() {
  dx_o=$(sh "$PL_HOME/bin/lib/context-size.sh" project "$ROOT" report 2>/dev/null) || dx_o=''
  [ -n "$dx_o" ] || { d_warn "context: the size of the text loaded into every session could not be measured"; return 0; }
  d_pass "$(printf '%s\n' "$dx_o" | sed 's/^/    /;1s/^ *//')"
}

# doctor_rules (A202): the Project rules budget and the proposals (merge, ask, remove); it only reports, a rule changes on the user's approval.
doctor_rules() {
  [ -f "$ROOT/.agents/scripts/rules.sh" ] || return 0
  dr_o=$(cd "$ROOT" && sh "$A" rules report 2>/dev/null) || return 0
  case "$dr_o" in 'project rules: none') return 0 ;; esac
  if printf '%s\n' "$dr_o" | grep -Eq '\(OVER\)|^  (merge|ask the user|remove):'; then d_warn "$(printf '%s\n' "$dr_o" | sed 's/^/    /;1s/^ *//')"
  else d_pass "$(printf '%s\n' "$dr_o" | head -n 1)"; fi
}

doctor_identity() {
  di_ae=$(email_of GIT_AUTHOR_IDENT); di_ce=$(email_of GIT_COMMITTER_IDENT)
  if [ -z "$di_ae" ] || [ -z "$di_ce" ]; then
    d_warn "identity: git has no commit identity here; set a repository-local one (git config --local user.email ...)"; return 0
  fi
  if [ -n "$(g config --local --get user.email 2>/dev/null || true)" ]; then di_src='repository-local config'
  elif [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then di_src='GIT_AUTHOR_EMAIL environment'
  else di_src='global or system config (consider a repository-local identity)'; fi
  di_bad=''
  identity_forbidden "$CFG" "$di_ae" && di_bad=author
  identity_forbidden "$CFG" "$di_ce" && di_bad="${di_bad:+$di_bad and }committer"
  if [ -n "$di_bad" ]; then
    d_fail "identity: the $di_bad identity ($di_src) matches git.forbidden_identities; the pre-commit hook will block commits. Set another identity: git config --local user.email ..."
  else d_pass "identity: commits use $(g var GIT_AUTHOR_IDENT 2>/dev/null | sed 's/ [0-9]* [-+][0-9]*$//') from $di_src; no git.forbidden_identities match"; fi
}

# --- live probes -----------------------------------------------------------------------------------
probe_git() { ( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL AGENT_ROLE; PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY; cd "$PD/repo" && git "$@" ); }

doctor_probes() {
  PD=$(mktemp -d "${TMPDIR:-/tmp}/proofline-doctor.XXXXXX") || { d_warn "probes: cannot create a temp directory"; return 0; }
  trap 'rm -rf "$PD"' EXIT HUP INT TERM
  mkdir -p "$PD/repo" "$PD/remote.git"
  ( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE; git init -q --bare "$PD/remote.git" && git init -q "$PD/repo" ) >/dev/null 2>&1 || { d_warn "probes: git init failed"; return 0; }
  cp -R "$ROOT/.agents" "$PD/repo/.agents"
  rm -rf "$PD/repo/.agents/runs" "$PD/repo/.agents/local" "$PD/repo/.agents/skills"
  pc=$PD/repo/.agents/config.yaml
  probe_git config user.name probe; probe_git config user.email probe@ok.invalid; probe_git config commit.gpgsign false
  probe_git commit -q --allow-empty -m init >/dev/null 2>&1 || { d_warn "probes: could not create the probe commit"; return 0; }
  probe_git config core.hooksPath .agents/githooks
  cfg_set "$pc" git.protected_branches ''; cfg_set "$pc" git.forbidden_identities '*@blocked.invalid'

  probe_git config user.email x@blocked.invalid
  if probe_git commit -q --allow-empty -m probe >/dev/null 2>"$PD/err"; then d_fail "probe: the pre-commit identity guard let a forbidden identity commit"
  elif grep -q 'git.forbidden_identities' "$PD/err"; then d_pass "probe: pre-commit blocks a forbidden identity (names git.forbidden_identities)"
  else d_fail "probe: pre-commit blocked the commit for another reason: $(head -1 "$PD/err")"; fi
  probe_git config user.email probe@ok.invalid
  if probe_git commit -q --allow-empty -m probe2 >/dev/null 2>"$PD/err"; then d_pass "probe: pre-commit lets other identities commit"
  else d_fail "probe: pre-commit blocks a legitimate commit: $(head -1 "$PD/err")"; fi

  cfg_set "$pc" git.push_requires_approval false; cfg_set "$pc" git.protected_branches 'probe-protected'
  if probe_git push -q "$PD/remote.git" HEAD:refs/heads/probe-protected >/dev/null 2>&1; then d_fail "probe: pre-push let an agent push to a protected branch"
  elif probe_git push -q "$PD/remote.git" HEAD:refs/heads/probe-open >/dev/null 2>&1; then d_pass "probe: pre-push blocks a protected branch and allows others"
  else d_fail "probe: pre-push blocks an unprotected branch although push approval is off"; fi
  cfg_set "$pc" git.push_requires_approval true; cfg_set "$pc" git.protected_branches ''
  if probe_git push -q "$PD/remote.git" HEAD:refs/heads/probe-other >/dev/null 2>"$PD/err"; then d_fail "probe: pre-push let an agent push without approval"
  else d_pass "probe: pre-push blocks a push without approval"; fi
  # human detection: agent session markers decide, not a terminal (no TTY here; the markers are cleared or set)
  if (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE AGENT_ROLE PROOFLINE_NO_TTY CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CODEX_CI CODEX_SANDBOX CODEX_THREAD_ID CODEX_SESSION_ID; cd "$PD/repo" && git push -q "$PD/remote.git" HEAD:refs/heads/probe-human) >/dev/null 2>&1 \
    && ! (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE AGENT_ROLE PROOFLINE_NO_TTY; CLAUDECODE=1; export CLAUDECODE; cd "$PD/repo" && git push -q "$PD/remote.git" HEAD:refs/heads/probe-agent) >/dev/null 2>&1
  then d_pass "probe: a push without a terminal or agent markers passes as a human; one with agent markers is blocked"
  else d_fail "probe: human detection is wrong (a push without agent markers must pass, one with CLAUDECODE set must be blocked)"; fi

  if ! command -v jq >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
    d_warn "probe: runtime hooks not probed (the hook script needs jq or node to read JSON)"; return 0
  fi
  hook=$PD/repo/.agents/hooks/proofline-hook.sh
  mkdir -p "$PD/repo/.agents/local" "$PD/repo/src"
  hook_run() { # RUNTIME JSON
    ( unset AGENT_ROLE; CLAUDE_PROJECT_DIR=$PD/repo PROOFLINE_NO_TTY=1; export CLAUDE_PROJECT_DIR PROOFLINE_NO_TTY
      printf '%s' "$2" | sh "$hook" pretool "$1" 2>/dev/null ); }
  edit_json="{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$PD/repo\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PD/repo/src/probe.js\"}}"
  echo DOCTOR-1 > "$PD/repo/.agents/local/ACTIVE_RUN"
  if rt_has claude; then
    if hook_run claude "$edit_json" | grep -q '"permissionDecision":"deny"'; then d_pass "probe: the Claude PreToolUse hook denies a lead edit of product code during a run"
    else d_fail "probe: the Claude PreToolUse hook did not deny a lead edit during an active run"; fi
  fi
  if rt_has codex; then
    codex_json="{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$PD/repo\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"printf x > src/probe.js\"}}"
    if hook_run codex "$codex_json" | grep -q '"permissionDecision":"deny"'; then d_pass "probe: the Codex PreToolUse hook denies a lead shell write during a run"
    else d_fail "probe: the Codex PreToolUse hook did not deny a lead shell write during an active run"; fi
  fi
  : > "$PD/repo/.agents/local/ACTIVE_RUN"
  # A169: the lead's ban on product files holds without a run too; a task file stays writable
  task_json="{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$PD/repo\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PD/repo/.agents/tasks/probe.md\"}}"
  if ! hook_run claude "$edit_json" | grep -q '"permissionDecision":"deny"'; then d_fail "probe: the PreToolUse hook did not deny a lead edit of product code although no run is active (A169)"
  elif hook_run claude "$task_json" | grep -q '"permissionDecision":"deny"'; then d_fail "probe: the PreToolUse hook denies a task file without an active run"
  else d_pass "probe: without an active run the PreToolUse hook denies a lead product edit and lets a task file through"; fi
}

# Foreign context sources (WARN only, never FAIL): hooks that add context to the prompt (SessionStart and
# UserPromptSubmit commands that are not proofline's) and skills whose name overlaps a proofline method skill.
# Heuristic and read-only: a hook is listed because it can add context, not because it did.
doctor_foreign() {
  if command -v jq >/dev/null 2>&1; then
    for df_f in "$ROOT/.claude/settings.json" "$ROOT/.claude/settings.local.json" "$HOME/.claude/settings.json" "$HOME"/.claude/plugins/cache/*/*/*/hooks/hooks.json; do
      [ -f "$df_f" ] || continue
      case "$df_f" in */plugins/cache/proofline/*) continue ;; esac
      df_l=$(jq -r --arg f "${df_f#"$HOME"/}" '(.hooks // {}) | to_entries[] | select(.key == "SessionStart" or .key == "UserPromptSubmit") | .key as $e
        | (.value[]? | (.hooks // [])[]? | .command // "") | select(contains("proofline-hook.sh") | not)
        | "WARN foreign hook: \($e) in \($f) may add context to the prompt: \(.[0:80])"' "$df_f" 2>/dev/null) || df_l=''
      [ -z "$df_l" ] || { printf '%s\n' "$df_l"; D_WARNS=$((D_WARNS + $(printf '%s\n' "$df_l" | wc -l))); }
    done
  fi
  for df_d in "$HOME"/.claude/skills/* "$ROOT"/.claude/skills/* "$HOME"/.claude/plugins/cache/*/*/*/skills/*; do
    [ -d "$df_d" ] || continue
    case "$df_d" in */plugins/cache/proofline/*) continue ;; esac
    df_n=${df_d##*/}
    case "$df_n" in proofline*) continue ;; esac
    [ ! -d "$ROOT/.agents/skills/$df_n" ] || continue
    printf '%s\n' "$df_n" | grep -Eq '(^|-)(tdd|debug|debugging|review|plan|planning|plans|ui-audit)(-|$)|test-driven' || continue
    d_warn "overlapping skill: $df_n (${df_d%/*/*}) overlaps a proofline method skill; during a run proofline's own skill is used"
  done
}

# 0.0.26: the language runtimes the project's CI specifies against the ones installed here. WARN only, never FAIL:
# a different major version (major.minor for the runtimes the ecosystem definition compares so) means a green local run may not hold in CI.
doctor_toolchain() {
  dt_s=$PL_HOME/skills/verify-proof/scripts/runtime-versions.sh
  [ -f "$dt_s" ] || return 0
  dt_out=$(cd "$ROOT" && sh "$dt_s" 2>/dev/null) || return 0
  while read -r dt_k dt_n dt_l dt_c dt_f dt_st; do
    [ "$dt_k" = 'runtime:' ] || continue
    [ "$dt_n" != none ] || continue # `runtime: none (...)` says no runtime was found; it is not a runtime named none
    dt_l=${dt_l#local=}; dt_c=${dt_c#ci=}; dt_f=${dt_f#source=}; dt_st=${dt_st#status=}
    dt_u=major # without the definition only the major version is compared; runtime.compare says how many components (A187)
    if [ -n "$D_ECO" ]; then # the number of version components compared comes from the ecosystem definition (A173)
      dt_id=$(eco_match '^runtime\.name$' | awk -F'\t' -v n="$dt_n" '$3 == n { print $1; exit }')
      [ -z "$dt_id" ] || case "$(eco_first "$dt_id" runtime.compare)" in 1) dt_u=major ;; *) dt_u='major.minor' ;; esac
    fi
    if [ "$dt_l" = missing ]; then
      d_warn "toolchain $dt_n: not installed here$([ "$dt_c" = none ] || printf ', CI specifies %s (%s)' "$dt_c" "$dt_f")"
    elif [ "$dt_st" = mismatch ]; then
      d_warn "toolchain $dt_n: local $dt_l, CI specifies $dt_c ($dt_f); the $dt_u version differs, so a green local run may not hold in CI"
    elif [ "$dt_c" = none ]; then d_pass "toolchain $dt_n: local $dt_l (no CI-specified version found)"
    elif [ "$dt_st" = match ]; then d_pass "toolchain $dt_n: local $dt_l matches CI $dt_c ($dt_f)"
    else d_pass "toolchain $dt_n: local $dt_l, CI specifies $dt_c ($dt_f), not comparable"; fi
  done <<EOF2
$dt_out
EOF2
}

# A174: the review risk paths and the dependency signal read .agents/ecosystems.tsv; config.yaml no longer lists the language files. A missing, empty or
# stale tsv would silently shrink them, so doctor FAILs. Sound check: the tsv must be what the project's own ecosystems.json generates (node), or, without node,
# equal to the shipped copy when the project's ecosystems.json is the shipped one.
doctor_ecosystems() {
  de_j=$ROOT/.agents/ecosystems.json; de_t=$ROOT/.agents/ecosystems.tsv; de_m=$ROOT/.agents/ecosystems.mjs
  if [ ! -s "$de_t" ]; then d_fail "ecosystems: .agents/ecosystems.tsv is missing or empty, so the risky-path and dependency sets are empty (run: proofline upgrade)"; return 0; fi
  if [ ! -s "$de_j" ]; then d_fail "ecosystems: .agents/ecosystems.json is missing (run: proofline upgrade)"; return 0; fi
  if [ ! -f "$ROOT/.agents/scripts/ecosystems.sh" ]; then d_fail "ecosystems: .agents/scripts/ecosystems.sh is missing, so agent.sh cannot read the definition (run: proofline upgrade)"; return 0; fi
  if command -v node >/dev/null 2>&1 && [ -f "$de_m" ]; then
    if de_o=$(node "$de_m" check 2>&1); then d_pass "ecosystems: .agents/ecosystems.tsv is what .agents/ecosystems.json generates"
    else d_fail "ecosystems: $(printf '%s' "$de_o" | head -2 | tr '\n' ' ') (fix: node .agents/ecosystems.mjs write, or proofline upgrade)"; fi
  elif cmp -s "$de_j" "$PL_HOME/control-plane/agents/ecosystems.json"; then
    if cmp -s "$de_t" "$PL_HOME/control-plane/agents/ecosystems.tsv"; then d_pass "ecosystems: .agents/ecosystems.tsv equals the shipped one"
    else d_fail "ecosystems: .agents/ecosystems.tsv differs from the shipped one although ecosystems.json is the shipped file (run: proofline upgrade)"; fi
  else d_warn "ecosystems: node is not available and .agents/ecosystems.json is not the shipped file, so the tsv could not be checked"; fi
}

# A194: the plugin (this CLI) and the project's install are one version; when they differ, one line and the next step.
doctor_version() {
  dv_i=$(cfg_val "$CFG" proofline_version '')
  [ -n "$dv_i" ] || return 0
  if [ "$dv_i" = "$PROOFLINE_VERSION" ]; then d_pass "version: plugin and project install are both $dv_i"; return 0; fi
  if [ "$(printf '%s\n%s\n' "$dv_i" "$PROOFLINE_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$dv_i" ]; then
    d_warn "version: plugin $PROOFLINE_VERSION, project install $dv_i; the project is older. Next step: /proofline upgrade"
  else d_warn "version: plugin $PROOFLINE_VERSION, project install $dv_i; the project is newer than the plugin. Next step: update the plugin"; fi
}

# A194: optional tools. proofline neither installs nor requires them; installed, ast-grep serves structural searches and
# rtk's compression is bypassed (RTK_DISABLED=1) for every command that produces evidence. One line.
doctor_tools() {
  dtl_a='ast-grep not installed (rg/grep are used)'; command -v ast-grep >/dev/null 2>&1 && dtl_a="ast-grep installed ($(command -v ast-grep))"
  dtl_r='rtk not installed'; command -v rtk >/dev/null 2>&1 && dtl_r="rtk installed ($(command -v rtk)); evidence commands run with RTK_DISABLED=1 (rtk configuration docs)"
  d_pass "tools: $dtl_a; $dtl_r"
}

cmd_doctor() {
  D_FAILS=0; D_WARNS=0
  case "${1:-}" in
    --commands) require_installed; cm_propose; return 0 ;;
    --apply-commands) require_installed; cm_apply; return 0 ;;
    '') ;;
    *) die "doctor: unknown argument: $1" ;;
  esac
  CFG=$ROOT/.agents/config.yaml; A=$ROOT/.agents/scripts/agent.sh
  if [ ! -f "$CFG" ] || [ ! -f "$A" ]; then
    d_fail "installed: .agents/config.yaml or .agents/scripts/agent.sh missing in $ROOT (run: proofline init)"
    printf 'doctor: %s FAIL, %s WARN\n' "$D_FAILS" "$D_WARNS"; return 1
  fi
  MANIFEST_OLD=$ROOT/$MANIFEST_REL
  RUNTIMES=$(manifest_meta runtimes || true)
  [ -n "$RUNTIMES" ] || RUNTIMES=$(printf '%s %s %s\n' "$(cfg_val "$CFG" runtime.lead claude)" "$(cfg_val "$CFG" runtime.worker '')" "$(cfg_val "$CFG" runtime.reviewers '')" | tr ' ' '\n' | grep . | sort -u | tr '\n' ' ' | sed 's/ $//')
  d_pass "installed: proofline $(cfg_val "$CFG" proofline_version '?') in $ROOT (runtimes: $RUNTIMES, profile $(cfg_val "$CFG" profile balanced))"

  if [ -f "$MANIFEST_OLD" ]; then
    dm_bad=0; dm_gone=0; dm_crit=''
    while read -r dm_s dm_p; do
      if [ ! -e "$ROOT/$dm_p" ]; then
        case "$dm_p" in
          .agents/scripts/agent.sh|.agents/scripts/dispatch.sh|.agents/githooks/*|.agents/hooks/*|.agents/owns.conf|.agents/roles/owns.conf|.agents/tools.conf|.agents/roles.conf|.agents/skills/proofline-lead/*)
            dm_crit="$dm_crit $dm_p" ;;
          *) dm_gone=$((dm_gone + 1)) ;;
        esac
      elif [ "$(sha256 "$ROOT/$dm_p")" != "$dm_s" ]; then dm_bad=$((dm_bad + 1)); fi
    done <<EOF
$(grep -v '^#' "$MANIFEST_OLD")
EOF
    for dm_c in $dm_crit; do d_fail "manifest: required control-plane file missing: $dm_c (run: proofline upgrade)"; done
    if [ "$dm_gone" -gt 0 ]; then d_warn "manifest: $dm_gone installed file(s) are missing (proofline upgrade restores them)"; fi
    if [ "$dm_bad" -gt 0 ]; then d_warn "manifest: $dm_bad installed file(s) differ from the installed version (modified by you; upgrade keeps them)"; fi
    if [ "$dm_gone" -eq 0 ] && [ "$dm_bad" -eq 0 ] && [ -z "$dm_crit" ]; then d_pass "manifest: every installed file matches"; fi
  else d_warn "manifest: $MANIFEST_REL missing; upgrade cannot tell your edits from proofline's files"; fi

  hp=$(g config --get core.hooksPath 2>/dev/null || true)
  case "$hp" in
    .agents/githooks|"$ROOT/.agents/githooks")
      dh_ok=1
      for dh in pre-commit pre-push human.sh; do
        if [ ! -x "$ROOT/.agents/githooks/$dh" ]; then d_fail "git hooks: .agents/githooks/$dh is missing or not executable"; dh_ok=0; fi
      done
      [ "$dh_ok" = 0 ] || d_pass "git hooks: core.hooksPath = .agents/githooks, pre-commit, pre-push and human.sh executable" ;;
    '') d_fail "git hooks: core.hooksPath is not set; the commit and push locks are inactive. Fix: git config --local core.hooksPath .agents/githooks" ;;
    *) d_fail "git hooks: core.hooksPath is '$hp', not .agents/githooks; the proofline locks are inactive" ;;
  esac

  dd_glob=$(global_hookspath)
  [ -z "$dd_glob" ] || d_warn "git hooks: $(global_hookspath_msg "$dd_glob")"

  if out=$(cd "$ROOT" && sh "$A" config-check 2>&1); then d_pass "config: $(printf '%s' "$out" | head -1)"
  else d_fail "config: agent.sh config-check failed: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"; fi

  # A202 item 28: how long the approval path takes on THIS machine (the content fingerprint every approval binds, then the approval step with
  # nothing to approve: the cost the prompt hook pays before it can write an approval), against the hook's approval budget.
  if [ -f "$A" ]; then
    da_b=$(cfg_val "$CFG" hook.approve_budget_seconds 20); case "$da_b" in ''|*[!0-9]*) da_b=20 ;; esac
    [ "$da_b" -ge 5 ] || da_b=5; [ "$da_b" -le 25 ] || da_b=25
    da_t0=$(doctor_ms); (cd "$ROOT" && sh "$A" fingerprint >/dev/null 2>&1 </dev/null); (cd "$ROOT" && sh "$A" approve-pending - >/dev/null 2>&1 </dev/null); da_t1=$(doctor_ms)
    da_ms=$((da_t1 - da_t0))
    if [ "$da_ms" -ge $((da_b * 500)) ]; then
      d_warn "approval path: $da_ms ms on this machine, $((da_b * 1000)) ms hook budget (hook.approve_budget_seconds); close to or over half of it. A slow machine can raise hook.approve_budget_seconds in .agents/config.yaml (5 to 25); the cause is usually a large unignored folder or a loaded machine"
    else d_pass "approval path: $da_ms ms (hook budget $((da_b * 1000)) ms)"; fi
  fi

  doctor_ecosystems

  # A135: a Codex lead needs the base model; report the model the policy resolves for the lead.
  EP=$ROOT/.agents/scripts/exec-policy.sh
  if [ "$(cfg_val "$CFG" runtime.lead claude)" = codex ] && [ -f "$EP" ]; then
    grep -q '^  lead_base_model:' "$CFG" || d_warn "lead model: .agents/config.yaml has no execution_policy.lead_base_model (the built-in base is used; run: proofline upgrade)"
    if lm=$(cd "$ROOT" && sh "$EP" resolve --role lead --class STANDARD --tier full 2>/dev/null | sed -n 's/^model=//p') && [ -n "$lm" ]; then
      if out=$(cd "$ROOT" && sh "$EP" check-lead --runtime codex --model "$lm" 2>&1); then d_pass "lead model: codex lead resolves to $lm (base model or stronger)"
      else d_fail "lead model: $(printf '%s' "$out" | head -1)"; fi
    else d_warn "lead model: could not resolve the codex lead model (exec-policy.sh resolve failed)"; fi
  fi

  used="$(cfg_val "$CFG" runtime.lead claude) $(cfg_val "$CFG" runtime.worker '') $(cfg_val "$CFG" runtime.reviewers '')"
  for rt in claude codex; do
    case "$rt" in claude) bin=${PROOFLINE_CLAUDE_BIN:-claude} ;; codex) bin=${PROOFLINE_CODEX_BIN:-codex} ;; esac
    case " $used " in *" $rt "*) inuse=yes ;; *) inuse=no ;; esac
    if command -v "$bin" >/dev/null 2>&1; then d_pass "runtime $rt: $("$bin" --version 2>/dev/null | head -1 || true) ($(command -v "$bin"))"
    elif [ "$inuse" = yes ]; then d_warn "runtime $rt: not installed, but config.yaml uses it (failover/dispatch to $rt will be BLOCKED)"
    else d_pass "runtime $rt: not installed (not used by config.yaml)"; fi
  done

  hs=$ROOT/.agents/hooks/proofline-hook.sh
  if [ ! -f "$hs" ]; then d_fail "hooks: .agents/hooks/proofline-hook.sh missing"
  elif ! sh -n "$hs" 2>/dev/null; then d_fail "hooks: .agents/hooks/proofline-hook.sh does not parse"
  else d_pass "hooks: .agents/hooks/proofline-hook.sh present"; fi
  if rt_has claude; then
    miss=''
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse SubagentStart SubagentStop; do hook_has "$ROOT/.claude/settings.json" "$ev" || miss="$miss $ev"; done
    if [ -z "$miss" ]; then d_pass "claude hooks: .claude/settings.json wires all 6 proofline events"
    else
      RW_OUT=$(mktemp "${TMPDIR:-/tmp}/proofline-plugin.XXXXXX"); export RW_OUT
      run_with_timeout 20 "${PROOFLINE_CLAUDE_BIN:-claude}" plugin list 2>/dev/null
      if [ -f "$RW_OUT" ] && grep -qi proofline "$RW_OUT"; then d_pass "claude hooks: provided by the proofline plugin (project settings do not need them)"
      else d_fail "claude hooks: .claude/settings.json lacks proofline hooks for:$miss (run: proofline init)"; fi
      rm -f "$RW_OUT"; unset RW_OUT
    fi
  fi
  if rt_has codex; then
    miss=''
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse SubagentStart SubagentStop; do hook_has "$ROOT/.codex/hooks.json" "$ev" || miss="$miss $ev"; done
    if [ -z "$miss" ]; then d_pass "codex hooks: .codex/hooks.json wires all 6 proofline events"
    else d_fail "codex hooks: .codex/hooks.json lacks proofline hooks for:$miss (run: proofline init)"; fi
    d_warn "codex trust: Codex loads project hooks only once the project is trusted and the hooks are reviewed; open codex here and approve them with /hooks (doctor cannot check this)"
  fi

  dc_empty=''
  for dc_k in build test lint; do [ -n "$(cfg_cmds "$CFG" "commands.$dc_k")" ] || dc_empty="$dc_empty $dc_k"; done
  [ -z "$dc_empty" ] || d_warn "commands: empty in .agents/config.yaml:$dc_empty (the verify gate has nothing to run for them and no build record can be made). Fix: proofline doctor --commands finds the commands, proves each by one run and asks you once (A200)"

  # A180: which hosting platform the origin remote is, which tool is installed for it, and so which merge rule applies.
  doctor_platform
  # A163, A180: no pull_request check is a warning (the commit is then verified locally before the merge), with the fix line.
  dc_ci=$(cd "$ROOT" && sh "$A" ci-check 2>/dev/null) || :   # exit 1 means absent; the output still holds the verdict
  case "$(printf '%s\n' "$dc_ci" | head -1)" in
    'ci: absent')
      discover_commands "$ROOT" >/dev/null 2>&1 || true
      d_warn "ci: $(printf '%s\n' "$dc_ci" | sed -n 2p) Fix: $(cd "$ROOT" && PROOFLINE_CI_BUILD=$D_BUILD PROOFLINE_CI_TEST=$D_TEST sh "$A" ci-task-command)" ;;
    'ci: present'*) d_pass "$dc_ci" ;;
  esac

  doctor_context
  doctor_rules
  doctor_version
  doctor_tools
  doctor_toolchain
  doctor_foreign
  doctor_identity
  doctor_probes
  printf 'doctor: %s FAIL, %s WARN\n' "$D_FAILS" "$D_WARNS"
  [ "$D_FAILS" -eq 0 ]
}
