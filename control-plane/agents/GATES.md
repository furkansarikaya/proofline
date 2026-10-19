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
| `REVIEW_DATA` | tier full and PLAN.md has `## Data`, or a `migration` risk signal | reviewer, FOCUS `data` |
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
`secret-scan`, `amend`, `reopen`, `waive`, `approve`) bound `<dir>/<file>@<sha256>` in a ledger entry of its own event.
A hand-written or later edited file is ignored by every evaluation; `validate` names unbound gate records and
waivers.

## Risk signals and focuses (A78)

Deterministic risk signals add focuses inside the gates above; they never add a gate type. Config `risk:`
(`.agents/config.yaml`) maps each signal to one focus:

| Signal | Source | Declared by (PLAN.md) | Focus | Gate |
|---|---|---|---|---|
| `contract_file` | changed or planned path (OpenAPI, AsyncAPI, Swagger, proto, GraphQL, Avro, JSON Schema files), or added text `^(openapi\|asyncapi\|swagger):`, `"$schema"`, `^syntax = "proto` | `## Risk` `contract_change: yes` | `contract` | REVIEW_RULES (REVIEW_SMALL on tier small) |
| `migration` | path under `migrations/`, `migration/`, `db/migrate/`, `alembic/versions/`, or `*.sql` | a `## Data` section | `migration` | REVIEW_DATA |
| `ui_path` | `*.html *.css *.scss *.jsx *.tsx *.vue *.svelte` and similar | a `## UI` section | `visual` | QA |
| `dependency_manifest` | a dependency manifest or lock file | none (`## Dependencies` is checked by the focus) | `dependencies` | SECURITY |
| `config_env` | `.env*`, `config/*.yaml`, `*.ini`, `*.properties`, `appsettings*.json` | none | `config` | REVIEW_RULES / REVIEW_SMALL |
| `concurrency_hint`, `performance_hint` | text the diff adds (`content`, off by default) | `concurrency: yes`, `performance_critical: yes` | `concurrency`, `performance` | REVIEW_RULES / REVIEW_SMALL |
| flags `contract_change`, `concurrency`, `performance_critical`, `destructive`, `ui` | PLAN.md | itself | as above (`destructive` adds `migration`) | as above |

Plain documentation (`.md .mdx .rst .adoc`) and `.agents/` never carry a path or content signal. A check runs
only when its gate is required for the class and tier (TRIVIAL has no QA gate, so no `visual` check). A TRIVIAL run has no design phase either: its UI signals print `check=- (class TRIVIAL: no design phase / no QA gate)` and `design_role=-`, and ask for no `ui` flag, no `## UI` section and no designer (A96). A
migration path signal is a risky path, so the tier is full and REVIEW_DATA exists to carry it. A flag set to
`yes` requires its check whether or not the diff carries the signal.

- **Pipeline.** `agent.sh pipeline <ID>` prints `signals=`, one `signal.<name>=source=<diff|scope|plan>:<what>(<why>)
  check=<GATE>:<focus> flag=<flag>:<yes|no> design_role=<role>` per signal, `missing_flag.<name>=` lines,
  `focus.<GATE>.<focus>=<status>` per risk focus, `design_role.<role>=` and `unsupported.<GATE>:<focus>=` lines.
  Signals are computed from the PLAN.md scope before FREEZE, so `next` dispatches the design role
  (architect, data_architect, designer) that must declare a flag.
- **Gate status.** A gate is the worst status over its own focus and every risk focus it carries; it cannot
  be `pass` while a required focus result is missing, stale or failing. A focus recorded `unsupported` (A98)
  does not hold its gate open, is never `pass`, and its gate record carries `unsupported: "<focus>"`.
- **Missing flag.** A diff signal whose flag PLAN.md does not set to `yes` makes `record` add a blocking finding
  (`risk signal <name> without PLAN.md flag <flag>`) to that focus's result, whatever the reviewer found; the
  check still runs. Fix: amend PLAN.md (the design role declares the flag) and refreeze, or the user waives it.
