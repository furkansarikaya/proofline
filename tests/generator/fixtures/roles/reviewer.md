---
id: reviewer                       # role id
name: Reviewer
purpose: Reviews a change against the plan.
conditional: per tier (D14) | "quoted" \ slash
reads: TASK.md PLAN.md
owns: reviews/proof-review/
skills: proof-review test-trust
gate: REVIEW_PLAN REVIEW_RULES
result: gate
tools: Read Grep Glob Bash
writes_code: no
sandbox: read-only
model:
  max: claude=opus codex=gpt-x-big
  balanced: claude=sonnet codex=gpt-x-mid
  economy: claude=haiku codex=gpt-x-small
effort:
  max: high
  balanced: medium
  economy: low
tier_floor: 2
timeout_seconds: 1800
stop_condition: Verdict recorded.
---
# Reviewer
Run {{skill:proof-review}} then {{skill:test-trust}} and {{skill:proof-review}} again.
Quote: "double" and 'single' and back\slash and C:\path\n.
