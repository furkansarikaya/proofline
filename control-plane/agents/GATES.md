# Gates, tiers, fix loop, waivers, approvals

## Tier (D14)

`agent.sh tier <ID>` computes the tier from the task-owned diff (`repository.base_sha` → working tree,
untracked files included; excluded: the run directory, `.agents/local/`, `tasks.dir`, and baseline files
whose content is unchanged).

| Tier | Condition |
|---|---|
| `docs` | Every changed path is plain documentation by extension (`.md .mdx .rst .adoc .txt`) and matches neither `review.risky_paths` (e.g. `requirements.txt`) nor `review.code_like_markdown`; a directory never makes a file documentation (`docs/conf.py` is code) |
| `small` | ≤ `review.small_max_files` files, ≤ `review.small_max_lines` added+deleted lines, no path matches `review.risky_paths`; a binary file counts as large |
| `full` | Everything else |

- CRITICAL is always `full`. A class with `review: yes` (or STANDARD with `classify ... review`) is at least `small`.
- The effective tier is the maximum of the computed tier and the recorded `pipeline.tier`. The lead records
  it with `tier`, at `handoff IMPLEMENTED` and at `CODE_DONE`. It never decreases within a run.
- Globs: `**` spans directories, `*` and `?` stay in one segment, a pattern without `/` matches at any depth.

## Gate set

| Gate | Required when | Recorded by |
|---|---|---|
| `SECRETS` | always | `agent.sh secret-scan <ID>` (script; never waivable) |
| `REVIEW_SMALL` | tier small | reviewer, FOCUS `rules+tests` |
| `REVIEW_PLAN`, `REVIEW_RULES`, `REVIEW_TESTS` | tier full | reviewer, FOCUS `plan`, `rules`, `tests` |
| `REVIEW_DATA` | tier full and PLAN.md has `## Data` | reviewer, FOCUS `data` |
| `SECURITY` | tier full | security_reviewer (never waivable) |
| `QA` | class STANDARD and up | qa (RESULT PASS/FAIL) |
| `VERIFY` | always | verifier |

`agent.sh pipeline <ID>` prints class artifacts, the tier, the required gates and `gate.<GATE>=<status>`:

| Status | Meaning |
|---|---|
| `pass` | the latest record passes for the exact current content (fingerprint) and its artifact is unchanged |
| `pass_low` | the latest record is a PASS with `CONFIDENCE: low`: it does not count; re-run with escalation |
| `waived` | the latest record is a FAIL whose every blocking finding is waived: it counts |
| `fail` | the latest record is a FAIL on the current content |
| `stale` | the latest record is for other content, an edited artifact, another frozen contract or a forged role |
| `missing` | no record since the last reopen |

Gate records (`gates/NNN-<GATE>.yaml` + `.manifest`) bind the content fingerprint, the task-owned patch,
the frozen hashes, the pipeline, the author role, the artifact sha256 and the raw result sha256. Gates have
no order and run in parallel; several gates may record on the same content.

Provenance: a gate record, waiver or approval counts only when the command that writes it (`record`, `gate`,
`secret-scan`, `amend`, `waive`, `approve`) bound `<dir>/<file>@<sha256>` in a ledger entry of its own event.
A hand-written or later edited file is ignored by every evaluation; `validate` names unbound gate records and
waivers.

## CODE_DONE and after

`handoff CODE_DONE` needs every required gate `pass` or `waived` for the current content fingerprint.
After CODE_DONE the knowledge step and the report publication change the tree, so DONE, `delivery-check`,
`validate` and `verify-handoff` check the gates against the task-owned patch instead.

## Fix loop (D15)

- A fix round is one content that collected an unwaived blocking FAIL (under the current frozen contract,
  since the last reopen). `handoff <ID> IMPLEMENTING` from IMPLEMENTED (lead only) opens it while
  rounds used ≤ `review.max_fix_rounds` (default 2).
