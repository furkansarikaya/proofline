#!/bin/sh
# proofline runtime hook: the extra enforcement layer for Claude Code and Codex (D2, D6, D12, D13, D16).
# The foundation stays agent.sh and the git hooks; this script never decides a gate, it only blocks tool
# calls early and feeds agent.sh. Normative description: docs/concepts/enforcement-layers.md.
#
#   proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|session> [claude|codex]
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
[ -f "$root/.agents/config.yaml" ] && [ -f "$agent" ] || exit 0
local_dir=$root/.agents/local

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
  case "$rp" in "$root") echo . ;; "$root"/*) printf '%s\n' "${rp#"$root"/}" ;; *) echo @outside ;; esac
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
  case "$po" in
    .claude/settings.json|.claude/settings.local.json|.codex/hooks.json|.codex/config.toml|.agents/hooks|.agents/hooks/*)
      echo "$po holds the runtime hooks; it is never edited during a run"; return 1 ;;
    "$run"/RUN.yaml|"$run"/LEDGER.log|"$run"/gates/*|"$run"/approvals/*|"$run"/waivers/*|"$run"/questions/*|"$run"/decisions/*|"$run"/dispatch/*|"$run"/worker-evidence/*|"$run"/results/*.result.md|"$run"/results/dispatch-*|.agents/local|.agents/local/*)
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
      [ -f "$local_dir/windows/$aidf" ] || { echo "no $role window is open for this subagent (SubagentStart window-open failed or was skipped); the change would be unattributed"; return 1; } ;;
  esac
  return 0
}

# scan_cmd: reads shell command text, prints one record per finding, "<K><TAB><value>" (newlines in a value
# as \002). A heuristic tokenizer, not a parser: quotes are removed (agent.s""h = agent.sh), heredoc bodies
# skipped, `sh|bash -c STRING`, "$(...)" and "`...`" inside double quotes are scanned as nested commands.
#   W path   the command writes path (redirection, tee, sed -i, perl -i, cp/mv/install/rsync/ln target, mv
#            sources, touch/rm/truncate/unlink/rmdir/shred, chmod/chown/chgrp operands, dd of=)
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
  function out(k, v) { if (k == "W" && cwdp != "" && substr(v, 1, 1) != "/" && substr(v, 1, 1) != "~") v = cwdp "/" v; gsub(/\n/, "\002", v); print k "\t" v }
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
        out("W", w[j])
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
    else if (c == "sed" || c == "gsed" || c == "perl") { for (j = k + 1; j <= nw; j++) if (w[j] ~ /^-[A-Za-z]*i/ || w[j] ~ /^--in-place/) { if (nw > k + 1) out("W", w[nw]); break } }
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

# --- database guard (A40) ---------------------------------------------------------------------
# While a run is open no agent (lead included) reads, copies, queries or writes a database file, runs a SQL
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
    case "$dp_g" in
      */*) case "$1" in $dp_g|*/$dp_g) return 0 ;; esac ;;
      *) case "${1##*/}" in $dp_g) return 0 ;; esac ;;
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

