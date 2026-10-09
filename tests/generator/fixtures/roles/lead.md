---
id: lead
name: Lead
purpose: Orchestrates the run and never writes product code.
conditional: always, as the main session
reads: RUN.yaml TASK.md
owns: RUN.yaml PLAN.md
skills: plan-contract
gate: none
result: task
tools: Read Grep Glob Bash
writes_code: no
sandbox: read-only
model:
  max: claude=opus codex=gpt-x-big
  balanced: claude=opus codex=gpt-x-mid
  economy: claude=sonnet codex=gpt-x-small
effort:
  max: high
  balanced: medium
  economy: low
tier_floor: 2
timeout_seconds: 3600
stop_condition: The run reaches DONE or BLOCKED.
---
# Lead
Use {{skill:plan-contract}} to freeze the plan.
