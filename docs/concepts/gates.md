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
| `REVIEW_DATA` | tier full and plan has `## Data` | reviewer |
| `SECURITY` | tier full | security reviewer |
| `QA` | class STANDARD and up | QA |
| `VERIFY` | always | verifier |

Status per gate: `pass`, `pass_low` (a PASS with `CONFIDENCE: low` does not count; re-run with a stronger model),
`waived`, `fail`, `stale`, `missing`. `agent.sh pipeline <ID>` prints them.

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
