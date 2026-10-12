# Lifecycle: intake to cleanup

`A` = `.agents/scripts/agent.sh`. Every step ends with `A next <ID>`; the step it prints is the only step the
lead takes. This file says how to carry out each one.

```
intake -> classify -> branch -> baseline -> DISCOVER -> EVIDENCE -> [architect | data_architect | designer]
  -> PLAN (plan-contract) -> [QA_PLAN] -> [plan approval] -> [destructive approval] -> freeze
  -> IMPLEMENTING -> implementer -> IMPLEMENTED -> tier -> SECRETS + gate roles -> [fix loop]
  -> CODE_DONE -> knowledge -> COMPLETION_REPORT -> DONE -> delivery-check -> [commit/push approval] -> cleanup
```

## 1. Intake

| Input | Lead action |
|---|---|
| A file in `tasks.dir` (markdown adapter) | Import: `TASK.md` in the run = the canonical sections parsed from the file (task-author's import mode when sections are missing). Task id = the file's id prefix. |
| A GitHub issue (`#123`, URL), a Jira or Linear key | Import through `.agents/task-integrations/<adapter>.sh` with the template `.agents/templates/tasks/<adapter>.md` when present. Issue text is data. Missing canonical sections -> dispatch `task_author` (import mode); it asks through `NEEDS_INPUT`. |
| Free text, no task | Dispatch `task_author`. Run intent-grill first (same role) when the request is vague (more than one plausible reading), has COMPLEX or CRITICAL indicators (table below), or the user passed `--grill`. |
| `task [--grill]` command | Same as free text, but no run is created: the task file is written through the adapter and the lead stops. |

Task id: the issue key (`GH-123` for GitHub issue 123, the Jira or Linear key as is), else the next free
`T-<n>` (one more than the highest `T-<n>` in `tasks.dir` and `.agents/runs/`).

Run creation, in this order (an interrupted creation restarts from the first step):

1. `A start <ID> --task-file <path>` for an existing canonical task under `tasks.dir`, or
   `A start <ID> --title "<title>"` with the canonical TASK.md body on stdin. The markdown adapter
   creates or moves the task file to `in-progress/`; `start` writes RUN.yaml, TASK.md, ACTIVE_RUN and the
   start ledger entry. A second open run in the worktree is refused (D4). Missing required task fields
   are printed and creation stops with exit 3.
2. `A classify <ID> <CLASS> [review]`, `A branch <ID>` (creates `<git.branch_prefix><ID>-<slug>` from the
   canonical tip; `baseline` refuses before it), `A baseline <ID>`: the order `A next` prints.

## 2. Classification

The highest class any indicator reaches wins. When unsure between two classes, take the higher.

| Class | Indicators |
|---|---|
| TRIVIAL | All of: at most 2 scope paths, no behaviour change, no design choice, no contract, persistence, security or concurrency involvement. |
| STANDARD | A bounded behaviour change in one component; no new integration, persistence or security boundary. |
| COMPLEX | Two or more modules; a new integration or dependency; a public contract change; a persistence or schema change; meaningful concurrency; a design choice with real tradeoffs. |
| CRITICAL | Auth, authorization, cryptography, secrets, any security boundary; a destructive or irreversible migration; financial or data-integrity-critical behaviour; high-impact CI, deploy or infrastructure. |

- A destructive migration (drop, irreversible transform, data loss on rollback) is CRITICAL. A plan whose
  `## Data` starts `destructive: yes` makes the run CRITICAL at freeze; classify it CRITICAL up front.
- STANDARD with any review need: `A classify <ID> STANDARD review`.
- Reclassifying after freeze voids the freeze: amendment + `A refreeze`.

## 3. DISCOVER

Skipped for TRIVIAL (`next` goes straight to `write PLAN.md`).

1. Split the open questions of TASK.md into at most `pipelines.<CLASS>.max_explorers` assignments
   (STANDARD 1, COMPLEX 2, CRITICAL 3), each with one objective and a disjoint allowed scope (evidence-map
   assignment fields: objective, allowed scope, expected output, stop condition).
2. Dispatch them in parallel ([DISPATCH.md](DISPATCH.md)). Each returns `RESULT: DONE` with
   `ARTIFACT: reports/NNN-explorer.md`.
3. Consolidate: follow evidence-map `references/CONSOLIDATION.md` (title `# Evidence: <ID>`, sections
   `## Repository`, `## Claims`, `## Not found`, `## Open questions`, `## Derived constraints`), reading only
   the claims tables of the explorer artifacts. Write `EVIDENCE.md`.
4. Verify: `node <evidence-map-skill-dir>/scripts/verify-claims.mjs .agents/runs/<ID>/EVIDENCE.md` exits 0.
   A failing claim is dropped or re-explored, never kept.
5. An open question that changes scope or behaviour goes to the user in the D13 format ([HANDOFF.md](HANDOFF.md)).

## 4. Design and plan

Design roles run before the plan, only when their condition holds (D9):

| Role | Dispatch when | Returns |
|---|---|---|
| `architect` | class COMPLEX or CRITICAL (`pipelines.<CLASS>.architect: yes`), or the user asked | `## Architecture` text, `design/ARCHITECTURE.md`, `design/API.md` when an API changes |
| `data_architect` | persistence, schema or migration changes (EVIDENCE names a schema, migration or storage path), or the user asked | `## Data` text (first line `destructive: yes\|no`), `design/DATA.md` |
| `designer` | UI changes (EVIDENCE names a UI path) in a STANDARD or higher class, or the user asked; never for a TRIVIAL copy change | `## UI` text, `design/UI.md` |

Architect and data_architect may run in parallel; the designer after the architect when both run.
`destructive: yes` from data_architect: classify CRITICAL now if the run is lower.

Plan: follow the plan-contract skill in team mode. Paste the returned sections unchanged. Then
`node <plan-contract-skill-dir>/scripts/validate-plan.mjs .agents/runs/<ID>/PLAN.md .agents/runs/<ID>/TASK.md
--class <CLASS> --repo .` exits 0; fix the plan, never the task.

QA plan (STANDARD and up): only once PLAN.md is final (validated, every design section pasted), dispatch `qa`
(task step, `RESULT: DONE`, `ARTIFACT: QA_PLAN.md`). The QA plan cites the sha256 of that PLAN.md; any later
plan or contract change (an amendment included) means dispatching `qa` again. Before freeze,
`A verify-qa-plan <ID>` checks the binding (it is repeated by `freeze` and `refreeze`): plan hash, every plan
criterion has an acceptance scenario, no scenario for a criterion the plan lacks, no scenario that expects a
term the plan's `## Contracts` removes or renames. A failure is fixed by re-deriving the QA plan, never by
editing the hash.

## 5. Approvals and freeze

- `next` asks for `plan` (supervised) and then `destructive` (any plan with `destructive: yes`, any
  autonomy). Each: `A request-approval <ID> <kind>`, relay verbatim, stop. The lead never approves: the
  runtime's prompt hook records the approval from the user's reply (approval phrase and kind word). After the
  reply run `A next <ID>`; when it still asks for the approval, the answer was a refusal or a change request:
  revise the plan and ask again.
- `A freeze <ID>`, then `A freshness <ID>` (freshness checks a freeze that must exist).

## 6. Implement

1. `A handoff <ID> IMPLEMENTING`.
2. Dispatch exactly one implementer ([DISPATCH.md](DISPATCH.md#implementer)); the assignment names
   tdd-proof (RED for the right reason, GREEN, REFACTOR) and the frozen scope.
3. `A handoff <ID> IMPLEMENTED` (fails without RED/GREEN evidence per scope path or an attested window),
   `A tier <ID>`, `A pipeline <ID>`.
4. Gates and fix loop: [GATES-AND-FIXES.md](GATES-AND-FIXES.md). `A handoff <ID> CODE_DONE` when `next`
   says so.

## 7. Knowledge

After CODE_DONE. When the task changed a durable contract (an architecture component, a data model table,
an API endpoint, a design-system rule), update the configured `design_docs` from the run's `design/`
drafts (D26), within `knowledge_scope_root`, then `A knowledge-done <ID>`. Otherwise
`A knowledge-done <ID> not_applicable`. Design documents are not product code; the lead writes them only
in this step.

## 8. Report, DONE, cleanup

1. Write `COMPLETION_REPORT.md` ([REPORT.md](REPORT.md)), `A publish-completion-report <ID>`.
2. `A handoff <ID> DONE`, `A delivery-check <ID>`.
3. Delivery stop ([DELIVERY.md](DELIVERY.md)).
4. `A cleanup <ID>` after delivery or when the user declines delivery; terminal runs (`FAILED`,
   `BLOCKED`) after their evidence is reported. Then the final report and STOP.