- The fix MUST change the tree and stay inside the union `fix_scope` of the failing content's records
  (finding paths; a finding without a path allows any frozen scope path).
- Round 2 sets `escalation=yes` in `pipeline` and the `fix_round_2` signal in `decide`.
- After the last round with open findings: only `terminate <ID> FAILED` (stdin `reason`, `evidence`).
  Commit and push stay locked because the gates never pass. Nothing resets the budget on the lead's
  word: a refreeze of a run whose budget is exhausted requires a `budget` approval (the user's explicit
  instruction) bound to the amended PLAN.md.
- Any change makes every earlier pass `stale`; `next` lists exactly the gates that are not `pass`/`waived`.
- An amendment that changes a frozen artifact starts a fresh budget (after exhaustion only with the
  `budget` approval above).

## Waivers (D16)

`agent.sh waive <ID> <FINDING-ID> --reason TEXT` (lead only) succeeds only when:
1. the finding is a blocking finding of a `fail` gate on the current content;
2. its gate is not `SECRETS` or `SECURITY` (`request-approval` refuses those too);
3. the reason is specific (≥ 20 characters);
4. an unconsumed `waive:<FINDING-ID>` approval exists, bound to that failing gate record (file name and
   sha256) and finding id, granted by a user prompt newer than the gate record; a later round's finding
   with the same id is another record and needs a new approval.

At evaluation a FAIL counts as `waived` only through ledger-bound waivers naming the record, its sha256 and
each blocking finding; waivers of SECRETS or SECURITY findings never count.

The waiver is written to `waivers/NNN-<FINDING-ID>.yaml`, ledgered, consumes the approval and must appear
in the completion report `## Waivers`. With `review.waiver_followup: task` a follow-up task file is written
next to it and passed to `.agents/task-integrations/<tasks.adapter>.sh followup <ID> <file>` when the adapter
exists (receipt recorded; `pending` otherwise).

## Approvals (D3)

Kinds: `plan`, `destructive`, `scope`, `budget` (bound to the PLAN.md sha256), `commit`, `push` (bound to
the content fingerprint), `waive:<FINDING-ID>` (bound to `<gate record>@<sha256>#<FINDING-ID>`).

1. `agent.sh request-approval <ID> <KIND>` records the request time and binding and prints the D13 question.
   The lead relays it verbatim.
2. `agent.sh approve <ID> <KIND>` accepts the user's answer from:
   - an interactive terminal (stdin and stdout are TTYs): the typed line; or
   - the newest prompt capture `.agents/local/prompts/<session>.json`, written by a runtime hook on every
     user prompt, exactly one JSON object:
     `{"session":"<id>","time":<epoch seconds>,"sha256":"<hex sha256 of text>","text":"<prompt>"}`.
     It is accepted only when `time` is later than the request, `sha256` matches the unescaped `text`, the
     text contains an `approval.phrases` entry and a kind word (`plan`, `scope`, `commit`, `push`,
     `destructive|migration|delete|drop`, `budget|round|rounds`, or the finding id), and that prompt has not
     granted the same kind before. The capture, and every approval request and approval file, must be a
     regular file (not a symlink) with one hard link, and no directory between the project root and it may
     be a symlink; otherwise `approve` and `answer` refuse every capture and the approval is not found.
3. Approvals are single-use: `freeze`/`refreeze` (plan, destructive, scope, budget), `waive`, and the git hooks
   through `agent.sh approval-consume <ID|-> <commit|push> [FINGERPRINT]` (exit 0 = consumed) consume them.
   `-` is the no-run scope (commit and push only, kept in `.agents/local/approvals/`).

Where approvals are required: supervised freeze (`plan`), a `destructive: yes` plan at freeze/refreeze
(`destructive`, any autonomy), a refreeze adding scope paths (`scope`), a refreeze after the fix budget is
exhausted (`budget`), each waiver, each commit and push.
Every approval is ledgered with `answered_by: user`.