# --- events -----------------------------------------------------------------------------------
case "$ev" in
pretool)
  if [ "$parsed" = no ]; then
    [ -z "$act" ] || deny "hook input could not be parsed (jq or node is required) while run $act is active; failing closed"
    exit 0
  fi
  [ "$act" != INVALID ] || deny ".agents/local/ACTIVE_RUN is malformed; fix it with agent.sh before editing"
  tool=$(jget tool_name)
  cmd=''
  case "$tool" in Bash|shell|local_shell|exec_command|unified_exec) cmd=$(jget tool_input.command tool_input.cmd) ;; esac
  TAB=$(printf '\t')
  if [ -n "$cmd" ]; then
    # A specialist never mutates the live tree with git (stash, reset, checkout --, restore, clean, ...):
    # mutation evidence runs in a separate worktree (`git worktree add`, then `git -C <worktree> ...`).
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } \
       && printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])git[[:space:]]+(stash|reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout[[:space:]]+--)([[:space:]]|$)' \
       && ! printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+-C[[:space:]]|git[[:space:]]+worktree|--work-tree'; then
      deny "git must not change the live working tree from a specialist (stash, reset, clean, restore, checkout --, switch, ...); run mutation evidence in a separate worktree (git worktree add, then git -C <worktree> ...) and leave the tree as you found it"
    fi
    # Scratch space is $TMPDIR (the runtime's private temp dir), never /tmp directly: files outside the project
    # and $TMPDIR are what a run must not leave behind. A project that itself lives under /tmp is not scratch.
    if [ -n "$act" ] && { [ "$sub" = yes ] || [ "$role" != lead ]; } && ! tmp_is_scratch_root; then
      stray=$(stray_tmp_path "$cmd")
      [ -z "$stray" ] || deny "scratch files and worktrees go under \$TMPDIR (${TMPDIR:-unset}), never $stray directly"
    fi
    printf '%s\n' "$cmd" | scan_cmd > "$tmp/scan"
    # Hook and gate bypasses: never, for anyone, while proofline is installed.
    while IFS= read -r rec; do
      k=${rec%%"$TAB"*}; v=$(printf '%s' "${rec#*"$TAB"}" | tr '\002' '\n')
      case "$k" in
        B) deny "git hook bypass is never allowed ($v); the git hooks enforce identity, gates and approvals" ;;
        A) case "${v#*"$TAB"}" in approve|approve-pending) deny "no model runs agent.sh ${v#*"$TAB"}: an approval is the user's. The runtime records it from the user's reply (the prompt hook) and agent.sh refuses it without that reply; wait for the user's answer, then run agent.sh next" ;; esac ;;
        W) ! always_protected "$(relpath "$v")" || deny "the command writes '$v', which wires the git hooks; it is never changed by an agent (git hook bypass)" ;;
      esac
    done < "$tmp/scan"
    [ -n "$act" ] || exit 0
    db_guard_cmd "$cmd"
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
          case "$v" in
            *'$'*|*'*'*|*'?'*|*'['*)
              # shellcheck disable=SC2016 # literal $TMPDIR in the command text
              case "$v" in /tmp/*|/private/tmp/*|'$TMPDIR'/*|'${TMPDIR'*) continue ;; esac
              case "$role" in implementer|designer) case "$v" in *.agents*|*.claude/settings*|*.codex/*|*.git/*) deny "the command writes '$v', which may be protected run state" ;; esac; continue ;; esac
              deny "the command writes '$v', which cannot be resolved; while run $act is active the lead and read-only roles write only their run artifacts (shell write detection is a heuristic; use the Write tool on an allowed path)" ;;
          esac
          why=$(target_ok "$v") || deny "the command writes '$v': $why" ;;
      esac
    done < "$tmp/scan"
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
  [ -n "$act" ] || exit 0
  case "$tool" in
    Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|*[Pp]atch*)
      db_load; set -f
      { cat "$tmp/targets"; for dk in tool_input.file_path tool_input.notebook_path tool_input.path tool_input.pattern; do jget "$dk"; printf '\n'; done; } > "$tmp/dbt"
      while IFS= read -r tg; do [ -z "$tg" ] || db_check_token "$tg" "$tool"; done < "$tmp/dbt"
      set +f ;;
  esac
  while IFS= read -r tg; do why=$(target_ok "$tg") || deny "$tool $tg: $why"; done < "$tmp/targets"
  exit 0 ;;

subagent-start)
  [ "$parsed" = yes ] && [ -n "$prole" ] && [ -n "$act" ] && [ "$act" != INVALID ] || exit 0
  mkdir -p "$local_dir/windows" "$local_dir/records"
  if [ "$prole" = implementer ] || [ "$prole" = designer ]; then
    if before=$(unset AGENT_ROLE; sh "$agent" window-open "$act" "$prole" 2>"$tmp/err"); then printf '%s\n' "$before" > "$local_dir/windows/$aidf"
    else printf 'proofline: window-open refused for proofline-%s (%s): %s\n' "$prole" "$aidf" "$(tr '\n' ' ' < "$tmp/err")" >> "$local_dir/records/$aidf.txt"; fi
  fi
  ctx SubagentStart "proofline: active run $act (run dir .agents/runs/$act). You are role $prole; your agent token is $aidf. Prefix every state-changing agent.sh command with AGENT_ROLE=$prole. Report your result with: AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] [--artifact <path of your report>] [--findings FILE] [--reason T] [--questions FILE]. The script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is free text; the result is the submission." ;;

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
      reason="proofline: you stopped without a recorded result. Run AGENT_ROLE=$prole sh .agents/scripts/agent.sh submit $act --agent $aidf --confidence <high|medium|low> [--focus F] [--artifact <report path>] [--findings FILE] [--reason T] [--questions FILE]${err:+ (last rejection: $err)}, fix what it names, then finish."
      printf '{"decision":"block","reason":"%s"}\n' "$(jesc "$reason")"
      exit 0
    fi
    : > "$sdir/$aidf.final"
  fi
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
  sess=$(safe "$(jget session_id)"); [ -n "$sess" ] || sess=unknown
  mkdir -p "$local_dir/prompts" || exit 0
  h=$(sha "$tmp/text")
  printf '{"session":"%s","time":%s,"sha256":"%s","text":"%s"}\n' "$sess" "$(date +%s)" "$h" "$(jesc "$(cat "$tmp/text"; printf x)" | sed 's/x$//')" > "$local_dir/prompts/.$sess.tmp" &&
    mv "$local_dir/prompts/.$sess.tmp" "$local_dir/prompts/$sess.json"
  # Approvals are recorded here, by the runtime, from the user's own reply (A41): every open request this
  # prompt satisfies (approval phrase and kind word, single-use) becomes an approval. The lead never runs
  # `agent.sh approve`; a prompt that approves nothing changes nothing.
  case "$act" in INVALID) ;; *) (unset AGENT_ROLE; sh "$agent" approve-pending "$act" >/dev/null 2>&1) || : ;; esac
  exit 0 ;;

session)
  [ "$role" = lead ] && [ "$sub" = no ] || exit 0
  case "$rt" in
    codex) skill=.agents/skills/proofline-lead/SKILL.md ;;
    *) if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then skill=$CLAUDE_PLUGIN_ROOT/skills/proofline-lead/SKILL.md; else skill=.agents/skills/proofline-lead/SKILL.md; fi ;;
  esac
  if [ -n "$act" ] && [ "$act" != INVALID ]; then
    nxt=$(sh "$agent" next "$act" 2>&1 | sed -n 's/^next=//p' | awk 'BEGIN { ORS = "" } { if (NR > 1) print "; "; print }')
  else nxt="no active run: start one with the proofline-lead skill"; fi
  ctx SessionStart "proofline installed; you are the lead; use the proofline-lead skill ($skill); active run: ${act:-none}; next step: ${nxt:-agent.sh next ${act} failed}" ;;

*) echo "usage: proofline-hook.sh <pretool|posttool|subagent-start|subagent-stop|prompt|session> [claude|codex]" >&2; exit 0 ;;
esac
