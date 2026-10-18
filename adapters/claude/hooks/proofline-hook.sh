#!/bin/sh
# proofline runtime hook: the extra enforcement layer for Claude Code and Codex (D2, D6, D12, D13, D16).
# The foundation stays agent.sh and the git hooks; this script never decides a gate, it only blocks tool
# calls early and feeds agent.sh. Normative description: docs/concepts/enforcement-layers.md.
#
#   proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]
#
# stdin: the runtime's hook JSON. JSON is read with jq, else node (PROOFLINE_JSON=jq|node|none overrides,
# for tests). Unparsable input while a run is active: PreToolUse denies (fail closed); everything else and
# any input without an active run passes (fail open). Without .agents/config.yaml and
# .agents/scripts/agent.sh in the project, every event is a no-op.
#
# Caller identity: a subagent carries agent_id/agent_type (`proofline-<role>`, optional `<plugin>:` prefix);
# a headless specialist started by dispatch.sh carries AGENT_ROLE in the hook's environment; anything else
# is the lead (non-proofline subagents get the lead's restrictions).
set -u
ev=${1:-}; rt=${2:-claude}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/proofline-hook.XXXXXX") || exit 0
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/in"

jp=${PROOFLINE_JSON:-}
if [ -z "$jp" ]; then
  if command -v jq >/dev/null 2>&1; then jp=jq; elif command -v node >/dev/null 2>&1; then jp=node; else jp=none; fi
fi
# jget [PATH...]: the first non-null value of dotted PATHs; strings raw, string arrays space-joined, other
# values as JSON. Without PATHs it only validates the input. Exit non-zero when the input is not JSON.
jget() {
  case "$jp" in
    jq) jq -je --arg ps "$*" '. as $r | [($ps | split(" "))[] | . as $p | ($r | try getpath($p | split(".")) catch null) | select(. != null)]
          | (first // "") | if type == "string" then . elif type == "array" and all(type == "string") then join(" ") else tojson end' < "$tmp/in" 2>/dev/null ;;
    node) node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch (e) { process.exit(1) }
          for (const p of process.argv.slice(1)) { let v = r; for (const k of p.split(".")) v = (v !== null && typeof v === "object") ? v[k] : undefined
            if (v !== undefined && v !== null) { process.stdout.write(typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : JSON.stringify(v)); break } }' "$@" < "$tmp/in" ;;
    *) return 1 ;;
  esac
}
jesc() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if (NR > 1) print "\\n"; print }'; }
ctx() { # EVENT TEXT: additionalContext for the model
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$1" "$(jesc "$2")"; exit 0
}
deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(jesc "proofline: $*")"
  exit 0
}
if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | awk '{print $1}'; }; else sha() { sha256sum "$1" | awk '{print $1}'; }; fi
canon() { case "$1" in full_lifecycle) echo lead ;; implementation_worker) echo implementer ;; independent_reviewer) echo reviewer ;; independent_qa) echo qa ;; independent_verifier) echo verifier ;; *) printf '%s\n' "$1" ;; esac; }
valid_role() { case "$1" in lead|task_author|explorer|architect|data_architect|designer|qa|implementer|reviewer|security_reviewer|verifier) return 0 ;; *) return 1 ;; esac; }
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'; }

parsed=yes; jget >/dev/null || parsed=no
cwd=''; [ "$parsed" = no ] || cwd=$(jget cwd)
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd=$PWD
root=${CLAUDE_PROJECT_DIR:-}
[ -n "$root" ] || root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
root=$(CDPATH='' cd "$root" 2>/dev/null && pwd -P) || exit 0
agent=$root/.agents/scripts/agent.sh
# Not installed: every event is a no-op, except the merge guard of pretool (A136), which protects any project the hook runs in.
installed=yes; { [ -f "$root/.agents/config.yaml" ] && [ -f "$agent" ]; } || installed=no
local_dir=$root/.agents/local
# once: the same hook registered from several places (plugin, project, user; Codex runs it up to three times) runs
# once per identical event; a copy that starts less than two seconds after the first exits. Only for events with side
# effects (prompt, session).
once() {
  mkdir -p "$local_dir/hooklock" 2>/dev/null || return 0
  find "$local_dir/hooklock" -type f -mmin +5 -exec rm -f {} + 2>/dev/null
  o_k=$local_dir/hooklock/$ev.$(sha "$tmp/in" | cut -c1-16); o_n=$(date +%s)
  ( set -C; printf '%s\n' "$o_n" > "$o_k" ) 2>/dev/null && return 0
  o_p=$(cat "$o_k" 2>/dev/null); case "$o_p" in *[!0-9]*) o_p=0 ;; esac
  if [ -z "$o_p" ] || [ $((o_n - o_p)) -le 1 ]; then exit 0; fi   # empty: the first copy is still writing its stamp
  # an old stamp: one copy takes it over (mkdir is atomic), then checks that no other copy did
  mkdir "$o_k.t" 2>/dev/null || exit 0
  o_p=$(cat "$o_k" 2>/dev/null); case "$o_p" in ''|*[!0-9]*) o_p=0 ;; esac
  if [ $((o_n - o_p)) -le 1 ]; then rmdir "$o_k.t"; exit 0; fi
  printf '%s\n' "$o_n" > "$o_k"; rmdir "$o_k.t"
}

# Active run: the selector's single id; anything malformed counts as active (fail closed).
act=''
if [ -f "$local_dir/ACTIVE_RUN" ]; then
  act=$(sed '/^[[:space:]]*$/d' "$local_dir/ACTIVE_RUN" | tr -d ' \t')
  case "$act" in '') ;; *[!A-Za-z0-9_-]*) act=INVALID ;; esac
fi

