# Roles

Each role is defined once in `roles/<id>.md`; `adapters/generate.sh` renders the Claude Code agents, the
Codex agents and the prompt prefixes from it. The full generated table is in [the roles reference](../reference/roles.md).

| Role | Does | Skills | When |
|---|---|---|---|
| `lead` | Owns the lifecycle; the only role that changes task state or declares DONE | proofline-lead, plan-contract, debug-proof | always (the main session) |
| `task_author` | Turns a request into a standard task | task-author, intent-grill | no task exists |
| `explorer` | Bounded investigation, compact verified evidence; impact mode: what a change reaches | evidence-map | not TRIVIAL |
| `architect` | System and API design, ADRs | system-design, api-design | COMPLEX, CRITICAL or on request |
| `data_architect` | Data model and migration plan | data-design | persistence changes or on request |
| `designer` | UI design and `docs/design/DESIGN.md`; marks which criteria need visual proof; never approves its own design (A81) | ui-design | UI changes or on request |
| `qa` | QA plan before, QA report after; the visual focus on UI runs | qa-plan, test-trust, visual-proof | STANDARD and up |
| `implementer` | The frozen plan with RED/GREEN evidence | tdd-proof, debug-proof | always |
| `reviewer` | One focus: plan, rules, tests, data (or rules+tests on the small tier), or a risk focus (contract, concurrency, performance, config, migration) | proof-review, test-trust, data-design, concurrency-proof, performance-proof, contract-proof | per tier |
| `security_reviewer` | Exploitable findings only | exploit-proof | full tier |
| `verifier` | Mechanical proof the plan is implemented; design drift | verify-proof, design-sync | always |

## Rules every role follows

- No swarm, no recursion: only the lead dispatches; specialists never spawn agents.
- Communication is lead, bounded assignment, specialist, owned artifact plus a structured result, lead.
- Results start with a fixed header (`ROLE`, `TASK`, `RESULT`, `CONFIDENCE`, `FINGERPRINT`, `ARTIFACT`). A hook or `agent.sh record` parses and stores it; the lead can never write a verdict.
- A specialist that needs the user returns `RESULT: NEEDS_INPUT` with numbered questions; the lead relays them verbatim and never answers for the user.
- A role writes only the paths it owns (`owns.conf`); only the implementer writes product code. It checks first (needed, already in the codebase, in the standard library, in an installed dependency, then minimum code), marks a deliberate shortcut with a `shortcut: <limit>, <when to improve>` comment (`proofline debt` lists them) and lists out-of-scope issues it saw under `## Observations` instead of fixing them.

## Choosing runtime and model

`runtime.lead`, `runtime.worker` and `runtime.reviewers` in `.agents/config.yaml` pick `claude` or `codex`
per role group, so "Claude only", "Codex only" and mixes use one structure. Profiles `max`, `balanced`
(default) and `economy` set model and effort per role. Every routing decision is written to the run ledger.

## The lead model

A cheap model can follow the route poorly, most of all as lead. Give the lead a base-level model. `exec-policy.sh check-lead` and the end-to-end harness refuse a Codex lead below the base model or without a model. `proofline doctor` fails on a resolved model below base, and only warns when it cannot resolve the model. No other runtime has a base model, so choose the lead model yourself.

Role source format: [roles/README.md](../../roles/README.md). Related: [workflow](workflow.md), [gates](gates.md).
