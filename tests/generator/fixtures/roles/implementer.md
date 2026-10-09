---
id: implementer
name: Implementer
purpose: Implements the frozen plan.
conditional: after the plan is frozen
reads: PLAN.md
owns: PRODUCT_SCOPE results/NNN-debug.md
skills: tdd-proof
gate: none
result: task
tools: Read Grep Glob Bash Edit Write
writes_code: yes
sandbox: workspace-write
model:
  max: claude=opus codex=gpt-x-big
  balanced: claude=sonnet codex=gpt-x-mid
  economy: claude=sonnet codex=gpt-x-small
effort:
  max: high
  balanced: high
  economy: medium
tier_floor: 2
timeout_seconds: 3600
stop_condition: Tests green.
---
# Implementer
Triple ''' quote and ends with a quote'
Follow {{skill:tdd-proof}}.