aid=''; atype=''; [ "$parsed" = no ] || { aid=$(jget agent_id); atype=$(jget agent_type); }
envrole=$(canon "${AGENT_ROLE:-}")
role=lead; prole=''
t=${atype##*:}
case "$t" in proofline-*) r=$(canon "$(printf '%s' "${t#proofline-}" | tr - _)"); if valid_role "$r" && [ "$r" != lead ]; then prole=$r; fi ;; esac
if [ -n "$aid" ] || [ -n "$atype" ]; then [ -z "$prole" ] || role=$prole
elif [ -n "$envrole" ] && [ "$envrole" != lead ] && valid_role "$envrole"; then role=$envrole; fi
sub=no; { [ -n "$aid" ] || [ -n "$atype" ]; } && sub=yes
aidf=$(safe "${aid:-unknown}")
# Read roles (A143) change nothing in the project working tree; mutation and trials run in an evidence worktree.
ro=no; case "$role" in qa|reviewer|security_reviewer|verifier) ro=yes ;; esac
# shellcheck disable=SC2016 # literal $TMPDIR in the message
ro_tail() { [ "$ro" = yes ] || return 0; printf ' (role %s is read-only in the project working tree, A143: mutation, trials and fix attempts run only in an evidence worktree, a git worktree outside the project that you create under $TMPDIR: git worktree add --detach "$TMPDIR/<name>" HEAD, in its own call, then use literal paths inside it; git worktree list shows it. Allowed in the project: your run result files and .agents/runs/<ID>/scratch/)' "$role"; }

# --- path policy ----------------------------------------------------------------------------
tasks_dir=''
# relpath P: project-relative path of P (resolved against cwd; symlinks in every existing parent directory
# resolved); "@outside" when outside the project, "@unknown" when it cannot be resolved (incl. a dangling
# symlink among the parents). The last component is not followed; target_ok refuses links there.
relpath() {
  rp=$1; case "$rp" in /*) ;; *) rp=$cwd/$rp ;; esac
  rp_dir=$(dirname "$rp") rp_tail=$(basename "$rp")
  while [ ! -d "$rp_dir" ]; do
    [ ! -L "$rp_dir" ] || { echo @unknown; return; }
    rp_tail=$(basename "$rp_dir")/$rp_tail; rp_dir=$(dirname "$rp_dir")
  done
  case "/$rp_tail/" in */../*|*/./*) echo @unknown; return ;; esac
  rp_dir=$(CDPATH='' cd "$rp_dir" 2>/dev/null && pwd -P) || { echo @unknown; return; }
  rp=$rp_dir/$rp_tail
  case "$rp" in "$root") echo . ;; "$root"/*) printf '%s\n' "${rp#"$root"/}" ;; *) echo @outside; [ "${2:-}" != abs ] || printf '%s\n' "$rp" ;; esac
}
# outside_ok P: may a Write/Edit tool write P, which relpath put outside the project? Only inside a registered
# worktree or the runtime's own storage (~/.claude/projects/*/memory, tool-results, ~/.claude/plans); a sibling such as <project>-x is outside (A120, C-18).
outside_ok() {
  oo_p=$(relpath "$1" abs | sed -n 2p); oo_p=${oo_p#/private}
  oo_h=$(printf '%s' "${HOME:-/nonexistent-home}" | sed 's|//*|/|g'); oo_h=${oo_h#/private}
  case "$oo_p" in "$oo_h"/.claude/projects/*/memory/*|"$oo_h"/.claude/projects/*/tool-results/*|"$oo_h"/.claude/plans/*) return 0 ;; esac
  git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' > "$tmp/oo_wts"
  while IFS= read -r oo_w; do
    [ "${oo_w#/private}" != "${root#/private}" ] || continue
    case "$oo_p" in "${oo_w#/private}"/*) return 0 ;; esac
  done < "$tmp/oo_wts"
  echo "$1 is outside the project. A run writes nothing outside the copy (registered worktrees and the runtime's own storage excepted); a path that merely shares a prefix with the project root is outside too"
  return 1
}
# always_protected REL: the git hooks and the git config that wires them; never written by an agent.
always_protected() { case "$1" in .agents/githooks|.agents/githooks/*|.git/config|.git/config.*) return 0 ;; esac; return 1; }
# target_ok P: may the caller write P now? A symlink or a multiply hard-linked file is never a write target
# during a run (it would land elsewhere); otherwise path_ok on the resolved project-relative path.
target_ok() {
  to_p=$1; case "$to_p" in /*) ;; *) to_p=$cwd/$to_p ;; esac
  if [ -L "$to_p" ]; then echo "the target is a symbolic link; writes through links are never allowed during a run"; return 1; fi
  if [ -f "$to_p" ] && [ -n "$(find "$to_p" -prune -links +1 2>/dev/null)" ]; then echo "the target has several hard links; writes through links are never allowed during a run"; return 1; fi
  path_ok "$(relpath "$1")"
}
# erasable P: may a deletion of P pass although the path policy refuses it? Only a file or symlink the run itself
# created: in the run's scratch/, or elsewhere one git neither tracks nor ignores that changed after the run began
# (an audit output in the repository root). Protected state (.git, .agents outside scratch, runtime config) never.
erasable() {
  er_r=$(relpath "$1")
  case "$er_r" in
    @*|.|.git|.git/*|.claude/*|.codex/*) return 1 ;;
    .agents/runs/"$act"/scratch/*) ;;
    .agents/*) return 1 ;;
  esac
  er_p=$1; case "$er_p" in /*) ;; *) er_p=$cwd/$er_p ;; esac
  [ -f "$er_p" ] || [ -L "$er_p" ] || return 1
  case "$er_r" in .agents/runs/"$act"/scratch/*) return 0 ;; esac
  [ "$ro" = no ] || return 1   # A143: a read role leaves the project tree unchanged
  ! always_protected "$er_r" || return 1
  [ -z "$(git -C "$root" ls-files -- "$er_r" 2>/dev/null)" ] || return 1
  ! git -C "$root" check-ignore -q -- "$er_r" 2>/dev/null || return 1
  # not in the untracked set recorded when the run's first hook event came (the user's own work in progress is in it)
  [ -f "$local_dir/baseline/$act" ] && ! grep -qxF -- "$er_r" "$local_dir/baseline/$act"
}
# baseline: once per run, the untracked, unignored files that exist before the run changes anything.
baseline() {
  [ "$installed" = yes ] && [ -n "$act" ] && [ "$act" != INVALID ] && [ ! -f "$local_dir/baseline/$act" ] || return 0
  mkdir -p "$local_dir/baseline" 2>/dev/null || return 0
  git -C "$root" ls-files -z --others --exclude-standard 2>/dev/null | tr '\0' '\n' >"$local_dir/baseline/.$act.tmp" && mv "$local_dir/baseline/.$act.tmp" "$local_dir/baseline/$act"
}
# ro_operand KIND WORD (A143): may a read role pass WORD, an operand of an in-place editing command (KIND P: only an
# existing file counts, the program text is also an operand) or of a script editor (KIND Q: any path counts)?
# Prints the reason on refusal. A path outside the project is left to the shell-write rules; a variable path that
# starts with neither $TMPDIR nor $HOME cannot be read, so it is refused.
ro_operand() {
  ro_v=$2
  case "$ro_v" in .) ro_v=$cwd ;; */.) ro_v=${ro_v%/.} ;; esac   # patch: its targets are named in the diff, so the directory counts
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$ro_v" in '$TMPDIR'/*|'${TMPDIR}'/*) ro_v=${TMPDIR:-/tmp}/${ro_v#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) ro_v=${HOME:-/nonexistent-home}/${ro_v#*/} ;; esac
  case "$ro_v" in
    *'$'*|*'`'*|'~'*)
      case "$ro_v" in *[[:space:]]*|*';'*|*'{'*|*'('*|*'='*) return 0 ;; esac
      echo "the path '$2' of an in-place edit cannot be resolved from the command text"; return 1 ;;
  esac
  case "$ro_v" in /*) ro_a=$ro_v ;; *) ro_a=$cwd/$ro_v ;; esac
  [ "$1" = Q ] || [ -e "$ro_a" ] || return 0
  case "$(relpath "$ro_v")" in @outside) return 0 ;; esac
  target_ok "$ro_v"
}
# own_match REL TOKEN BASE: does owns.conf TOKEN (relative to BASE) cover REL? A token ending in / covers
# its subtree, any other token one exact path; NNN in a token stands for three digits.
own_match() {
  om_t=$3$2
  case "$om_t" in */) case "$1" in "$om_t"*) return 0 ;; esac; return 1 ;; esac
  om_p=$(printf '%s' "$om_t" | sed 's/NNN/[0-9][0-9][0-9]/g')
  # shellcheck disable=SC2254 # om_p is a pattern on purpose (NNN); tokens contain no other glob characters
  case "$1" in $om_p) return 0 ;; esac; return 1
}
# path_ok REL: may the caller write REL now? Prints the reason on refusal.
path_ok() {
  po=$1; run=.agents/runs/$act
  if [ -z "$tasks_dir" ]; then
    tasks_dir=$(sh "$agent" config-get tasks.dir 2>/dev/null) || tasks_dir=''
    tasks_dir=${tasks_dir%/}; [ -n "$tasks_dir" ] || tasks_dir=.agents/tasks
  fi
  case "$po" in @outside) return 0 ;; @unknown) echo "cannot resolve the target path"; return 1 ;; esac
  if always_protected "$po"; then echo "$po wires the git hooks; it is never changed by an agent"; return 1; fi
  # The lead writes dispatch assignments (DISPATCH.md); nothing else under .agents/local/.
  case "$role:$po" in lead:.agents/local/assignments/*) return 0 ;; esac
  # Scratch files live in the run folder (D10, A56): writable by every role, never gate input.
  case "$po" in "$run"/scratch/*) return 0 ;; esac
  case "$po" in
    .claude/settings.json|.claude/settings.local.json|.codex/hooks.json|.codex/config.toml|.agents/hooks|.agents/hooks/*)
      echo "$po holds the runtime hooks; it is never edited during a run"; return 1 ;;
    "$run"/RUN.yaml|"$run"/LEDGER.log|"$run"/mutation_budget|"$run"/gates/*|"$run"/approvals/*|"$run"/waivers/*|"$run"/questions/*|"$run"/decisions/*|"$run"/dispatch/*|"$run"/worker-evidence/*|"$run"/results/*.result.md|"$run"/results/dispatch-*|.agents/local|.agents/local/*)
      echo "$po is written only by agent.sh and the runtime hooks"; return 1 ;;
  esac
  case "$role" in
    lead)
      case "$po" in
        "$run"/TASK.md|"$run"/PLAN.md|"$run"/EVIDENCE.md|"$run"/COMPLETION_REPORT.md|"$run"/amendments/*|"$tasks_dir"/*) return 0 ;;
      esac
      echo "the lead writes only run artifacts (TASK.md PLAN.md EVIDENCE.md COMPLETION_REPORT.md amendments/), task files and .agents/local/assignments/ while run $act is active; product changes go through the implementer (D2)"; return 1 ;;
  esac
  # Specialists: the role's owned paths from .agents/owns.conf (generated; `<role> <token>...`).
  # Token: run-relative path; `/<path>` project-relative (own_match); PRODUCT_SCOPE = the frozen PLAN.md
  # scope paths (a path ending in / covers its subtree) plus the run dir. Without a line for the role:
  # implementer PRODUCT_SCOPE, task_author the run dir and tasks.dir, everyone else the run dir only.
  # Implementer and designer subagents write outside the run dir only inside their window.
  po_own=''
  [ -f "$root/.agents/owns.conf" ] && po_own=$(awk -v r="$role" '$1 == r { $1 = ""; print; exit }' "$root/.agents/owns.conf")
  if [ -z "$po_own" ]; then
    case "$role" in implementer) po_own=PRODUCT_SCOPE ;; task_author) po_own="@run /$tasks_dir/" ;; *) po_own=@run ;; esac
  fi
  po_hit=no
  for po_t in $po_own; do
    case "$po_t" in
      @run) case "$po" in "$run"/*) po_hit=yes ;; esac ;;
      PRODUCT_SCOPE)
        case "$po" in "$run"/*) po_hit=yes ;; esac
        # shellcheck disable=SC2013 # scope paths contain no whitespace (agent.sh scope format)
        for po_s in $(awk '/^scope:$/ { i = 1; next } i && /^---$/ { exit } i && /^  - path: / { sub(/^  - path: /, ""); gsub(/["\047]/, ""); print }' "$root/$run/PLAN.md" 2>/dev/null); do
          case "$po_s" in */) case "$po" in "$po_s"*) po_hit=yes ;; esac ;; *) [ "$po" != "$po_s" ] || po_hit=yes ;; esac
        done ;;
      /*) ! own_match "$po" "${po_t#/}" '' || po_hit=yes ;;
      *) ! own_match "$po" "$po_t" "$run/" || po_hit=yes ;;
    esac
    [ "$po_hit" = no ] || break
  done
  if [ "$po_hit" = no ]; then echo "$po is outside the paths role $role owns ($po_own; .agents/owns.conf, PLAN.md scope)"; return 1; fi
  case "$role:$sub:$po" in
    implementer:yes:"$run"/*|designer:yes:"$run"/*) ;;
    implementer:yes:*|designer:yes:*)
      # A headless specialist (dispatch.sh, also the failover codex -> claude) has AGENT_ROLE in the hook's
      # environment: dispatch.sh opened its window before starting it; SubagentStart does not run in that process.
      [ -f "$local_dir/windows/$aidf" ] || [ "$envrole" = "$role" ] || { echo "no $role window is open for this subagent (SubagentStart window-open failed or was skipped); the change would be unattributed"; return 1; } ;;
  esac
  return 0
}

# scan_cmd: reads shell command text, prints one record per finding, "<K><TAB><value>" (newlines in a value
# as \002). A heuristic tokenizer, not a parser: quotes are removed (agent.s""h = agent.sh), heredoc bodies
# skipped, `sh|bash -c STRING`, "$(...)" and "`...`" inside double quotes are scanned as nested commands.
#   W path   the command writes path (redirection, tee, sed -i, perl -i, cp/mv/install/rsync/ln target, mv
#            sources, touch/rm/truncate/unlink/rmdir/shred, chmod/chown/chgrp operands, dd of=)
#   E path   additionally, for each operand of rm and unlink: the command deletes path (see erasable)
#   P word   an operand (program text included) of a command that edits files in place (sed -i, perl/ruby -i,
#            awk -i inplace, patch); only the read-role guard reads it (A143)
#   Q word   an operand of an editor run from a script (ed, ex, vi, vim); only the read-role guard reads it (A143)
#   L arg    an ln operand (link or link target)
#   A l sub  an agent.sh invocation; l = 1 when the subcommand word is literal
#   R value  an AGENT_ROLE=value assignment (anywhere: prefix, env, export, plain word)
#   N word   a nested headless runtime (claude -p/--print, codex exec|e)
#   X why    refused while a run is active (non-literal command word or script, eval, env -S, a shell
#            reading stdin, indirect AGENT_ROLE, nesting beyond one level, copies of agent.sh)
#   B why    a git hook bypass; refused always
#   C word args   every simple command: its command word and its arguments joined with \003 (database guard)
scan_cmd() {
  awk 'BEGIN { RS = "\001" }
  function out(k, v) { if ((k == "W" || k == "E" || k == "P" || k == "Q") && cwdp != "" && substr(v, 1, 1) != "/" && substr(v, 1, 1) != "~") v = cwdp "/" v; gsub(/\n/, "\002", v); print k "\t" v }
  function base(x) { sub(/.*\//, "", x); return x }
  function isassign(x) { return x ~ /^[A-Za-z_][A-Za-z0-9_]*=/ }
  function push(t, d) {
    if (d > 4) { out("B", "commands nested more than four levels deep"); return }
    if (d > 1) out("X", "a nested shell command inside a nested shell command")
    qs[++qn] = t; qd[qn] = d
  }
  function mparen(s, p,   d, c2, m) { d = 0; m = length(s); for (; p <= m; p++) { c2 = substr(s, p, 1); if (c2 == "(") d++; else if (c2 == ")") { d--; if (!d) return p } } return m }
  function endword() {
    if (!have) return
    if (redir) { out("W", cur); redir = 0 } else if (inredir) { if (inredir == 2) hd = cur; else out("C", "<\t" cur); inredir = 0 } else if (dup) { dup = 0 } else { w[++nw] = cur; L[nw] = lit }
    cur = ""; have = 0; lit = 1
  }
  function takesval(wr, x) {
    if (wr == "env") return x ~ /^(-u|--unset|-C|--chdir)$/
    if (wr == "sudo" || wr == "doas") return x ~ /^-[ugCDhpRrTt]$/
    if (wr == "nice") return x == "-n"
    if (wr == "xargs") return x ~ /^-[IiLlnPsdEa]$/
    if (wr == "timeout") return x ~ /^(-s|-k|--signal|--kill-after)$/
    if (wr == "stdbuf") return x ~ /^-[ioe]$/
    if (wr == "ionice") return x ~ /^-[cnp]$/
    if (wr == "exec") return x == "-a"
    return 0
  }
  function gitcfg(v) { v = tolower(v); if (v ~ /hookspath/ || v ~ /^include/ || v ~ /^alias\./) out("B", "git -c " v) }
  function gitchk(k,   j, x, lx, sc, m, ch) {
    sc = ""
    for (j = k + 1; j <= nw; j++) {
      x = w[j]; lx = tolower(x)
      if (sc == "") {
        if (x == "-c" || lx == "--config-env") { gitcfg(w[j + 1]); j++; continue }
        if (x ~ /^-c./) { gitcfg(substr(x, 3)); continue }
        if (lx ~ /^--config-env=/) { gitcfg(substr(x, 14)); continue }
        if (lx ~ /^--(git-dir|exec-path)/) { out("B", "git " x); continue }
        if (x == "-C" || lx == "--namespace" || lx == "--work-tree" || lx == "--super-prefix") { j++; continue }
        if (x ~ /^-/) continue
        sc = lx; continue
      }
      if (lx ~ /^--no-v/) out("B", "git " sc " " x)
      if (sc == "commit") {
        if (x ~ /^(-m|-F|-C|-c|-t|--author|--date|--file|--message|--template|--reuse-message|--reedit-message|--fixup|--squash|--trailer|--cleanup|--pathspec-from-file)$/) { j++; continue }
        if (x ~ /^-[A-Za-z]/ && x !~ /^--/) {
          for (m = 2; m <= length(x); m++) { ch = substr(x, m, 1); if (ch ~ /[mFCct]/) break; if (ch == "n" || ch == "N") { out("B", "git commit " x); break } }
        }
      }
      if (sc == "config" && (lx ~ /^(core|include|includeif|alias)(\.|$)/ || lx ~ /hookspath/ || x == "-e" || lx == "--edit")) out("B", "git config " x)
    }
  }
  function script(j) {   # operand j of sh/bash/./source is the script path
    if (!L[j]) out("X", "the script path " w[j] " is not literal")
    else if (base(w[j]) == "agent.sh" && j + 1 <= nw) out("A", L[j + 1] "\t" w[j + 1])
  }
  function endcmd(   k, c, j, x, wr, tdone, nopt, tgt, hasc, hass, first, refm) {
    if (nw == 0) return
    for (j = 1; j <= nw; j++) {
      x = w[j]
      if (isassign(x)) {
        c = x; sub(/=.*/, "", c)
        out("C", "env\t" x)
        if (c == "AGENT_ROLE") out("R", substr(x, 12))
        if (c ~ /^GIT_CONFIG/ || c == "GIT_DIR" || c == "GIT_COMMON_DIR" || c == "GIT_EXEC_PATH") out("B", "setting " c " can disable or redirect the git hooks")
        continue
      }
      if (x !~ /AGENT_ROL/) continue
      c = x; gsub(/\$\{?AGENT_ROLE/, "", c); if (c !~ /AGENT_ROL/) continue
      if (x == "AGENT_ROLE" && (base(w[1]) == "export" || base(w[1]) == "unset")) continue
      out("X", "AGENT_ROLE is set or named indirectly (" x ")")
    }
    k = 1; wr = ""; tdone = 0
    while (k <= nw) {
      x = w[k]
      if (isassign(x)) { k++; continue }
      if (wr != "" && x ~ /^-/) {
        if (wr == "env" && x ~ /^(-[A-Za-z]*S|--split-string)/) out("X", "env -S runs a split string")
        if (takesval(wr, x)) k++
        k++; continue
      }
      if (wr == "timeout" && !tdone) { tdone = 1; k++; continue }
      if (base(x) ~ /^(sudo|doas|env|command|builtin|exec|nohup|time|nice|ionice|stdbuf|timeout|xargs|then|do|else|elif|if|while|until|!|\{|\})$/) { wr = base(x); tdone = 0; k++; continue }
      break
    }
    if (k > nw) { nw = 0; return }
    if (!L[k]) out("X", "the command word " w[k] " is not literal")
    c = base(w[k])
    ca = ""; for (j = k + 1; j <= nw; j++) ca = ca (j > k + 1 ? "\003" : "") w[j]
    out("C", c "\t" ca)
    # cd: later relative write targets in this command line resolve against it (heuristic, like the rest)
    if (c == "cd") {
      cdkey = qn SUBSEP k SUBSEP nw SUBSEP w[k + 1]
      if (cdkey != lastcd) {
        lastcd = cdkey
        if (k + 1 <= nw && L[k + 1] && w[k + 1] != "-") { d0 = w[k + 1]; cwdp = (substr(d0, 1, 1) == "/" || cwdp == "") ? d0 : cwdp "/" d0 } else cwdp = ""
      }
    }
    if (c == "eval") out("X", "eval runs an unparsed string")
    else if (c ~ /^(sh|bash|dash|zsh|ksh|ash|mksh|posh|yash)$/) {
      hasc = 0; hass = 0
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x ~ /^[-+]o$/) { j++; continue }
        if (x == "--") { j++; break }
        if (x ~ /^--/) continue
        if (x ~ /^[-+][A-Za-z]+$/) { if (x ~ /^-[A-Za-z]*c/) hasc = 1; if (x ~ /^-[A-Za-z]*s/) hass = 1; continue }
        break
      }
      if (hasc) { if (j <= nw) push(w[j], dep + 1) }
      else if (hass || j > nw) out("X", "a shell reading its commands from stdin")
      else script(j)
    }
    else if (c == "." || c == "source") { if (k + 1 <= nw) script(k + 1) }
    else if (c == "agent.sh") { if (k + 1 <= nw) out("A", L[k + 1] "\t" w[k + 1]) }
    else if (c == "claude") { for (j = k + 1; j <= nw; j++) if (w[j] == "-p" || w[j] == "--print") { out("N", "claude " w[j]); break } }
    else if (c == "codex") { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/) { if (w[j] == "exec" || w[j] == "e") out("N", "codex " w[j]); break } }
    else if (c == "git") gitchk(k)
    else if (c == "tee") { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/) out("W", w[j]) }
    else if (c ~ /^(touch|rm|truncate|unlink|rmdir|shred)$/) {
      for (j = k + 1; j <= nw; j++) {
        if (w[j] ~ /^-/) { if ((c == "truncate" && w[j] ~ /^-[sr]$/) || (c == "touch" && w[j] ~ /^-[tdr]$/)) j++; continue }
        out("W", w[j]); if (c ~ /^(rm|unlink)$/) out("E", w[j])
      }
    }
    else if (c ~ /^(chmod|chown|chgrp)$/) {
      first = 1; refm = 0
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x ~ /^--reference/) { refm = 1; continue }
        if (x ~ /^--/ || x ~ /^-[RfvchHLP]+$/) continue
        if (first && !refm) { first = 0; continue }   # mode / owner operand
        out("W", x)
      }
    }
    else if (c ~ /^(ed|ex|vi|vim|view|nvim)$/) {
      for (j = k + 1; j <= nw; j++) {
        if (w[j] ~ /^(-c|-S|-u|-U|-i|-w|-W|--cmd)$/) { j++; continue }
        if (w[j] !~ /^[-+]/ && w[j] != "") out("Q", w[j])
      }
    }
    else if (c ~ /^(patch|gpatch)$/) { out("P", "."); for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]) }
    else if (c ~ /^(ruby|awk|gawk|mawk)$/) {
      hasc = 0
      for (j = k + 1; j <= nw; j++) {
        if (c == "ruby" ? w[j] ~ /^-[0adlnpsSwWxXvuT]*i/ : (w[j] ~ /^-i?inplace/ || w[j] == "--include=inplace" || ((w[j] == "-i" || w[j] == "--include") && w[j + 1] ~ /^inplace/))) hasc = 1
      }
      if (hasc) { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]); if (nw > k + 1) out("W", w[nw]) }
    }
    else if (c == "sed" || c == "gsed" || c == "perl") {
      for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-[0adlnpsSwWxXvuTEe]*i/ || w[j] ~ /^--in-place/) { for (j = k + 1; j <= nw; j++) if (w[j] !~ /^-/ && w[j] != "") out("P", w[j]); break }
      if (c == "sed") for (j = k + 1; j <= nw; j++) { if (w[j] ~ /^-[A-Za-z]*i[A-Za-z-]+$/) { out("S", "sed " w[j]); break } if (j < nw && w[j] ~ /^-[A-Za-z]*i$/ && w[j + 1] ~ /^-[A-Za-z-]/) { out("S", "sed " w[j] " " w[j + 1]); break } } for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-[A-Za-z]*i/ || w[j] ~ /^--in-place/) { if (nw > k + 1) out("W", w[nw]); break } }
    else if (c ~ /^(cp|mv|install|ln|rsync)$/) {
      nopt = 0; tgt = ""
      for (j = k + 1; j <= nw; j++) {
        x = w[j]
        if (x == "-t" || x == "--target-directory") { tgt = w[++j]; continue }
        if (x ~ /^--target-directory=/) { tgt = substr(x, 20); continue }
        if (x ~ /^-/) { if ((c == "install" && x ~ /^-[mogS]$/) || (c == "rsync" && x ~ /^-[ef]$/)) j++; continue }
        op[++nopt] = x
        if (base(x) == "agent.sh") out("X", c " of agent.sh")
      }
      if (c == "ln") for (j = 1; j <= nopt; j++) out("L", op[j])
      if (c == "mv") for (j = 1; j < nopt + (tgt != ""); j++) out("W", op[j])
      if (tgt != "") out("W", tgt); else if (nopt >= 2) out("W", op[nopt]); else if (c == "ln" && nopt == 1) out("W", base(op[1]))
    }
    else if (c == "dd") { for (j = k + 1; j <= nw; j++) if (w[j] ~ /^of=/) out("W", substr(w[j], 4)) }
    nw = 0
  }
  function parse(s,   n, i, ch, q, e, line, k2) {
    n = length(s); i = 1; q = ""; cur = ""; have = 0; lit = 1; hd = ""; nw = 0; redir = 0; inredir = 0; dup = 0
    while (i <= n) {
      ch = substr(s, i, 1)
      if (q == "\047") { if (ch == "\047") q = ""; else cur = cur ch; i++; continue }
      if (q == "\"") {
        if (ch == "\\" && i < n) { cur = cur substr(s, i + 1, 1); i += 2; continue }
        if (ch == "\"") { q = ""; i++; continue }
        if (ch == "$" && substr(s, i + 1, 1) == "(") { e = mparen(s, i + 1); push(substr(s, i + 2, e - i - 2), dep + 1); cur = cur substr(s, i, e - i + 1); lit = 0; i = e + 1; continue }
        if (ch == "`") { e = index(substr(s, i + 1), "`"); if (!e) e = n - i + 1; push(substr(s, i + 1, e - 1), dep + 1); lit = 0; i += e + 1; continue }
        if (ch == "$") lit = 0
        cur = cur ch; i++; continue
      }
      if (ch == "\047" || ch == "\"") { q = ch; have = 1; i++; continue }
      if (ch == "\\" && i < n) { if (substr(s, i + 1, 1) != "\n") { cur = cur substr(s, i + 1, 1); have = 1 } i += 2; continue }
      if (ch == " " || ch == "\t") { endword(); i++; continue }
      if (ch == "\n") {
        endword(); endcmd(); i++
        if (hd != "") {   # skip the heredoc body up to its delimiter line
          while (i <= n) { e = index(substr(s, i), "\n"); line = (e ? substr(s, i, e - 1) : substr(s, i)); i = (e ? i + e : n + 1); sub(/^\t+/, "", line); if (line == hd) break }
          hd = ""
        }
        continue
      }
      if (ch == ";" || ch == "|" || ch == "(" || ch == ")" || ch == "`") { endword(); endcmd(); i++; continue }
      if (ch == "&") { if (substr(s, i + 1, 1) == ">") { endword(); i += 2; if (substr(s, i, 1) == ">") i++; redir = 1; continue } endword(); endcmd(); i++; continue }
      if (ch == ">") {
        if (have && cur ~ /^[0-9]+$/) { cur = ""; have = 0 } else endword()
        i++; if (substr(s, i, 1) == ">" || substr(s, i, 1) == "|") i++
        if (substr(s, i, 1) == "&") { i++; dup = 1; continue }
        if (substr(s, i, 1) == "(") continue
        redir = 1; continue
      }
      if (ch == "<") {
        if (have && cur ~ /^[0-9]+$/) { cur = ""; have = 0 } else endword()
        k2 = 0; while (substr(s, i, 1) == "<") { i++; k2++ }
        if (substr(s, i, 1) == "-") i++
        if (substr(s, i, 1) == "&") { i++; dup = 1; continue }
        if (substr(s, i, 1) == "(") continue
        inredir = (k2 == 2) ? 2 : 1; continue
      }
      if (ch == "$") lit = 0
      cur = cur ch; have = 1; i++
    }
    endword(); endcmd()
  }
  { qn = 1; qs[1] = $0; qd[1] = 0; for (qi = 1; qi <= qn; qi++) { dep = qd[qi]; parse(qs[qi]) } }'
}

