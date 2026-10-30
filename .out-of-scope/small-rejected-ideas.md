# Smaller rejected ideas

**Status:** Rejected.

- **End-of-task quiz for the user.** Adds friction without improving the
  evidence. Use `/proofline explain` instead.
- **Hook guards as a security boundary against a hostile agent.** Hooks
  read command text and cannot see everything; they are tripwires against
  honest mistakes. The boundary against a hostile agent is the runtime's
  permission mode and sandbox.
- **Killing processes by pattern.** Agents never use pkill, killall or
  pattern kills; only the PID of a process they started.
- **Asking the user to run internal commands.** Agents never ask the user
  to run agent.sh, approve, answer, --no-verify, or to hand-edit files under
  .agents/. If that seems necessary, it is a proofline bug to report.
- **A setting to merge draft pull requests automatically.** Drafts are for
  people to decide on.