- **UNSUPPORTED.** A risk focus whose skill or tool is missing is submitted with `--result UNSUPPORTED --reason
  "<what is missing>"`. It is never a PASS (A98): with `risk.unsupported: report` (default) it is recorded as an
  `info` row `UNSUPPORTED <focus>: <reason>`, the focus is `unsupported` (unproven, reported), the gate closes
  when its other focuses pass, and `pipeline`/`next` print `UNSUPPORTED (unproven, reported)`. It is a blocking
  finding only the user can waive (never for SECURITY) under `risk.unsupported: block` (the A78 rule) and, in
  both modes, when the reason is an INCONCLUSIVE measurement (`performance INCONCLUSIVE: ...`,
  `visual INCONCLUSIVE: ...`). A defect found by the part that could be checked is a FAIL; UNSUPPORTED rows in a
  FAIL stay blocking. The completion report needs `## Unsupported Checks` with one line per `<GATE>:<focus>`
  that names it and says `not proven: <what>` (three words at least). The reason must be concrete (at least 12
  characters with a path, an `INCONCLUSIVE:` measurement or a tool/capability word; `n/a` is refused). A gate that
  closes with an unsupported focus shows `gate.<GATE>.unsupported=<focus,...>` in `pipeline` and
  `<GATE>: pass (unsupported: <focus,...>)` in `summary`; `next` tells the lead to surface them to the user. The `dependencies` focus always has a tool-free check and refuses UNSUPPORTED; so do `concurrency` and `config` (A102).
  **Evidence (A102).** A reason alone is refused: UNSUPPORTED also needs `--evidence <file>`, the skill
  validator's own output saved in the focus's report folder or `reports/` (`submit` snapshots it like the
  report, A43). `record` refuses it unless the file holds the validator's `RESULT: UNSUPPORTED` line (visual:
  or `INCONCLUSIVE`) and its sha256 is the one cited; a printed `BASE:` must be the run's base. Cross-checks on
  the script's own signals: every contract file `risk_compute` found in the diff must appear in contract-proof's
  `FILE: compared|unsupported <path>` lines with at least one unsupported, and every changed `.sql` migration
  must appear as `FILE: unsupported <path>` in `validate-migration.mjs --repo` output. The gate record keeps
  `unsupported_evidence: <path>@<sha12>` (the record turns stale if the file changes), and `pipeline` and `next`
  print it. The evidence must be the submitting role's own file (its focus folder, its
  `reports/snapshots/<sha12>-<role>-...` snapshot or `reports/<NNN>-<role>...`). An INCONCLUSIVE in the evidence
  (visual `RESULT: INCONCLUSIVE`, performance `reason: performance INCONCLUSIVE:`) needs a reason starting
  `<focus> INCONCLUSIVE:` (it stays blocking), and an UNSUPPORTED evidence refuses an INCONCLUSIVE-prefixed
  reason. Capability probes that only refuse: `visual` UNSUPPORTED is refused when a Chromium-family browser is on
  PATH or in the standard macOS application folders, or a project browser-test dependency is installed (the lists
  of visual-proof's `measure.mjs --detect`); `performance` UNSUPPORTED when the project has a benchmark command (a
  package.json script `bench`/`benchmark`/`perf*`, a Makefile or justfile `bench`/`benchmark` target, cargo
  `benches/`, a Go `func Benchmark`, asv or pytest-benchmark, JMH, BenchmarkDotNet); a benchmark that cannot
  reach the change is then BLOCKED for the user. The self-test switch `PROOFLINE_PROBE_ROOT` needs
  `PROOFLINE_SELFTEST=1` outside a runtime session, and the hook refuses a model command naming either. Residual: non-SQL migrations (`.py`, `.js`, `.rb`) have no
  `FILE:` cross-check, and a deliberately fabricated evidence file is caught only by reading it. The
  `contract` focus has contract-proof (A83): UNSUPPORTED only for a changed contract file it cannot parse that no
  compatibility tool already present covers, or when node is missing.
- **Frozen.** PLAN.md flags are frozen with `plan_sha256`; the `risk:` block, the performance thresholds (`performance:`, A87) the non-empty `security.*` keys (A88) and the `contract:` globs (A83) with `freeze.risk_sha256`. A
  change of either after FREEZE fails `verify-freeze` until an amendment and refreeze. The lead never writes
  `.agents/config.yaml` during a run (runtime hook).

## CODE_DONE and after

`handoff CODE_DONE` needs every required gate `pass` or `waived` for the current content fingerprint.
After CODE_DONE the knowledge step and the report publication change the tree, so DONE, `delivery-check`,
`validate` and `verify-handoff` check the gates against the task-owned patch instead.

## Fix loop (D15)

- A fix round is one content that collected an unwaived blocking FAIL (under the current frozen contract,
  since the last reopen). `handoff <ID> IMPLEMENTING` from IMPLEMENTED (lead only) opens it while
  rounds used ≤ `review.max_fix_rounds` (default 2).
- The fix MUST change the tree and stay inside the union `fix_scope` of the failing content's records
  (finding paths; a finding without a path allows any frozen scope path). An entry `path:line`, `path:line-line`
  or `path:symbol` scopes to its path part; comparison uses the path. The fix may also touch any path of the frozen
  plan `## Scope` that shares an acceptance criterion (`criteria:`) with a plan-scope path of a failing finding (A123); a path outside the plan scope, or sharing no criterion, needs the user's scope approval, a PLAN.md amendment and `refreeze` (`amend` works from CODE_DONE only). `next` and the refusal print the allowed paths, never a control artifact (A127). A failing gate whose blocking rows are all about the plan (row path PLAN.md or another control artifact of the run) gets no fix round: `next` prints the amendment route (amendment file, edit PLAN.md, `refreeze`; a `scope` approval only if the amendment adds scope paths). The new plan hash voids worker evidence and every gate: the implementer re-records RED and GREEN (a path with a `tdd_exemption` needs none), then `handoff IMPLEMENTED` and every gate again; a commands-only amendment on a non-exempt path has no honest RED, so complete `## Verification commands` before freeze. A107 rows (a cited command that cannot be re-run) get a verifier re-dispatch hint instead. A plan whose scope entries all list one criterion makes every plan path fixable.
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