# tmp_is_scratch_root: true when $TMPDIR itself is /tmp (then /tmp is the scratch space and nothing is denied).
tmp_is_scratch_root() {
  case "${TMPDIR:-}" in ''|/tmp|/tmp/*|/private/tmp|/private/tmp/*) return 0 ;; esac
  return 1
}
# stray_tmp_path TEXT: the first /tmp (or /private/tmp) path in TEXT that is not inside the project root.
stray_tmp_path() {
  printf '%s' "$1" | grep -Eo '(/private)?/tmp(/[^[:space:]"'"'"';|&)<>]*)?' > "$tmp/tmp-paths" || :
  while IFS= read -r sp_p; do
    sp_q=${sp_p#/private}
    sp_r=${root#/private}
    case "$sp_q" in "$sp_r"|"$sp_r"/*) continue ;; esac
    printf '%s\n' "$sp_p"; return 0
  done < "$tmp/tmp-paths"
  return 0
}

# --- database guard (A40, A50) -----------------------------------------------------------------
# Whenever proofline is installed (a run open or not: a task author or an explorer works before any run) no agent (lead included) reads, copies, queries or writes a database file, runs a SQL
# client against one, or runs a migration/seed command; destructive steps run in no environment before the
# user's approval. The only database an agent may meet is a test suite's own throwaway database: in memory or a
# scratch file under $TMPDIR/tmp outside the project. Paths, clients and migrate commands come from the config
# (`agent.sh db-config`, language-independent defaults). A heuristic like the rest: token and command-word
# matching on the command text; a script that opens a database by itself is caught after the fact by
# `agent.sh db-check` (size and mtime of every database file, compared at freeze and each handoff).
db_loaded=no
db_load() {
  [ "$db_loaded" = no ] || return 0
  db_loaded=yes
  sh "$agent" db-config all > "$tmp/dbconf" 2>/dev/null || : > "$tmp/dbconf"
  db_paths=$(sed -n 's/^paths=//p' "$tmp/dbconf" | head -n 1)
  db_clients=$(sed -n 's/^clients=//p' "$tmp/dbconf" | head -n 1)
  db_migrate=$(sed -n 's/^migrate_commands=//p' "$tmp/dbconf" | head -n 1)
  [ -n "$db_paths" ] || db_paths='*.db *.sqlite *.sqlite3 *.db3'
}
# scratch_path P: a throwaway location (the runtime's $TMPDIR or /tmp) outside the project root; a project that
# itself lives under /tmp is not scratch.
scratch_path() {
  sc_p=${1#/private}; sc_r=${root#/private}
  case "$sc_p" in "$sc_r"|"$sc_r"/*) return 1 ;; esac
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$sc_p" in /tmp/*|/var/folders/*|'$TMPDIR'/*|'${TMPDIR}'/*) return 0 ;; esac
  if [ -n "${TMPDIR:-}" ]; then sc_t=${TMPDIR%/}; sc_t=${sc_t#/private}; case "$sc_p" in "$sc_t"/*) return 0 ;; esac; fi
  return 1
}
# db_is_path TOKEN: does TOKEN name a database file (config database.paths)?
db_is_path() {
  for dp_g in $db_paths; do
    # shellcheck disable=SC2254 # config database.paths entries are glob patterns on purpose
    case "$dp_g" in
      */*) case "$1" in $dp_g|*/$dp_g) return 0 ;; esac ;;
      *)case "${1##*/}" in $dp_g) return 0 ;; esac ;;
    esac
  done
  return 1
}
# db_check_token TOKEN WHAT: deny unless TOKEN is no database file or a scratch one.
db_check_token() {
  db_is_path "$1" || return 0
  scratch_path "$1" && return 0
  deny "$2 names the database file '$1'. No agent reads, copies, queries or writes a database file while a run is open (a test suite's own throwaway database under \$TMPDIR is the only exception). Existing rows are evidence only through the project's seed files and the test suite; record what you could not check as an open point in EVIDENCE.md"
}
# db_guard_cmd: the command text ($1) and its scan records ($tmp/scan).
dg_dsql='(^|[^a-z_])(drop[[:space:]]+(table|column|index|view|schema|database|trigger)|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]|truncate[[:space:]]+(table[[:space:]]+)?[a-z_"`]|delete[[:space:]]+from[[:space:]])'
db_guard_cmd() {
  db_load
  set -f
  # Every word the command passes (command words, arguments, redirection targets; heredoc bodies are not
  # commands and are skipped), split at separators so --db=x.db, URLs and code strings are caught.
  while IFS= read -r dg_rec; do
    case "${dg_rec%%"$TAB"*}" in C|W) ;; *) continue ;; esac
    printf '%s\n' "${dg_rec#*"$TAB"}" | tr -s '[:space:]\003\002;|&()<>"`'"'"'=,:' '\n'
  done < "$tmp/scan" > "$tmp/dbtoks"
  while IFS= read -r dg_t; do
    [ -n "$dg_t" ] || continue
    db_check_token "$dg_t" "the command"
  done < "$tmp/dbtoks"
  while IFS= read -r dg_rec; do
    [ "${dg_rec%%"$TAB"*}" = C ] || continue
    dg_rest=${dg_rec#*"$TAB"}; dg_cw=${dg_rest%%"$TAB"*}
    dg_args=$(printf '%s' "${dg_rest#*"$TAB"}" | tr '\003' '\n')
    # Destructive SQL runs in no environment, a scratch or in-memory database included (A52): the argument of a
    # SQL client, inline code of a script interpreter, or a SQL file fed to either through `<`.
    dg_isql=no
    case " $db_clients " in *" $dg_cw "*) dg_isql=yes ;; esac
    case "$dg_cw" in node|nodejs|deno|bun|python|python3|ruby|php|perl) case " $(printf '%s' "$dg_args" | tr '\n' ' ') " in *" -e "*|*" -c "*|*" -p "*|*" --eval "*|*" -r "*) dg_isql=yes ;; esac ;; esac
    if [ "$dg_isql" = yes ] && printf '%s\n' "$dg_args" | grep -Eiq "$dg_dsql"; then
      deny "$dg_cw would run a destructive SQL statement (drop, alter ... drop, truncate, delete from). Destructive steps run in no environment, in-memory or scratch databases included; the project's tests exercise migrations, and the user's destructive approval gates the plan, not an agent's command"
    fi
    if [ "$dg_cw" = "<" ]; then
      dg_src=$(printf '%s' "$dg_args" | head -n 1)
      if [ -f "$dg_src" ] && grep -Eiq "$dg_dsql" "$dg_src" 2>/dev/null; then
        deny "the command feeds '$dg_src', which holds a destructive SQL statement, to a program. Destructive steps run in no environment, in-memory or scratch databases included"
      fi
    fi
    case " $db_clients " in *" $dg_cw "*)
      case "$dg_cw" in
        sqlite3|sqlite|duckdb|litecli)
          dg_first=''; dg_skip=0
          while IFS= read -r dg_a; do
            if [ "$dg_skip" = 1 ]; then dg_skip=0; continue; fi
            case "$dg_a" in -init|-cmd|-separator|-newline|-nullvalue|-vfs|-mmap|-A) dg_skip=1; continue ;; -*) continue ;; esac
            dg_first=$dg_a; break
          done <<DBARGS
