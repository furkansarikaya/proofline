# proofline: shared "is this a human?" test, sourced by pre-commit and pre-push (not a hook itself).
# An agent session is recognised by its markers, not by a terminal: visual git clients (VS Code, GitHub
# Desktop) run hooks without a TTY and must still count as a human. No marker -> human.
#   AGENT_ROLE                                   proofline's own declared role
#   CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,          Claude Code (seen in a real session's command environment)
#   CLAUDE_CODE_SESSION_ID
#   CODEX_CI, CODEX_SANDBOX, CODEX_THREAD_ID,    Codex (seen in a real `codex exec` command environment)
#   CODEX_SESSION_ID
# PROOFLINE_NO_TTY=1 forces "agent" (self-tests, doctor probes). Residual: an agent that unsets these
# variables looks human; the real guarantee is GitHub branch protection (ENFORCEMENT.md).
human() {
  [ "${PROOFLINE_NO_TTY:-0}" != 1 ] || return 1
  [ -z "${AGENT_ROLE:-}${CLAUDECODE:-}${CLAUDE_CODE_ENTRYPOINT:-}${CLAUDE_CODE_SESSION_ID:-}${CODEX_CI:-}${CODEX_SANDBOX:-}${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}" ]
}