Kinds: `plan`, `destructive`, `scope`, `budget`, `mutation_budget` (bound to the PLAN.md sha256), `commit`, `push`,
`pr`, `merge`, `cleanup` (bound to the content fingerprint), `reopen:<ID>` (bound to the PLAN.md sha256), `report` (no run: `request-approval - report`; bound to the sha256 of `.agents/local/friction/latest.md`; consumed by `agent.sh friction send`, which files the anonymous friction report as a GitHub issue; see docs/concepts/metrics.md), `waive:<FINDING-ID>` (bound to `<gate record>@<sha256>#<FINDING-ID>`).

- `mutation_budget`: `test_trust.mutation_budget` is never below one mutant per criterion of PLAN `## Tests`. Freeze
  records one request when the criteria exceed the budget; after the user approves, `agent.sh raise-budget <ID> <N>`
  writes the per-run override (`.agents/runs/<ID>/mutation_budget`; `.agents/config.yaml` is not edited). The same
  command resolves a REVIEW_TESTS that is BLOCKED on the budget: raise, then dispatch the reviewer again.
- `reopen:<ID>` (bound to the PLAN.md sha256, accepted on a FAILED or BLOCKED run, named for that run only): the
  user's approval for `agent.sh reopen <ID>` (A152), which consumes it. `mutation_budget` is accepted on such a run
  too; `reopen` asks it first when PLAN `## Tests` has more criteria than the budget and applies it itself.
- A FAILED or BLOCKED run is never delivered (no draft pull request): `deliver-plan` and `proofline deliver` refuse in
  one line, `to reopen: /proofline reopen <ID>`.
- One-command delivery: `agent.sh deliver-plan <ID>` writes `.agents/local/deliver/<ID>/SUMMARY.md` and one request
  per step (`commit`, `push`, `pr`, `merge`, `cleanup`), each carrying
  `delivery: <sha256 of the summary>`. Such a request is approved only by the delivery words (`approve delivery`,
  `I approve the delivery`, `teslimatı onaylıyorum`), never by a kind word, and the approval keeps the summary hash.
  `agent.sh deliver-step <ID> <step> [PR]` refuses unless the content fingerprint, branch, commit message, body
  and HEAD still match the summary and an unconsumed approval of that step carries its hash. The git hooks
  consume `commit` and `push`; `deliver-step` consumes the others. A `rule:<ID>`
  request is never approved by the delivery reply.

1. `agent.sh request-approval <ID> <KIND>` records the request time and binding and prints the D13 question.
   The lead relays it verbatim.
2. `agent.sh approve <ID> <KIND>` accepts the user's answer from (a model never runs it: the runtime hook denies
   it for the lead and every subagent; the runtime's prompt hook runs `agent.sh approve-pending` right after it
   stores the capture, which attempts `approve` for every open request; a terminal user may run it themselves):
   - an interactive terminal (stdin and stdout are TTYs): the typed line; or
   - the newest prompt capture `.agents/local/prompts/<session>.json`, written by a runtime hook on every
     user prompt, exactly one JSON object:
     `{"session":"<id>","time":<epoch seconds>,"sha256":"<hex sha256 of text>","text":"<prompt>"}`.
     It is accepted only when `time` is later than the request, `sha256` matches the unescaped `text`, the
     text contains an `approval.phrases` entry and a kind word, and every word of it is a phrase word, a kind word or a filler (a positive grammar, English and Turkish; A108): any other word makes the answer ambiguous, it approves nothing, the request stays pending and `next` says to ask again (`plan`, `scope`, `commit`, `push`,
     `destructive|migration|delete|drop`, `budget|round|rounds`, or the finding id), and that prompt has not
     granted the same kind before. The capture, and every approval request and approval file, must be a
     regular file (not a symlink) with one hard link, and no directory between the project root and it may
     be a symlink; otherwise `approve` and `answer` refuse every capture and the approval is not found.
3. Approvals are single-use: `freeze`/`refreeze` (plan, scope, budget), `handoff IMPLEMENTING` from PLANNED (destructive, single_step), `waive`, and the git hooks
   through `agent.sh approval-consume <ID|-> <commit|push> [FINGERPRINT]` (exit 0 = consumed) consume them.
   `-` is the no-run scope (commit, push, pr, merge, cleanup and report only, kept in `.agents/local/approvals/`).

Where approvals are required: supervised freeze (`plan`), a `destructive: yes` plan after the freeze, before
IMPLEMENT (`destructive`, any autonomy; `single_step` for a one-step migration; both bound to the frozen PLAN.md hash,
so a refreeze that changes PLAN.md returns the run to PLANNED and they are asked again), a refreeze adding scope paths (`scope`), a refreeze after the fix budget is
exhausted (`budget`), each waiver, each commit and push.
Every approval is ledgered with `answered_by: user`.