$dg_args
DBARGS
          case "$dg_first" in
            ''|:memory:|file::memory:*) ;;
            *) scratch_path "$dg_first" || deny "$dg_cw would open '$dg_first'. A SQL client runs only against :memory: or a scratch file under \$TMPDIR outside the project (a test suite's own throwaway database); never against a project or environment database" ;;
          esac ;;
        *) deny "$dg_cw is a database client; no agent connects to a database while a run is open (a test suite builds its own throwaway database)" ;;
      esac ;;
    esac
    dg_joined="$dg_cw $(printf '%s' "$dg_args" | tr '\n' ' ')"
    dg_res=$(printf '%s' "$db_migrate" | tr ',' '\n')
    while IFS= read -r dg_re; do
      dg_re=$(printf '%s' "$dg_re" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      [ -n "$dg_re" ] || continue
      if printf '%s\n' "$dg_joined" | grep -Eq -- "$dg_re"; then
        deny "'$dg_cw' runs a migration, seed or schema command (matches database.migrate_commands). No agent runs one in any environment: the project's test command exercises migrations on the suite's own throwaway database, and applying a destructive step is the user's decision after the destructive approval"
      fi
    done <<DBRES
$dg_res
DBRES
  done < "$tmp/scan"
  set +f
}

# scratch_guard: scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/);
# $TMPDIR is only for git worktrees (D10, A56). A write whose target is under $TMPDIR or /tmp and not inside a
# registered worktree is refused, and so is `mktemp` without a template outside them. Heuristic, like the rest.
scratch_guard() {
  sg_t=${TMPDIR:-}; sg_t=${sg_t%/}
  [ -n "$sg_t" ] || sg_t=/tmp
  sg_wts=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  while IFS= read -r sg_rec; do
    sg_k=${sg_rec%%"$TAB"*}; sg_v=$(printf '%s' "${sg_rec#*"$TAB"}" | tr '\002' '\n')
    case "$sg_k" in
      W)
        # shellcheck disable=SC2016 # literal $TMPDIR and $HOME in the command text
        case "$sg_v" in '$TMPDIR'/*|'${TMPDIR}'/*) sg_v=$sg_t/${sg_v#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) sg_v=${HOME:-/nonexistent-home}/${sg_v#*/} ;; esac
        case "$sg_v" in /dev/*) continue ;; /*) ;; *) continue ;; esac
        sg_n=$(printf '%s' "${sg_v#/private}" | sed 's|//*|/|g')
        # Inside the project: the path policy decides. Inside a registered worktree: allowed. Anywhere else
        # (/tmp, $TMPDIR, $HOME, any absolute path) a shell write is refused: a run leaves nothing outside the copy (C-18).
        case "$sg_n" in "${root#/private}"|"${root#/private}"/*) continue ;; esac
        sg_in=no
        for sg_w in $sg_wts; do
          [ "${sg_w#/private}" != "${root#/private}" ] || continue
          case "$sg_n" in "${sg_w#/private}"/*) sg_in=yes ;; esac
        done
        [ "$sg_in" = yes ] || deny "the command writes '$sg_v', outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); \$TMPDIR is only for git worktrees. Create the folder there and write inside it" ;;
      C)
        sg_rest=${sg_rec#*"$TAB"}; sg_cw=${sg_rest%%"$TAB"*}
        if [ "$sg_cw" = mktemp ]; then
          sg_a=$(printf '%s' "${sg_rest#*"$TAB"}" | tr '\003' ' ')
          case "$sg_a" in
            *scratch/*) ;;
            *) deny "mktemp would create its file or folder under \$TMPDIR. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); \$TMPDIR is only for git worktrees: mkdir there and name the path" ;;
          esac
        fi ;;
    esac
  done < "$tmp/scan"
}
# lead_tmp_check: the lead (and any session without a run, the intake roles included) keeps scratch files out of
# /tmp too (A52). Runs after the specific checks so their reasons win.
lead_tmp_check() {
  tmp_is_scratch_root && return 0
  lt_p=$(stray_tmp_path "$cmd")
  [ -z "$lt_p" ] || deny "$lt_p is outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under \$TMPDIR (${TMPDIR:-unset})"
}

# A143: what a read role's `find -delete|-exec ...` and `xargs ...` must not run outside an evidence worktree (text is
# space-joined first). Writers: the direct forms (rm, mv, cp, tee, ..., sed/perl/ruby -i, awk -i inplace, tree-changing git).
RO_W='rm|mv|cp|tee|truncate|ed|ex|patch|install|dd|chmod|chown|ln|shred|unlink|rmdir|touch'
RO_G='reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|stash|rm|mv|pull'
RO_I='(sed|gsed|perl|ruby)( +[^ ]+)* +(-[A-Za-z0-9]*i[^ ]*|--in-place)( |$)'
RO_FIND_WRITER="(^| )-delete( |\$)|(^| )-(exec|execdir|ok|okdir) +(/[^ ]*/)?(($RO_W)( |\$)|$RO_I|(awk|gawk)( .*)?inplace|git +(-C +[^ ]+ +)?($RO_G)( |\$))"
RO_XARGS_WRITER="xargs[^;&|]* (/[^ ]*/)?(($RO_W)( |\$)|$RO_I|git +(-C +[^ ]+ +)?($RO_G)( |\$))"
# ro_in_wt DIR: is DIR inside a registered worktree other than the project? (uses $sh_wts of stash_guard)
ro_in_wt() {
  [ -n "$1" ] || return 1
  while IFS= read -r ri_w; do
    [ -n "$ri_w" ] || continue
    [ "${ri_w#/private}" != "${root#/private}" ] || continue
    case "${1#/private}/" in "${ri_w#/private}"/*) return 0 ;; esac
  done <<EOF
$sh_wts
EOF
  return 1
}
# stash_path P BASE: P resolved against BASE (physical when it exists; leading $TMPDIR and $HOME expanded).
# Prints nothing when the path cannot be resolved from the text (another variable, command substitution, `-`,
# an unknown base, `..` through a path that does not exist): the caller then treats it as the project (A111).
stash_path() {
  sp_p=$1
  # shellcheck disable=SC2016 # literal $TMPDIR in the command text
  case "$sp_p" in '$TMPDIR'/*|'${TMPDIR}'/*) sp_p=${TMPDIR:-/tmp}/${sp_p#*/} ;; '~'/*|'$HOME'/*|'${HOME}'/*) sp_p=${HOME:-/nonexistent}/${sp_p#*/} ;; esac
  case "$sp_p" in ''|-|'~'*|*'$'*|*'`'*|*'*'*|*'?'*) return 0 ;; /*) ;; *) [ -n "${2:-}" ] || return 0; sp_p=$2/$sp_p ;; esac
  # a directory that does not exist now is unresolved (a failed cd leaves the shell in the project; a link may be made later)
  [ -d "$sp_p" ] || return 0
  (CDPATH='' cd -P "$sp_p" 2>/dev/null && pwd -P)
}
# stash_guard: a specialist runs no `git stash` subcommand (list and show included) against the project's
# working tree (A71, A111); a registered evidence worktree is free. The target directory is the hook cwd moved by
# `cd` and `git -C` / --work-tree in the scanned commands, and it is the PROJECT whenever the text cannot say
# (unexpanded variable, substitution, `cd -`, pushd/popd, `env -C`, a `cd` inside a subshell, pipe or background
# job before the stash). The cost of a wrong denial is one retry with a literal path. Reads $tmp/scan.
stash_guard() {
  sh_wts=$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  sh_cd=$cwd; sh_sep=$(printf '\003'); sh_cdseen=no; sh_ok=0; sh_rok=0; sh_force=no
  # shellcheck disable=SC2016 # literal $TMPDIR in the message
  sh_msg='git stash (every subcommand, list and show included) must not run in the project working tree from a specialist (A71). Use an evidence worktree: create it in its own call (git worktree add "$TMPDIR/<name>" HEAD), then run git -C "$TMPDIR/<name>" stash ... in a separate call with a literal path that exists (a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe, or a git stash behind a wrapper is read as the project)'
  sh_pre=${cmd%stash*}
  sh_nl=$(printf '%s' "$sh_pre" | sed -e 's/&&//g' -e 's/[0-9]*>&[0-9-]*//g' -e 's/&>//g')
  sh_nonlin=no
  case "$sh_nl" in *'('*|*'|'*|*'&'*|*'{'*|*'`'*) sh_nonlin=yes ;; esac
  if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_.-])(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir|--chdir=)'; then sh_cd=''; fi
  while IFS= read -r sh_rec; do
    case "$sh_rec" in C"$TAB"*) ;; *) continue ;; esac
    sh_rest=${sh_rec#*"$TAB"}; sh_cw=${sh_rest%%"$TAB"*}
    case "$sh_rest" in *"$TAB"*) sh_args=${sh_rest#*"$TAB"} ;; *) sh_args='' ;; esac
    case "$sh_cw" in
      cd)
        sh_cdseen=yes
        sh_ifs=$IFS; IFS=$sh_sep; set -f
        # shellcheck disable=SC2086 # split on \003 on purpose
        set -- $sh_args
        IFS=$sh_ifs; set +f
        while [ $# -gt 0 ]; do case "$1" in -P|-L|-e|-@|--) shift ;; *) break ;; esac; done
        if [ $# -eq 0 ]; then sh_cd=''; else sh_cd=$(stash_path "$1" "$sh_cd"); fi ;;
      pushd|popd) sh_cdseen=yes; sh_cd='' ;;
      find)
        # a read role's `find -delete` or `find -exec <writer>` starts in an evidence worktree or is refused (A143)
        [ "$ro" = yes ] || continue
        sh_fa=$(printf '%s' "$sh_args" | tr '\003' ' ')
        printf '%s\n' "$sh_fa" | grep -Eq "$RO_FIND_WRITER" || continue
        sh_fd=$sh_cd; sh_f1=${sh_args%%"$sh_sep"*}
        case "$sh_f1" in -*|'('|'!'|'') ;; *) sh_fd=$(stash_path "$sh_f1" "$sh_cd") ;; esac
        ro_in_wt "$sh_fd" || deny "find with -delete or -exec of a command that writes starts outside an evidence worktree (or its start directory cannot be read from the command text)$(ro_tail)" ;;
      env) case "$sh_args" in GIT_WORK_TREE=*|GIT_DIR=*) sh_cd=''; sh_force=yes ;; esac ;;
      git)
        sh_dir=$sh_cd
        if [ "$sh_cdseen" = yes ] && [ "$sh_nonlin" = yes ]; then sh_dir=''; fi
        sh_ifs=$IFS; IFS=$sh_sep; set -f
        # shellcheck disable=SC2086 # split on \003 on purpose
        set -- $sh_args
        IFS=$sh_ifs; set +f
        sh_hit=no; sh_wtopt=$sh_force; sh_sub=stash
        while [ $# -gt 0 ]; do
          case "$1" in
            -C) [ $# -ge 2 ] || break; shift; sh_dir=$(stash_path "$1" "$sh_dir") ;;
            --work-tree) [ $# -ge 2 ] || break; shift; sh_wtopt=yes ;;
            --work-tree=*) sh_wtopt=yes ;;
            -c) [ $# -ge 2 ] || break; shift; case "$1" in [Cc][Oo][Rr][Ee].[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee]=*) sh_wtopt=yes ;; esac ;;
            --namespace|--config-env|--super-prefix|--git-dir|--exec-path|--attr-source|--list-cmds|--exec) [ $# -ge 2 ] || break; shift ;;
            -*) ;;
            stash) sh_hit=yes; sh_sub=stash; break ;;
            reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|rm|mv|pull)
              # a read role changes no file of the project tree with git either (A143)
              if [ "$ro" = yes ]; then sh_hit=yes; sh_sub=$1; break; fi
              break ;;
            *)
              # a first word that is not a plausible subcommand name (a value of an option this list does not know)
              # followed by the word stash is read as a stash
              case "$1" in *[!a-z-]*) shift; for sh_a in "$@"; do [ "$sh_a" != stash ] || sh_hit=yes; done ;; esac
              break ;;
          esac
          [ $# -eq 0 ] || shift
        done
        [ "$sh_hit" = yes ] || continue
        # --work-tree, core.worktree and GIT_WORK_TREE move the target away from what -C or cd says: the project
        [ "$sh_wtopt" = no ] || sh_dir=''
        sh_in=no
        if [ -n "$sh_dir" ]; then
          while IFS= read -r sh_w; do
            [ -n "$sh_w" ] || continue
            [ "${sh_w#/private}" != "${root#/private}" ] || continue
            case "${sh_dir#/private}/" in "${sh_w#/private}"/*) sh_in=yes ;; esac
          done <<EOF
$sh_wts
EOF
        fi
        if [ "$sh_in" != yes ]; then
          [ "$sh_sub" = stash ] && deny "$sh_msg$(ro_tail)"
          deny "git $sh_sub changes the project working tree; its directory is not a registered evidence worktree (or cannot be read from the command text: a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe)$(ro_tail)"
        fi
        if [ "$sh_sub" = stash ]; then sh_ok=$((sh_ok + 1)); else sh_rok=$((sh_rok + 1)); fi ;;
    esac
  done < "$tmp/scan"
  # `xargs <writer>` takes its files from stdin, so the directory the command ends in must be an evidence worktree.
  if [ "$ro" = yes ] && printf '%s' "$cmd" | tr '\n\t' '  ' | grep -Eq "$RO_XARGS_WRITER"; then
    ro_in_wt "$sh_cd" || deny "xargs of a command that writes runs outside an evidence worktree (or the directory cannot be read from the command text)$(ro_tail)"
  fi
  # Safety net on the text: every `git ... stash` in command position that the records above did not resolve to
  # an evidence worktree is refused (unquoted substitutions, wrappers such as find -exec, watch, ssh, su -c, a
  # variable or substitution where the subcommand goes). Words that merely print or search (echo, grep) are skipped.
  sh_n=$(printf '%s' "$cmd" | stash_net_count)
  [ "${sh_n:-0}" -le "$sh_ok" ] || deny "$sh_msg$(ro_tail)"
  # The same net for a read role's other tree-changing subcommands (wrappers such as find -exec hide them from the records).
  if [ "$ro" = yes ]; then
    sh_rn=$(printf '%s' "$cmd" | grep -Eo '(^|[^[:alnum:]_.-])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|rm|mv|pull)([[:space:]]|$)' | wc -l | tr -d ' ')
    [ "${sh_rn:-0}" -le "$sh_rok" ] || deny "git changes the project working tree, or a wrapper hides which directory it runs in; use git -C <evidence worktree> or cd there with a literal path$(ro_tail)"
  fi
}
# stash_net_count: stdin is the command text; prints how many `git [options] stash` (or a `$`/backtick where the
# subcommand goes) sit in command position, not after a printing or searching word.
stash_net_count() {
  awk 'BEGIN { RS = "\001" }
  {
    q = "\047"
    val = "(\"[^\"]*\"|" q "[^" q "]*" q "|\\$\\([^)]*\\)|`[^`]*`|[^ \t;&|\"" q "`]+)"
    opt = "(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)[ \t]+" val
    re = "(^|[^A-Za-z0-9_.-])git([ \t]+(" opt "|-[^ \t;&|]+))*[ \t]+(stash([ \t;&|)$`{}]|$)|[$`])"
    n = 0; s = $0; off = 0
    while (match(s, re)) {
      st = RSTART; ln = RLENGTH
      gs = st; if (substr(s, st, 1) != "g") gs = st + 1
      before = substr($0, 1, off + gs - 1)
      k = 0
      for (i = length(before); i >= 1; i--) { c = substr(before, i, 1); if (c == ";" || c == "&" || c == "|" || c == "(" || c == "{" || c == "\n" || c == "`") { k = i; break } }
      t = substr(before, k + 1)
      while (match(t, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) t = substr(t, RLENGTH + 1)
      sub(/^[ \t]+/, "", t); split(t, wd, /[ \t]+/)
      # `git -C $W status`: the `$` the pattern stopped at is the VALUE of a value-taking option, not a subcommand
      # (a real `git -C $W stash` matches longer, through the option alternative, and is counted)
      m = substr(s, st, ln)
      # Skipped only when the option itself is not a value (`git -c -c $S`, `git -C -C $S`) and what follows the
      # value is whitespace and a bare literal word (status, apply, worktree): a quote, `$`, backtick, `-` or the
      # end after it keeps the count (`git -C $W "$S" list`, `git -C $W -C $S`).
      skip = 0
      vopt = "^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)$"
      if (m ~ /(^|[ \t])(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|--attr-source|--list-cmds|--exec)[ \t]+[$`]$/) {
        nt = split(m, mt, /[ \t]+/)
        if (nt < 3 || mt[nt - 2] !~ vopt) {
          rest = substr(s, st + ln); lc = substr(m, length(m), 1)
          if (lc == "`") { if (match(rest, /`/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else if (substr(rest, 1, 1) == "(") { if (match(rest, /\)/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else if (substr(rest, 1, 1) == "{") { if (match(rest, /\}/)) rest = substr(rest, RSTART + 1); else rest = "" }
          else { match(rest, "^[^ \t;&|\"" q "`]*"); rest = substr(rest, RLENGTH + 1) }
          if (rest ~ /^[ \t]+[A-Za-z][A-Za-z0-9_-]*([ \t;&|)\n]|$)/) skip = 1
        }
      }
      if (!skip && !(wd[1] ~ /^(echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|less|more|man|sed|awk|head|tail|wc|tr|cut|sort|uniq|jq|diff|ls|test|type|which|true)$/)) n++
      off += st + ln - 1; s = substr($0, off + 1)
    }
    print n
  }'
}

# --- merge guard (A136) --------------------------------------------------------------------------
# Merging is possible only through `proofline merge <PR>` (bin/lib/merge.sh), which merges a pull request only when
# a fresh check shows every check green on its current head. Every other merge path is denied for every caller,
# a run open or not, proofline installed in the project or not: gh pr merge (any flags, --admin and --auto
# included), gh api calls to a merge endpoint / GraphQL merge mutation / protected-ref update, gh alias, git push
# to a protected branch (or a bare push while one is checked out), git merge on one. Token matching on the scan's
# command records, like the rest: a script that merges by itself is not seen (see A136, known limits).
MG_MSG='merging a pull request goes only through `proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]`, which checks that every check is green on the current head and then merges (A136); --admin and --auto are never allowed'
mg_prot=''
mg_isprot() { case " $mg_prot " in *" $1 "*) return 0 ;; esac; return 1; }
mg_load() {
  [ -z "$mg_prot" ] || return 0
  mg_cb=''; [ "$installed" = no ] || mg_cb=$(sh "$agent" config-get canonical_branch 2>/dev/null) || mg_cb=''
  mg_oh=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^[^/]*/||') || mg_oh=''
  mg_prot="main master $mg_cb $mg_oh"
}
# mg_ref REF: is REF (one side of a refspec) a protected branch? A variable or substitution cannot be read: protected.
mg_ref() {
  mr=${1#+}; mr=${mr#refs/heads/}
  case "$mr" in *'$'*|*'`'*) return 0 ;; esac
  mg_isprot "$mr"
}
# mg_git ARGS: the arguments of one git command, one per line. State from merge_guard: mg_cd (directory after
# `cd`), mg_envu (an env/sudo -C, GIT_DIR, GIT_WORK_TREE made the directory unreadable).
mg_git() {
  mg_ifs=$IFS; IFS='
'; set -f
  # shellcheck disable=SC2086 # split on newlines on purpose
  set -- $1
  IFS=$mg_ifs; set +f
  mg_dir=$mg_cd; [ "$mg_envu" = no ] || mg_dir=@unknown
  mg_sub=''
  while [ $# -gt 0 ]; do
    case "$1" in
      -C) [ $# -ge 2 ] || break; if [ "$mg_dir" != @unknown ]; then mg_dir=$(stash_path "$2" "$mg_dir"); [ -n "$mg_dir" ] || mg_dir=@unknown; fi; shift ;;
      --git-dir=*|--work-tree=*) mg_dir=@unknown ;;
      --git-dir|--work-tree) mg_dir=@unknown; shift ;;
      -c|--namespace|--config-env|--exec-path|--super-prefix|--attr-source) shift ;;
      -*) ;;
      *) mg_sub=$1; shift; break ;;
    esac
    shift
  done
  mg_cur=''
  [ "$mg_dir" = @unknown ] || mg_cur=$(git -C "$mg_dir" symbolic-ref -q --short HEAD 2>/dev/null) || mg_cur=''
  case "$mg_sub" in
    push)
      # A real -n / --dry-run pushes nothing; the value of -o / --push-option / --receive-pack / --exec / --repo is not a flag.
      mg_skip=no
      for mg_a in "$@"; do
        if [ "$mg_skip" = yes ]; then mg_skip=no; continue; fi
        case "$mg_a" in -n|--dry-run) return 0 ;; -o|--push-option|--receive-pack|--exec|--repo) mg_skip=yes ;; esac
      done
      mg_np=0; mg_head=no; mg_skip=no
      for mg_a in "$@"; do
        if [ "$mg_skip" = yes ]; then mg_skip=no; continue; fi
        case "$mg_a" in
          --all|--mirror) deny "git push $mg_a would push the protected branch: $MG_MSG" ;;
          --repo) mg_np=1; mg_skip=yes; continue ;;
          --repo=*) mg_np=1; continue ;;
          -o|--push-option|--receive-pack|--exec) mg_skip=yes; continue ;;
          -*) continue ;;
        esac
        mg_np=$((mg_np + 1))
        [ "$mg_np" -ge 2 ] || continue
        case "$mg_a" in
          *:*) ! mg_ref "${mg_a#*:}" || deny "git push to the protected branch ($mg_a): $MG_MSG" ;;
          HEAD|@) mg_head=yes ;;
          *) ! mg_ref "$mg_a" || deny "git push of the protected branch ($mg_a): $MG_MSG" ;;
        esac
      done
      # no refspec, or HEAD: the pushed branch is the checked-out one
      if [ "$mg_np" -lt 2 ] || [ "$mg_head" = yes ]; then
        [ "$mg_dir" != @unknown ] || deny "git push whose directory cannot be read from the command text (cd -, a variable, GIT_DIR, env -C, a cd in a subshell or pipe) pushes an unknown branch: $MG_MSG"
        ! mg_isprot "$mg_cur" || deny "git push while the protected branch $mg_cur is checked out: $MG_MSG"
      fi ;;
    merge)
      for mg_a in "$@"; do case "$mg_a" in --abort|--quit|--continue) return 0 ;; esac; done
      [ "$mg_dir" != @unknown ] || deny "git merge whose directory cannot be read from the command text may merge into a protected branch: $MG_MSG"
      ! mg_isprot "$mg_cur" || deny "git merge on the protected branch $mg_cur: $MG_MSG"
      mg_alt=$(printf '%s' "$mg_prot" | tr -s ' ' '|' | sed 's/^|//; s/|$//')
      ! printf '%s' "$cmd" | grep -Eq "(checkout|switch)[[:space:]]+([^;&|]*[[:space:]])?($mg_alt)([[:space:]]|;|&|\\||\$)" \
        || deny "git merge in a command that switches to a protected branch: $MG_MSG" ;;
    update-ref)
      for mg_a in "$@"; do case "$mg_a" in refs/heads/*) ! mg_ref "$mg_a" || deny "git update-ref of a protected branch: $MG_MSG" ;; esac; done ;;
  esac
  return 0
}
# mg_api ARGS: a `gh api` call (arguments one per line).
mg_api() {
  mg_aw=no; mg_atxt=$(printf '%s' "$1" | tr '\n' ' ')
  ! printf '%s\n' "$1" | grep -Eq '^(-X|--method|-f|-F|--field|--raw-field|--input)(=.*)?$|^-X.' || mg_aw=yes
  printf '%s\n' "$1" | grep -Eiq '^--input|=@|mutation|/pulls/[^/[:space:]]*/merge|/merges?([[:space:]?#]|$)|mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|auto_merge|git/refs/heads/(main|master)' \
    && deny "gh api call with a merge endpoint, a GraphQL mutation, --input or a field read from a file (=@) is denied: $MG_MSG"
  [ "$mg_aw" = no ] || {
    printf '%s' "$mg_atxt" | grep -Eiq '/contents/' && deny "gh api write to repository contents (default branch included) is denied: $MG_MSG"
    printf '%s' "$mg_atxt" | grep -Eiq '/git/(refs|commits|trees)' && printf '%s' "$mg_atxt" | grep -Eiq 'main|master|[$`]' \
      && deny "gh api write to git refs of a protected branch (or to a ref built from a variable) is denied: $MG_MSG"
  }
  return 0
}
merge_guard() {
  mg_load
  mg_flat=$(printf '%s' "$cmd" | tr '\n' ' ')
  case "$cmd" in *PROOFLINE_SELFTEST*) deny "PROOFLINE_SELFTEST is a self-test switch (it lifts the wrapper's PATH-shadowing rule); a model command never names it: $MG_MSG" ;; esac
  # (a) a variable, substitution or backtick where the gh subcommand goes
  printf '%s' "$mg_flat" | grep -Eq '(^|[^[:alnum:]_./-])gh([[:space:]]+(-R|--repo)[[:space:]]+[^[:space:]]+)?([[:space:]]+[A-Za-z][A-Za-z-]*)?[[:space:]]+["'"'"']?[$`]' \
    && deny "a variable or substitution where the gh subcommand goes cannot be checked (gh pr \$m, gh \$SUB ...); write the subcommand literally: $MG_MSG"
  # (d) merge text piped, heredoc'd or passed to a shell / interpreter / eval / git alias
  mg_pay='(^|[^[:alnum:]_])pr["'"'"'[:space:]]+merge([^[:alnum:]_]|$)|/pulls/[^[:space:]]*merge|mergePullRequest|enablePullRequestAutoMerge|git[[:space:]]+([^;&|]*[[:space:]])?push[^;&|]*[[:space:]:/+](main|master)([^[:alnum:]_.-]|$)|git[[:space:]]+merge'
  mg_sink='\|[[:space:]]*((env|sudo|command|exec)[[:space:]]+)*(/[^[:space:]|;&]*/)?(sh|bash|zsh|dash|ksh|ash)([[:space:]]|;|&|\)|$)|(^|[^[:alnum:]_.-])(sh|bash|zsh|dash|ksh)([[:space:]]+-[A-Za-z]+)*[[:space:]]*<<|(sh|bash|zsh|dash|ksh)[[:space:]]+(-[A-Za-z]+[[:space:]]+)*-s([[:space:]]|$)|(^|[^[:alnum:]_.-])(python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua)[[:space:]]+(-[A-Za-z]*[ceErp]|--eval)([[:space:]]|$)|awk[^|;&]*system[[:space:]]*\(|(^|[;&|({[:space:]])eval[[:space:]]|alias\.[A-Za-z0-9_-]+=["'"'"']?!'
  if printf '%s' "$mg_flat" | grep -Eq "$mg_sink" && printf '%s' "$mg_flat" | grep -Eq "$mg_pay"; then
    deny "merge text passed to a shell, an interpreter, eval or a git alias cannot be checked: $MG_MSG"
  fi
  mg_cd=$cwd; mg_envu=no
  # env/sudo -C, --chdir move the directory away from what the text says
  ! printf '%s' "$mg_flat" | grep -Eq '(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir)' || mg_envu=yes
  mg_nl=$(printf '%s' "$cmd" | sed -e 's/&&//g' -e 's/[0-9]*>&[0-9-]*//g' -e 's/&>//g')
  mg_nonlin=no; case "$mg_nl" in *'('*|*'|'*|*'&'*|*'{'*|*'`'*) mg_nonlin=yes ;; esac
  while IFS= read -r mg_rec; do
    case "$mg_rec" in C"$TAB"*) ;; *) continue ;; esac
    mg_rest=${mg_rec#*"$TAB"}; mg_cw=${mg_rest%%"$TAB"*}
    case "$mg_rest" in *"$TAB"*) mg_args=$(printf '%s' "${mg_rest#*"$TAB"}" | tr '\003\002' '\n\n') ;; *) mg_args='' ;; esac
    case "$mg_cw" in
      cd)
        mg_first=$(printf '%s\n' "$mg_args" | grep -v '^-' | head -n 1)
        if [ -z "$mg_first" ] || [ "$mg_cd" = @unknown ]; then mg_cd=@unknown; else mg_cd=$(stash_path "$mg_first" "$mg_cd"); [ -n "$mg_cd" ] || mg_cd=@unknown; fi
        if [ "$mg_nonlin" = yes ]; then mg_cd=@unknown; fi
        continue ;;
      pushd|popd) mg_cd=@unknown; continue ;;
      env|export)
        ! printf '%s\n' "$mg_args" | grep -Eq '^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=' || mg_envu=yes
        if printf '%s\n' "$mg_args" | grep -q '^PATH=' && printf '%s' "$mg_flat" | grep -Eq 'merge|proofline|(^|[^[:alnum:]_.-])gh([^[:alnum:]_]|$)'; then
          deny "setting PATH in a command that runs gh or proofline merge could substitute a fake gh: $MG_MSG"
        fi
        continue ;;
      curl|wget|http|https|xh|xhs|aria2c)
        # (b) an HTTP client aimed at GitHub's merge / refs / contents / graphql endpoints
        if printf '%s\n' "$mg_args" | grep -Eiq 'github' && printf '%s\n' "$mg_args" | grep -Eiq '/pulls/[^[:space:]]*/merge|/merges|git/refs|/contents/|graphql|mergePull|auto_merge'; then
          deny "$mg_cw aimed at a GitHub merge, refs, contents or graphql endpoint is denied: $MG_MSG"
        fi
        continue ;;
      echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|less|more|man|sed|awk|head|tail|wc|tr|cut|sort|uniq|jq|diff|ls|test|type|which|true|agent.sh|proofline|'<') continue ;;
    esac
    if [ "$mg_cw" = git ]; then mg_git "$mg_args"; continue; fi
    # every other command word (gh itself, ssh, xargs, a variable): the words pr merge, api, alias
    mg_pr=no mg_mg=no mg_ap=no mg_al=no
    while IFS= read -r mg_t; do
      case "$mg_t" in pr) mg_pr=yes ;; merge) mg_mg=yes ;; api) mg_ap=yes ;; alias) mg_al=yes ;; esac
    done <<MGARGS
