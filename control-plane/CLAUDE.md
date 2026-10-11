# CLAUDE.md

Follow `AGENTS.md` (boot protocol) and `.agents/WORKFLOW.md`. Claude Code features are subordinate to them:
subagents `proofline-<role>` run the bounded roles and report with `agent.sh submit`; the SubagentStop hook
reads the submission status (and sends a specialist without one back once); hooks are an extra enforcement layer over `agent.sh` and the git hooks, never a substitute.
