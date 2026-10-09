# CLAUDE.md

Follow `AGENTS.md` (boot protocol) and `.agents/WORKFLOW.md`. Claude Code features are subordinate to them:
subagents `proofline-<role>` run the bounded roles; the SubagentStop hook records their results with
`agent.sh record`; hooks are an extra enforcement layer over `agent.sh` and the git hooks, never a substitute.
