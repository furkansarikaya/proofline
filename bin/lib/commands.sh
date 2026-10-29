#!/bin/sh
# Verification commands for a project whose commands.build|test|lint are empty (A200). An empty key is no reason to wait: the
# commands are discovered from the project (discover.sh), proven by running each once, and proposed with ONE question. The
# user's yes writes only the proven ones. A command that was not proven (a trial run that failed, or one with shell operators
# that a trial run would execute unchecked) is never written.
#   proofline doctor --commands          discover, prove, record the proposal (.agents/local/commands/PROPOSAL.tsv) and ask
#   proofline doctor --apply-commands    write the proposal after the user's yes (agent.sh commands-check decides, from the user's own message
#                                        or from a batch approval whose summary names this proposal)
# Sourced by bin/proofline after config.sh and discover.sh (say, die, cfg_cmds, cfg_set, discover_commands, verify_commands, d_cur).

cm_dir() { printf '%s\n' "$ROOT/.agents/local/commands"; }

# cm_empty: the commands keys that are empty in the config, space separated.
cm_empty() {
  cm_e=''
  for cm_k in build test lint; do [ -n "$(cfg_cmds "$ROOT/.agents/config.yaml" "commands.$cm_k")" ] || cm_e="$cm_e $cm_k"; done
  printf '%s\n' "${cm_e# }"
}

# cm_propose: discover for the empty keys, prove each command by one run, write the proposal and print the question.
cm_propose() {
  cm_e=$(cm_empty)
  if [ -z "$cm_e" ]; then say "commands: build, test and lint are configured"; return 0; fi
  discover_commands "$ROOT"
  cm_d=$(cm_dir); mkdir -p "$cm_d"
  # only the empty keys are proposed; a configured key is never touched
  for cm_k in build test lint; do case " $cm_e " in *" $cm_k "*) ;; *) d_put "$cm_k" '' ;; esac; done
  cm_found=$(for cm_k in $cm_e; do printf '%s\n' "$(d_cur "$cm_k")" | sed '/^$/d' | sed "s/^/$cm_k: /"; done)
  if [ -z "$cm_found" ]; then
    rm -f "$cm_d/PROPOSAL.tsv"
    say "commands: empty in .agents/config.yaml:$(printf ' %s' "$cm_e"), and nothing could be discovered from this project; set them by hand (commands.build, commands.test, commands.lint)"
    return 0
  fi
  say "proving the discovered commands, one run each..."
  verify_commands "$ROOT"
  cm_t=$(mktemp "${TMPDIR:-/tmp}/proofline-commands.XXXXXX")
  : > "$cm_t"   # no time is written into the proposal: freshness is the approval request's own requested_at (A200 review)
  for cm_k in $cm_e; do printf '%s\n' "$(d_cur "$cm_k")" | sed '/^$/d' | while IFS= read -r cm_c; do printf '%s\t%s\n' "$cm_k" "$cm_c"; done; done >> "$cm_t"
  if [ "$(wc -l < "$cm_t" | tr -d ' ')" -eq 0 ]; then
    rm -f "$cm_t" "$cm_d/PROPOSAL.tsv"
    say "commands: none of the discovered commands could be proven (a failed trial run is not written): fix the project's build, or set commands.* by hand"
    return 0
  fi
  mv "$cm_t" "$cm_d/PROPOSAL.tsv"
  cm_h=$(sha256 "$cm_d/PROPOSAL.tsv" | cut -c1-12)
  say ""
  say "commands proposal $cm_h (each command ran once and passed):"
  awk -F'\t' '!/^#/ { print "  commands." $1 ": " $2 }' "$cm_d/PROPOSAL.tsv" | while IFS= read -r cm_l; do say "$cm_l"; done
  say "QUESTION (one): write these into .agents/config.yaml? Reply \"approve commands\". Nothing is written without your reply."
  # the question is also a normal approval request of the kind `commands`, bound to the sha256 of this file; the user's reply records it
  sh "$ROOT/.agents/scripts/agent.sh" request-approval - commands || say "(the approval request could not be recorded: run agent.sh request-approval - commands)"
  say "  in a night batch the summary names this proposal and your batch approval covers it (A200); then: proofline doctor --apply-commands"
}

# cm_apply: write the proposal when agent.sh says the user agreed.
cm_apply() {
  cm_d=$(cm_dir)
  [ -s "$cm_d/PROPOSAL.tsv" ] || die "doctor --apply-commands: no commands proposal (run: proofline doctor --commands)"
  sh "$ROOT/.agents/scripts/agent.sh" commands-check || die "doctor --apply-commands: the user has not agreed to this proposal yet; ask the one question and wait for the reply"
  for cm_k in build test lint; do
    cm_v=$(awk -F'\t' -v k="$cm_k" '!/^#/ && $1 == k { print $2 }' "$cm_d/PROPOSAL.tsv")
    [ -n "$cm_v" ] || continue
    [ -z "$(cfg_cmds "$ROOT/.agents/config.yaml" "commands.$cm_k")" ] || { say "commands.$cm_k is configured now; left as it is"; continue; }
    cfg_set "$ROOT/.agents/config.yaml" "commands.$cm_k" "$cm_v" || die "config key not set: commands.$cm_k"
    say "wrote commands.$cm_k: $(printf '%s' "$cm_v" | tr '\n' ';')"
  done
  # the approval is used up here: a replay of the same proposal needs a new request and a new reply (a batch-covered proposal has none to consume)
  sh "$ROOT/.agents/scripts/agent.sh" approval-consume - commands >/dev/null 2>&1 || :
  mv "$cm_d/PROPOSAL.tsv" "$cm_d/applied-$(date +%s).tsv"
  (cd "$ROOT" && sh .agents/scripts/agent.sh config-check) || die "the written commands do not pass agent.sh config-check; fix .agents/config.yaml"
}
