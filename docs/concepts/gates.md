# Gates

Gates decide whether a change holds. Each gate record binds the content fingerprint (a git tree id), the
task-owned patch and the frozen hashes. If one byte changes, earlier passes go stale. Verdicts are computed from
the reviewer's recorded result by script; the lead cannot write or waive one.

## Class and tier

The **class** (TRIVIAL to CRITICAL) decides which gates are mandatory. The **tier** decides review depth and is
computed from the diff by `agent.sh tier`, never from the lead's claim.

| Tier | Condition | Review |
|---|---|---|
| `docs` | only plain documentation (`.md .mdx .rst .adoc .txt`), no risky path, not code-like Markdown | secret scan only |
| `small` | within `review.small_max_files` / `review.small_max_lines`, no risky path | one reviewer, focus `rules+tests` |
| `full` | everything else; CRITICAL is always full | plan, rules, tests, data (if the plan has `## Data`), security, in parallel |

Risky paths (migrations, auth, security, payment, crypto, CI and deploy, dependency manifests, infrastructure)
come from `review.risky_paths`. Code-like Markdown (`.agents/**`, `skills/**`, `roles/**`, agent definitions,
`AGENTS.md`, `CLAUDE.md`, prompt files) is never docs. The tier never decreases within a run.

## Gate set

| Gate | Required when | Recorded by |
|---|---|---|
| `SECRETS` | always | `agent.sh secret-scan` (script) |
| `REVIEW_SMALL` | tier small | reviewer |
| `REVIEW_PLAN`, `REVIEW_RULES`, `REVIEW_TESTS` | tier full | reviewer |
| `REVIEW_DATA` | tier full and plan has `## Data`, or a migration in the diff | reviewer |
| `SECURITY` | tier full | security reviewer |
| `QA` | class STANDARD and up | QA |
| `VERIFY` | always | verifier |

Status per gate: `pass`, `pass_low` (a PASS with `CONFIDENCE: low` does not count; re-run with a stronger model),
`waived`, `fail`, `stale`, `missing`. `agent.sh pipeline <ID>` prints them.

## Risk signals

Besides class and tier, deterministic risk signals choose extra checks, each a focus inside an existing gate
(decision A78; table in `.agents/GATES.md`). A signal comes from a changed or planned path (contract files,
migrations, UI files, dependency manifests, config and env files), from text the diff adds (optional, off by
default), or from a flag the architect or data architect writes into PLAN.md (`## Risk`: `contract_change`,
`concurrency`, `performance_critical`; `## Data`; `## UI`). The checks: REVIEW focuses `contract`,
`concurrency`, `performance`, `config`; REVIEW_DATA `migration`; QA `visual` (the visual-proof skill, A82); SECURITY `dependencies`.

- `agent.sh pipeline <ID>` shows every signal, its source, the check it triggers and why. Before FREEZE the
  signals of the planned scope are visible, so the right design role declares the flag.
- A signal in the diff without its plan flag (a contract file changed, `contract_change` not set) is a
  blocking finding of that focus, and the check still runs.
- A gate passes only when its own focus and every risk focus it carries pass.
- A check whose skill or tool is missing is `UNSUPPORTED`: never a PASS, waivable only by the user, and listed
  in the completion report.
- The `concurrency` focus runs the concurrency-proof skill (A86): a finding is a traced interleaving (two or
  more actors, `file:line` per step) or a concurrent reproduction in the project's own test runner; PASS
  means no proven problem, never that the code is free of races; unproven risks are listed separately, and a
  reproduction the project cannot run is stated as UNSUPPORTED inside the result.
- The mapping lives in `.agents/config.yaml` and is frozen with the plan; the lead cannot change it during a run.

Other FAIL rules: a failing test that also fails at the base in a clean worktree is reported as pre-existing;
a new dependency not named in the plan is a FAIL; so is a change to a versioned contract the plan does not name.

## Fix loop

A FAIL goes back to the implementer (same worktree). Each round carries the previous findings; only gates made
stale by the change re-run. `review.max_fix_rounds` defaults to 2 and round 2 escalates to a stronger model.
If findings remain after the last round the run ends `terminate FAILED`, commit and push stay locked, and the
lead reports what remains. There is never an endless loop.

## Waivers

Security and secret findings can never be waived. Another blocking finding is waived only by the user's explicit
message, finding by finding, with a specific reason (at least 20 characters). The waiver is ledgered and listed
in the completion report; `review.waiver_followup: task` also creates a follow-up task per waiver.

## Approvals

Kinds: `plan`, `destructive`, `scope`, `budget`, `commit`, `push`, `waive:<FINDING-ID>`. The lead requests an
approval with `agent.sh request-approval`; the answer counts only if it comes from a terminal you typed in or from a
prompt your runtime captured after the request. Approvals are single-use and ledgered as `answered_by: user`.
Commit and push need both a gate pass for the current content and your approval in the current message;
`push_requires_approval` is `true` by default.

Related: [workflow](workflow.md), [enforcement layers](enforcement-layers.md).