$mg_args
MGARGS
    [ "$mg_pr$mg_mg" != yesyes ] || deny "$mg_cw pr merge is denied: $MG_MSG"
    [ "$mg_cw$mg_al" != gh''yes ] || deny "gh alias could hide a merge command: $MG_MSG"
    [ "$mg_ap" = no ] || mg_api "$mg_args"
  done < "$tmp/scan"
}

# --- events -----------------------------------------------------------------------------------
[ "$ev" = pretool ] || [ "$installed" = yes ] || exit 0
case "$ev" in
pretool)
  if [ "$parsed" = no ]; then
    [ -z "$act" ] || deny "hook input could not be parsed (jq or node is required) while run $act is active; failing closed"
    exit 0
  fi
  [ "$act" != INVALID ] || deny ".agents/local/ACTIVE_RUN is malformed; fix it with agent.sh before editing"
  baseline
  tool=$(jget tool_name)
  cmd=''
  case "$tool" in Bash|shell|local_shell|exec_command|unified_exec) cmd=$(jget tool_input.command tool_input.cmd) ;; esac
  TAB=$(printf '\t')
  if [ "$installed" = no ]; then   # installed projects run merge_guard below, after the older rules, so their reasons win
    [ -z "$cmd" ] || { printf '%s\n' "$cmd" | scan_cmd > "$tmp/scan"; merge_guard; }
    exit 0
  fi
  if [ -n "$cmd" ]; then
    # A102: the capability probes' self-test switches are never set by a model (they would hide a browser or benchmark).
    case "$cmd" in *PROOFLINE_PROBE_ROOT*|*PROOFLINE_SELFTEST*) deny "PROOFLINE_PROBE_ROOT and PROOFLINE_SELFTEST are self-test switches of the capability probes (A102); a model command never sets or names them" ;; esac
    # A specialist never mutates the live tree with git (stash, reset, checkout --, restore, clean, ...):
    # mutation evidence runs in a separate worktree (`git worktree add`, then `git -C <worktree> ...`).
    # (A read role is checked precisely by stash_guard below: effective directory, `git -C`, `cd`.)
    if [ -n "$act" ] && [ "$ro" = no ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } \
       && printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])git[[:space:]]+(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout[[:space:]]+--)([[:space:]]|$)' \
       && ! printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+-C[[:space:]]|git[[:space:]]+worktree|--work-tree'; then
      deny "git must not change the live working tree from a specialist (stash, reset, clean, restore, checkout --, switch, ...); run mutation evidence in a separate worktree (git worktree add, then git -C <worktree> ...) and leave the tree as you found it$(ro_tail)"
    fi
    # Scratch space is $TMPDIR (the runtime's private temp dir), never /tmp directly: files outside the project
    # and $TMPDIR are what a run must not leave behind. A project that itself lives under /tmp is not scratch.
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } && ! tmp_is_scratch_root; then
      stray=$(stray_tmp_path "$cmd")
      [ -z "$stray" ] || deny "$stray is outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under \$TMPDIR (${TMPDIR:-unset})"
    fi
    printf '%s\n' "$cmd" | scan_cmd > "$tmp/scan"
    # A111: every `git stash` subcommand is refused in the project tree for a specialist (evidence worktrees are free).
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; }; then stash_guard; fi
    # Hook and gate bypasses: never, for anyone, while proofline is installed.
    while IFS= read -r rec; do
      k=${rec%%"$TAB"*}; v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
      case "$k" in
        S) deny "$v: on BSD/macOS sed the text glued to -i or the word after it is the backup suffix, so it leaves a stray file named like the target plus that token (QA_PLAN.md-E) that blocks handoff. Write the file with the Write/Edit tool, or sed -E ... file > scratch && mv scratch file, or perl -pi -e ... (sed -i '' is BSD-only, bare sed -i GNU-only)" ;;
        B) deny "git hook bypass is never allowed ($v); the git hooks enforce identity, gates and approvals" ;;
        A) case "${v#*"$TAB"}" in approve|approve-pending) deny "no model runs agent.sh ${v#*"$TAB"}: an approval is the user's. The runtime records it from the user's reply (the prompt hook) and agent.sh refuses it without that reply; wait for the user's answer, then run agent.sh next" ;; esac ;;
        W) ! always_protected "$(relpath "$v")" || deny "the command writes '$v', which wires the git hooks; it is never changed by an agent (git hook bypass)" ;;
      esac
    done < "$tmp/scan"
    # The merge guard is not run-scoped either (A136).
    merge_guard
    # The database guard is not run-scoped: a task author or an explorer runs before any run exists (A50).
    db_guard_cmd "$cmd"
    [ -n "$act" ] || { scratch_guard; lead_tmp_check; exit 0; }
    has_role=no; grep -q "^R$TAB" "$tmp/scan" && has_role=yes
    while IFS= read -r rec; do
      k=${rec%%"$TAB"*}; v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
      case "$k" in
        X) deny "$v is not allowed while run $act is active; write agent.sh, AGENT_ROLE and shell commands literally" ;;
        R) [ "$(canon "$v")" = "$role" ] || deny "AGENT_ROLE=$v does not match the caller's role ($role); a role never acts as another" ;;
        N) deny "specialists run through dispatch.sh (window, decision and recording), never as a nested runtime started by hand ($v)" ;;
        L) case "$v" in *.agents*) deny "ln '$v': links into or out of .agents/ are never made during a run" ;; esac
           case "$(relpath "$v")" in .agents|.agents/*) deny "ln '$v': links into or out of .agents/ are never made during a run" ;; esac ;;
        A) lit=${v%%"$TAB"*} sc=${v#*"$TAB"}
          [ "$lit" = 1 ] || deny "agent.sh subcommand '$sc' is not literal"
          case "$sc" in
            record|gate) deny "verdicts enter a run only through agent.sh submit, recorded for the SubagentStop hook or dispatch.sh (agent.sh $sc is never run by the lead or a subagent, D12)" ;;
            window-open|window-close) deny "implementer and designer windows are opened and closed only by the runtime hooks and dispatch.sh" ;;
          esac
          if [ "$sub" = yes ] || [ "$role" != lead ]; then
            case "$sc" in approve|waive|answer) deny "a subagent never approves, waives or answers; only the user does, through the lead (D13, D16)" ;; esac
            case "$role:$sc" in
              *:status|*:pipeline|*:fingerprint|*:verify-*) ;;
              *:submit)
                [ "$role" != lead ] || deny "the lead never submits a specialist result (D12)"
                [ "$has_role" = yes ] || deny "agent.sh submit runs as your role: prefix AGENT_ROLE=$role"
                if [ -n "$aid" ]; then
                  stok=$(printf '%s' "$cmd" | sed -n 's/.*--agent[ =]\{1,\}\([A-Za-z0-9_.-]*\).*/\1/p' | head -n 1)
                  [ "$stok" = "$aidf" ] || deny "agent.sh submit needs your agent token: add --agent $aidf" 
                fi ;;
              implementer:worker-evidence) [ "$has_role" = yes ] || deny "agent.sh worker-evidence runs only as the implementer: prefix AGENT_ROLE=implementer" ;;
              implementer:*) deny "the implementer runs only agent.sh worker-evidence status pipeline fingerprint verify-* (not $sc)" ;;
              *:next) ;;
              *) deny "role $role runs only the read-only agent.sh status pipeline fingerprint next verify-* (not $sc); state changes belong to the lead" ;;
            esac
          fi ;;
        W)
          [ -n "$v" ] || continue
          case "$v" in /dev/*) continue ;; esac
          # A read role writes through no `..` component: $TMPDIR/<worktree>/../../<project path> would pass the worktree check
          [ "$ro" = no ] || case "/$v/" in */../*) deny "the command writes '$v', which goes through a .. component and cannot be placed inside an evidence worktree$(ro_tail)" ;; esac
          case "$v" in
            *'$'*|*'*'*|*'?'*|*'['*)
              # shellcheck disable=SC2016 # literal $TMPDIR in the command text
              case "$v" in /tmp/*|/private/tmp/*|'$TMPDIR'/*|'${TMPDIR'*) continue ;; esac
              case "$role" in implementer|designer) case "$v" in *.agents*|*.claude/settings*|*.codex/*|*.git/*) deny "the command writes '$v', which may be protected run state" ;; esac; continue ;; esac
              deny "the command writes '$v', which cannot be resolved; while run $act is active the lead and read-only roles write only their run artifacts (shell write detection is a heuristic; use the Write tool on an allowed path)$(ro_tail)" ;;
          esac
          # A file the run created (untracked, or a link in scratch/) may be deleted by `rm`/`unlink` when that is the only write to it.
          why=$(target_ok "$v") || { [ "$(grep -cFx "W$TAB$v" "$tmp/scan")" = "$(grep -cFx "E$TAB$v" "$tmp/scan")" ] && erasable "$v" && continue; deny "the command writes '$v': $why$(ro_tail)"; } ;;
        P|Q)
          [ "$ro" = yes ] || continue
          why=$(ro_operand "$k" "$v") || deny "the command edits '$v' in place: $why$(ro_tail)" ;;
      esac
    done < "$tmp/scan"
    scratch_guard
    lead_tmp_check
    exit 0
  fi
  : > "$tmp/targets"
  case "$tool" in
    Edit|Write|MultiEdit|NotebookEdit)
      p=$(jget tool_input.file_path tool_input.notebook_path tool_input.path)
      [ -n "$p" ] || { [ -z "$act" ] || deny "$tool without a target path"; exit 0; }
      printf '%s\n' "$p" > "$tmp/targets" ;;
    *[Pp]atch*)   # Codex apply_patch: file headers inside the patch text
      jget tool_input | grep -Eo '\*\*\* (Add|Update|Delete) File: [^\\"]+|\*\*\* Move to: [^\\"]+' | sed 's/^\*\*\* [A-Za-z ]*: //' > "$tmp/targets" || : ;;
  esac
  while IFS= read -r tg; do ! always_protected "$(relpath "$tg")" || deny "$tool $tg wires the git hooks; it is never changed by an agent"; done < "$tmp/targets"
  case "$tool" in
    Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|*[Pp]atch*)
      db_load; set -f
      { cat "$tmp/targets"; for dk in tool_input.file_path tool_input.notebook_path tool_input.path tool_input.pattern; do jget "$dk"; printf '\n'; done; } > "$tmp/dbt"
      while IFS= read -r tg; do [ -z "$tg" ] || db_check_token "$tg" "$tool"; done < "$tmp/dbt"
      set +f ;;
  esac
  [ -n "$act" ] || exit 0
  case "$tool" in *[Pp]atch*) jget tool_input | grep -Eo '\*\*\* Delete File: [^\\"]+' | sed 's/^\*\*\* Delete File: //' > "$tmp/erase" || : ;; esac
  while IFS= read -r tg; do
    # a patch that only deletes a file the run created (see erasable)
    why=$(target_ok "$tg") || { [ "$(grep -cFx -- "$tg" "$tmp/targets")" = 1 ] && grep -qFx -- "$tg" "$tmp/erase" 2>/dev/null && erasable "$tg" && continue; deny "$tool $tg: $why$(ro_tail)"; }
    # A120: the file tools write nothing outside the copy (the shell guard handles shell writes, A97)
    [ "$(relpath "$tg")" != @outside ] || why=$(outside_ok "$tg") || deny "$tool $tg: $why"
  done < "$tmp/targets"
  exit 0 ;;

subagent-start)
  [ "$parsed" = yes ] && [ -n "$prole" ] && [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  mkdir -p "$local_dir/windows" "$local_dir/records" "$local_dir/submissions"
  # A127: submit trusts a typed --agent over PROOFLINE_AGENT only for a registered subagent. The file holds the path of the
  # subagent's session log, where agent.sh reads the tokens it used (metrics_step); the path is the runtime's own, never typed.
  stp=$(jget agent_transcript_path); if [ -z "$stp" ]; then stp=$(jget transcript_path); [ -z "$stp" ] || stp=${stp%.jsonl}/subagents/agent-$aid.jsonl; fi
  printf '%s\n' "$stp" > "$local_dir/submissions/$aidf.started"
  if [ "$prole" = implementer ] || [ "$prole" = designer ]; then
    if before=$(unset AGENT_ROLE; sh "$agent" window-open "$act" "$prole" 2>"$tmp/err"); then printf '%s\n' "$before" > "$local_dir/windows/$aidf"
    else printf 'proofline: window-open refused for proofline-%s (%s): %s\n' "$prole" "$aidf" "$(tr '\n' ' ' < "$tmp/err")" >> "$local_dir/records/$aidf.txt"; fi
  fi
  case "$prole" in explorer) rart="--report .agents/runs/$act/scratch/$aidf-report.md (write the report to EXACTLY this file, never a generic scratch name such as r.md, or pass --report - with the text on stdin; the script assigns the numbered report name, pass no --artifact)" ;; *) rart='[--artifact <path of your report>]' ;; esac
  ctx SubagentStart "proofline: active run $act (run dir .agents/runs/$act). You are role $prole; your agent token is $aidf. Prefix every state-changing agent.sh command with AGENT_ROLE=$prole. Report your result with: AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] $rart [--findings FILE] [--reason T] [--questions FILE]. The script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is free text; the result is the submission." ;;

subagent-stop)
  # The result is the specialist's `agent.sh submit` (its status file under .agents/local/submissions/);
  # the final message is never parsed. A specialist that stops without a recorded submission is sent back
  # once with the last rejection; the second stop is accepted and reported to the lead as "no result".
  [ "$parsed" = yes ] && [ -n "$prole" ] || exit 0
  [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  rec=$local_dir/records; sdir=$local_dir/submissions; mkdir -p "$rec" "$local_dir/windows" "$sdir"
  st=$sdir/$aidf.status; out=$rec/$aidf.txt
  state=$(sed -n 's/^status=//p' "$st" 2>/dev/null | head -n 1)
  if [ "$state" != ok ]; then
    err=$(sed -n 's/^error=//p' "$st" 2>/dev/null | head -n 1)
    mark=$sdir/$aidf.retried; now=$(date +%s); prev=$(cat "$mark" 2>/dev/null || :)
    case "$prev" in *[!0-9]*) prev='' ;; esac
    # stop_hook_active is the runtime's "already sent back once"; a second hook layer firing for the same
    # stop (within two seconds) gives the same answer.
    if [ "$(jget stop_hook_active)" != true ] && { [ -z "$prev" ] || [ $((now - prev)) -le 2 ]; }; then
      [ -n "$prev" ] || printf '%s\n' "$now" > "$mark"
      case "$prole" in explorer) rart="--report .agents/runs/$act/scratch/$aidf-report.md (or - for stdin; the script assigns the numbered report name, pass no --artifact)" ;; *) rart='[--artifact <report path>]' ;; esac
      reason="proofline: you stopped without a recorded result. Run AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] $rart [--findings FILE] [--reason T] [--questions FILE]${err:+ (last rejection: $err)}, fix what it names, then finish."
      printf '{"decision":"block","reason":"%s"}\n' "$(jesc "$reason")"
      exit 0
    fi
    : > "$sdir/$aidf.final"
  fi
  rm -f "$sdir/$aidf.started"   # A127: the final stop; the status check above is done
  mkdir "$rec/$aidf.lock" 2>/dev/null || exit 0   # one record per subagent even when two hook layers fire
  if { [ "$prole" = implementer ] || [ "$prole" = designer ]; } && [ -f "$local_dir/windows/$aidf" ]; then
    if (unset AGENT_ROLE; sh "$agent" window-close "$act" "$(cat "$local_dir/windows/$aidf")" 0 "$prole") >"$tmp/o" 2>&1; then rm -f "$local_dir/windows/$aidf"
    else printf 'proofline: window-close rejected for proofline-%s: %s\n' "$prole" "$(tr '\n' ' ' < "$tmp/o")" >> "$out"; fi
  fi
  if [ "$state" = ok ]; then
    printf 'proofline: proofline-%s submitted: %s %s%s (%s)\n' "$prole" "$(sed -n 's/^role=//p' "$st" | head -n 1)" "$(sed -n 's/^result=//p' "$st" | head -n 1)" \
      "$(g=$(sed -n 's/^gate=//p' "$st" | head -n 1); [ -z "$g" ] || printf ' gate=%s' "$g")" "$(sed -n 's/^raw=//p' "$st" | head -n 1)" >> "$out"
  else
    printf 'proofline: proofline-%s ended without a recorded result%s; nothing recorded (no valid agent.sh submit)\n' "$prole" "${err:+ (last rejection: $err)}" >> "$out"
  fi
  exit 0 ;;

posttool)
  # Relay record/window outcomes to the lead (SubagentStop context reaches only the subagent).
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  : > "$tmp/all"
  for f in "$local_dir"/records/*.txt; do
    [ -f "$f" ] || continue
    cat "$f" >> "$tmp/all"; rm -f "$f"; rmdir "${f%.txt}.lock" 2>/dev/null || :
  done
  [ -s "$tmp/all" ] || exit 0
  ctx PostToolUse "$(cat "$tmp/all")" ;;

prompt)
  # User-prompt capture for approvals and answered_by (GATES.md "Approvals"). Never for a dispatched
  # specialist, whose prompt is the lead's.
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  jget prompt > "$tmp/text" || exit 0
  # A finished background agent arrives as a "prompt" (<task-notification>): not the user's words. It must not replace
  # the user's capture (an answer recorded afterwards compared against it) and cannot approve anything.
  case "$(head -c 19 "$tmp/text")" in "<task-notification>") exit 0 ;; esac
  once
  sess=$(safe "$(jget session_id)"); [ -n "$sess" ] || sess=unknown
  mkdir -p "$local_dir/prompts" || exit 0
  # The previous run of this hook did not finish (killed at the runtime's timeout): say so plainly.
  warn=''; if [ -f "$local_dir/prompts/.approving-$sess" ]; then warn="proofline: the approval hook for the user's previous message did not finish (it timed out), so an approval in that message was NOT recorded. Tell the user plainly that the approval was not recorded and ask them to repeat it."; fi
  h=$(sha "$tmp/text")
  printf '{"session":"%s","time":%s,"sha256":"%s","text":"%s"}\n' "$sess" "$(date +%s)" "$h" "$(jesc "$(cat "$tmp/text"; printf x)" | sed 's/x$//')" > "$local_dir/prompts/.$sess.tmp" &&
    mv "$local_dir/prompts/.$sess.tmp" "$local_dir/prompts/$sess.json"
  # Every prompt is kept (raw text) so an answer recorded as the user's can be checked against what was said (A60).
  mkdir -p "$local_dir/prompts/history" && cp "$tmp/text" "$local_dir/prompts/history/$(date +%s)-$(printf '%.8s' "$h").txt" 2>/dev/null || :
  # Approvals are recorded here, by the runtime, from the user's own reply (A41): every open request this
  # prompt satisfies (approval phrase and kind word, single-use) becomes an approval. The lead never runs
  # `agent.sh approve`; a prompt that approves nothing changes nothing.
  # Fast path: agent.sh starts only when an approval request is open; a marker left behind means a timeout.
  req=no; for f in "$root/.agents/runs/$act/approvals/"[0-9][0-9][0-9]-request-*.yaml "$local_dir/approvals/"[0-9][0-9][0-9]-request-*.yaml; do [ ! -f "$f" ] || req=yes; done
  if [ "$act" != INVALID ] && [ "$req" = yes ]; then
    printf '%s\n' "$h" > "$local_dir/prompts/.approving-$sess"
    (unset AGENT_ROLE; sh "$agent" approve-pending "$act" >/dev/null 2>&1) || :
  fi
  rm -f "$local_dir/prompts/.approving-$sess"
  [ -z "$warn" ] || ctx UserPromptSubmit "$warn"
  exit 0 ;;

stop)
  # The final report to the user carries the run's state, class and gate names verbatim (A44, TR-2): they are
  # identifiers, never translated. Checked once per reporting state; a rewrite that carries them satisfies it,
  # and a second stop (stop_hook_active) is always accepted.
  [ "$parsed" = yes ] && [ "$sub" = no ] && [ "$role" = lead ] || exit 0
  [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  need=$(unset AGENT_ROLE; sh "$agent" report-tokens "$act" 2>/dev/null) || exit 0
  [ -n "$need" ] || exit 0
  msg=$(jget last_assistant_message)
  if [ -z "$msg" ]; then
    tp=$(jget transcript_path)
    if [ -n "$tp" ] && [ -f "$tp" ] && command -v jq >/dev/null 2>&1; then
      msg=$(jq -rs '[.[] | select(.type == "assistant")] | last | .message.content | if type == "array" then map(select(.type == "text") | .text) | join("\n") else . end' "$tp" 2>/dev/null) || msg=''
    fi
  fi
  [ -n "$msg" ] || exit 0
  state=$(printf '%s\n' "$need" | head -n 1)
  mkdir -p "$local_dir/report-check" 2>/dev/null || exit 0
  mark=$local_dir/report-check/$act.$state
  missing=''
  for tk in $need; do printf '%s' "$msg" | grep -Fqw -- "$tk" || missing="$missing $tk"; done
  # Every final message of a reporting state is checked (the last one is what the user reads); a message that
  # carries the identifiers resets the counter. A message is sent back at most three times in a row, then accepted
  # (never an endless loop).
  if [ -z "$missing" ]; then rm -f "$mark.tries"; exit 0; fi
  tries=$(cat "$mark.tries" 2>/dev/null || echo 0)
  case "$tries" in *[!0-9]*) tries=0 ;; esac
  [ "$tries" -lt 3 ] || exit 0
  printf '%s\n' $((tries + 1)) > "$mark.tries"
  printf '{"decision":"block","reason":"%s"}\n' "$(jesc "proofline: the final report must carry these identifiers verbatim, untranslated, in any language:$missing. Gate names, the class, the state and result values are never translated; write the prose around them in the user's language, or paste the lines of 'agent.sh summary $act'. Then finish.")"
  exit 0 ;;

session)
  [ "$role" = lead ] && [ "$sub" = no ] || exit 0
  once
  case "$rt" in
    codex) skill=.agents/skills/proofline-lead/SKILL.md ;;
    *) if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then skill=$CLAUDE_PLUGIN_ROOT/skills/proofline-lead/SKILL.md; else skill=.agents/skills/proofline-lead/SKILL.md; fi ;;
  esac
  if [ -n "$act" ] && [ "$act" != INVALID ]; then
    nxt=$(sh "$agent" next "$act" 2>&1 | sed -n 's/^next=//p' | awk 'BEGIN { ORS = "" } { if (NR > 1) print "; "; print }')
  else nxt="no active run: start one with the proofline-lead skill"; fi
  ctx SessionStart "proofline installed; you are the lead; use the proofline-lead skill ($skill); active run: ${act:-none}; next step: ${nxt:-agent.sh next ${act} failed}" ;;

*) echo "usage: proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]" >&2; exit 0 ;;
esac
