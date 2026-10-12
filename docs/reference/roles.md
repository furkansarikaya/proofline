<!-- Generated from roles/ — do not edit. Run adapters/generate.sh. -->

# Roles reference

Generated from roles/ — do not edit.

| Role | Purpose | Dispatched | Result | Gates | Skills | Writes code | Sandbox | Tier floor |
|---|---|---|---|---|---|---|---|---|
| [`architect`](#architect) | Designs the smallest valid system and API solution from the task and frozen evidence, returning the PLAN Architecture text, design drafts and ADRs for real decisions. | class COMPLEX or CRITICAL, or on request (proofline design system or api) | task | none | system-design api-design | no | workspace-write | 2 |
| [`data_architect`](#data_architect) | Designs the data model change and its migration plan, returning the PLAN Data section text and design/DATA.md, and flags every destructive operation. | when persistence, schema or stored data changes, or on request (proofline design data) | task | none | data-design | no | workspace-write | 2 |
| [`designer`](#designer) | Designs the user interface for a task, writing the PLAN UI section and the per-task UI spec, and keeps the durable design system consistent. | when the task changes a user interface, or on request (proofline design ui) | task | none | ui-design | no | workspace-write | 1 |
| [`explorer`](#explorer) | Investigates one bounded assignment and returns compact evidence where every claim is a verified path and symbol. | class STANDARD and up, in parallel up to the class max_explorers bound for independent objectives | task | none | evidence-map | no | workspace-write | 1 |
| [`implementer`](#implementer) | Implements the frozen plan inside its scope with recorded RED, GREEN and REFACTOR evidence, and fixes bounded findings. | always, the only role that writes product code, one per run | task | none | tdd-proof debug-proof | yes | workspace-write | 2 |
| [`lead`](#lead) | Owns the task lifecycle as the main session, classifying, freezing, dispatching bounded specialists, consolidating their results, driving gates and the fix loop, and stopping before delivery. | always, the main session (alias full_lifecycle) | task | none | proofline-lead plan-contract debug-proof | no | workspace-write | 2 |
| [`qa`](#qa) | Writes the acceptance and adversarial QA plan before implementation and evaluates the implementation against the frozen plan after it. | class STANDARD and up, plan step before FREEZE and report step once IMPLEMENTED | gate | QA | qa-plan test-trust | no | workspace-write | 1 |
| [`reviewer`](#reviewer) | Independently reviews the task-owned diff for one focus (plan, rules, tests, data, or rules+tests) and returns an evidence-based gate result. | per tier (D14), small tier one reviewer with focus rules+tests, full tier one reviewer per focus plan rules tests and data when PLAN.md has a Data section | gate | REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA REVIEW_SMALL | proof-review test-trust data-design | no | workspace-write | 2 |
| [`security_reviewer`](#security_reviewer) | Reviews the task-owned diff as an attacker and reports only exploitable findings, each reproduced or traced from source to sink. | full tier (D14), always for CRITICAL class | gate | SECURITY | exploit-proof | no | workspace-write | 3 |
| [`task_author`](#task_author) | Turns a one-sentence request or an imported issue into a standard task with testable acceptance criteria, grilling intent first when the request is vague or large. | when no task exists, or an imported task lacks canonical fields, intent-grill first for COMPLEX or CRITICAL requests or on request | task | none | task-author intent-grill | no | workspace-write | 1 |
| [`verifier`](#verifier) | Proves mechanically that the frozen plan is implemented and that design documents still match the code. | always, every class, once the run is IMPLEMENTED | gate | VERIFY | verify-proof design-sync | no | workspace-write | 1 |

## architect

Designs the smallest valid system and API solution from the task and frozen evidence, returning the PLAN Architecture text, design drafts and ADRs for real decisions.

- Name: Architect
- Agent: proofline-architect
- Dispatched: class COMPLEX or CRITICAL, or on request (proofline design system or api)
- Reads: TASK.md EVIDENCE.md design/INTENT.md repo
- Owns: design/ reports/NNN-architect.md
- Skills: system-design api-design
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 2
- Timeout: 1800 s
- Stop condition: Stops when the PLAN Architecture text and design/ARCHITECTURE.md cover every acceptance criterion the design touches, or at the first requirement-level question.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | xhigh |
| balanced | opus | gpt-6-astra | high |
| economy | sonnet | gpt-6-sol | high |

## data_architect

Designs the data model change and its migration plan, returning the PLAN Data section text and design/DATA.md, and flags every destructive operation.

- Name: Data Architect
- Agent: proofline-data-architect
- Dispatched: when persistence, schema or stored data changes, or on request (proofline design data)
- Reads: TASK.md EVIDENCE.md design/INTENT.md design/ARCHITECTURE.md repo
- Owns: design/ reports/NNN-data_architect.md
- Skills: data-design
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 2
- Timeout: 1800 s
- Stop condition: Stops when design/DATA.md and the PLAN Data text cover every schema and data change with a reversible or approved migration plan, or at the first requirement-level question.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | xhigh |
| balanced | opus | gpt-6-astra | high |
| economy | sonnet | gpt-6-sol | high |

## designer

Designs the user interface for a task, writing the PLAN UI section and the per-task UI spec, and keeps the durable design system consistent.

- Name: Designer
- Agent: proofline-designer
- Dispatched: when the task changes a user interface, or on request (proofline design ui)
- Reads: TASK.md EVIDENCE.md design/INTENT.md repo
- Owns: design/ /DESIGN.md
- Skills: ui-design
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 1
- Timeout: 1800 s
- Stop condition: Stops when design/UI.md and the PLAN UI section text cover every UI-facing acceptance criterion, or at the first requirement-level question.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | high |
| balanced | sonnet | gpt-6-sol | medium |
| economy | sonnet | gpt-6-sol | low |

## explorer

Investigates one bounded assignment and returns compact evidence where every claim is a verified path and symbol.

- Name: Explorer
- Agent: proofline-explorer
- Dispatched: class STANDARD and up, in parallel up to the class max_explorers bound for independent objectives
- Reads: TASK.md repo
- Owns: reports/NNN-explorer.md
- Skills: evidence-map
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 1
- Timeout: 900 s
- Stop condition: Stops when the assignment's expected output is complete or its stop condition is met, whichever comes first.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | medium |
| balanced | sonnet | gpt-6-sol | medium |
| economy | haiku | gpt-6-luna | low |

## implementer

Implements the frozen plan inside its scope with recorded RED, GREEN and REFACTOR evidence, and fixes bounded findings.

- Name: Implementer
- Agent: proofline-implementer
- Dispatched: always, the only role that writes product code, one per run
- Reads: TASK.md EVIDENCE.md PLAN.md QA_PLAN.md repo
- Owns: PRODUCT_SCOPE reports/NNN-debug.md
- Skills: tdd-proof debug-proof
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Edit Write
- Sandbox: workspace-write
- Tier floor: 2
- Timeout: 3600 s
- Stop condition: Stops when every non-exempt scope path has valid RED and GREEN evidence and the assignment's tests pass, or at the first need outside frozen scope.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | high |
| balanced | sonnet | gpt-6-sol | high |
| economy | sonnet | gpt-6-sol | medium |

## lead

Owns the task lifecycle as the main session, classifying, freezing, dispatching bounded specialists, consolidating their results, driving gates and the fix loop, and stopping before delivery.

- Name: Lead
- Agent: none (main session)
- Dispatched: always, the main session (alias full_lifecycle)
- Reads: RUN.yaml TASK.md EVIDENCE.md PLAN.md results/ gates/ questions/
- Owns: TASK.md EVIDENCE.md PLAN.md COMPLETION_REPORT.md amendments/ /.agents/tasks/
- Skills: proofline-lead plan-contract debug-proof
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 2
- Timeout: 3600 s
- Stop condition: Stops at every stop point (a specialist question, a destructive operation, a scope change, commit or push or PR) and after cleanup reports DONE, FAILED or BLOCKED.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | xhigh |
| balanced | opus | gpt-6-astra | high |
| economy | sonnet | gpt-6-sol | medium |

## qa

Writes the acceptance and adversarial QA plan before implementation and evaluates the implementation against the frozen plan after it.

- Name: QA
- Agent: proofline-qa
- Dispatched: class STANDARD and up, plan step before FREEZE and report step once IMPLEMENTED
- Reads: TASK.md EVIDENCE.md PLAN.md QA_PLAN.md diff repo
- Owns: QA_PLAN.md QA_REPORT.md reviews/test-trust/qa/ reports/NNN-qa.md reports/qa-evidence/
- Skills: qa-plan test-trust
- Gates: QA
- Result protocol: gate
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 1
- Timeout: 1800 s
- Stop condition: Stops after writing QA_PLAN.md (plan step) or after one QA result on the current fingerprint (report step).

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | high |
| balanced | sonnet | gpt-6-sol | medium |
| economy | sonnet | gpt-6-sol | medium |

## reviewer

Independently reviews the task-owned diff for one focus (plan, rules, tests, data, or rules+tests) and returns an evidence-based gate result.

- Name: Reviewer
- Agent: proofline-reviewer
- Dispatched: per tier (D14), small tier one reviewer with focus rules+tests, full tier one reviewer per focus plan rules tests and data when PLAN.md has a Data section
- Reads: TASK.md PLAN.md EVIDENCE.md QA_PLAN.md diff repo
- Owns: reviews/proof-review/plan/ reviews/proof-review/rules/ reviews/proof-review/small/ reviews/test-trust/tests/ reviews/data-design/REVIEW.md
- Skills: proof-review test-trust data-design
- Gates: REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA REVIEW_SMALL
- Result protocol: gate
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 2
- Timeout: 1800 s
- Stop condition: Stops after one result for the assigned focus on the current fingerprint, without repairing anything.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | xhigh |
| balanced | sonnet | gpt-6-sol | high |
| economy | sonnet | gpt-6-sol | medium |

## security_reviewer

Reviews the task-owned diff as an attacker and reports only exploitable findings, each reproduced or traced from source to sink.

- Name: Security Reviewer
- Agent: proofline-security-reviewer
- Dispatched: full tier (D14), always for CRITICAL class
- Reads: TASK.md PLAN.md EVIDENCE.md diff repo
- Owns: security/
- Skills: exploit-proof
- Gates: SECURITY
- Result protocol: gate
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 3
- Timeout: 2400 s
- Stop condition: Stops after one SECURITY result on the current fingerprint, without repairing anything.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | xhigh |
| balanced | opus | gpt-6-astra | high |
| economy | opus | gpt-6-astra | high |

## task_author

Turns a one-sentence request or an imported issue into a standard task with testable acceptance criteria, grilling intent first when the request is vague or large.

- Name: Task Author
- Agent: proofline-task-author
- Dispatched: when no task exists, or an imported task lacks canonical fields, intent-grill first for COMPLEX or CRITICAL requests or on request
- Reads: request repo
- Owns: TASK.md design/INTENT.md reports/NNN-task_author.md /.agents/tasks/
- Skills: task-author intent-grill
- Gates: none
- Result protocol: task
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 1
- Timeout: 1200 s
- Stop condition: Stops when TASK.md passes the task-author self-check, or after one NEEDS_INPUT round of open questions.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | high |
| balanced | sonnet | gpt-6-sol | medium |
| economy | haiku | gpt-6-luna | low |

## verifier

Proves mechanically that the frozen plan is implemented and that design documents still match the code.

- Name: Verifier
- Agent: proofline-verifier
- Dispatched: always, every class, once the run is IMPLEMENTED
- Reads: TASK.md PLAN.md QA_PLAN.md worker-evidence/ diff repo
- Owns: VERIFY.md design/SYNC.md
- Skills: verify-proof design-sync
- Gates: VERIFY
- Result protocol: gate
- Tools: Read Grep Glob Bash Write Edit
- Sandbox: workspace-write
- Tier floor: 1
- Timeout: 1800 s
- Stop condition: Stops after one VERIFY result on the current fingerprint, without changing the implementation.

| Profile | Claude model | Codex model | Effort |
|---|---|---|---|
| max | opus | gpt-6-astra | high |
| balanced | sonnet | gpt-6-sol | medium |
| economy | haiku | gpt-6-luna | medium |
