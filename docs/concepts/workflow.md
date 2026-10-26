# Workflow

One deterministic lifecycle per task. The lead (your main session) classifies, freezes, dispatches bounded
roles and closes the run. `agent.sh` enforces every transition; `agent.sh next <ID>` prints the next step at any point.

```text
TASK -> CLASSIFY -> BRANCH -> BASELINE -> DISCOVER -> EVIDENCE -> [ARCHITECT/DATA/UI] -> PLAN -> [QA PLAN]
     -> [plan approval] -> FREEZE -> IMPLEMENT -> IMPLEMENTED -> gates of class + tier -> CODE_DONE
     -> [knowledge] -> REPORT -> DONE -> [commit/push approval] -> CLEANUP
```

## Classes

The highest class any indicator reaches wins; when unsure, take the higher.

| Class | Typical indicators |
|---|---|
| TRIVIAL | at most 2 scope paths, text or configuration only (no executable code or tests in scope), no behaviour change, no design choice |
| STANDARD | bounded behaviour change in one component |
| COMPLEX | several modules, new integration or dependency, public contract, persistence, real design tradeoffs |
| CRITICAL | auth, crypto, secrets, destructive migration, financial or data-integrity behaviour, high-impact CI or deploy |

A plan with more scope paths than `pipelines.<CLASS>.max_scope_paths` (15 by default) does not freeze: `freeze` records a split question (task-author's split flow), and only the user's answer `proceed without splitting` lets it continue, recorded in the ledger (A171). `pipelines.<CLASS>.dispatch_timeout_seconds` sets the dispatch timeout per class; a timed-out step leaves `dispatch/RESUME-<role>.md`, which the next dispatch of that role carries in its prompt.

`agent.sh decide <ID> <role> --dry` shows the execution decision without writing a decision file or ledger row; a bare `decide` ahead of a dispatch is refused, because `dispatch.sh` decides for itself (with a one-use nonce file under `.agents/local/dispatch/`, removed right after) and the Agent route records its decision once per step with `decide ... --agent-path` (a second one for the same role and focus waits for a recorded result). `agent.sh answer <ID> <N> --amend` replaces a recorded answer with a newer, unused user message and keeps the old record as `NNN.answer.amended-K.md`; the lead alone cannot amend.

The class selects the artifacts (EVIDENCE, QA plan, `## Architecture`) and the QA gate. A plan whose `## Data`
starts with `destructive: yes` makes the task CRITICAL at freeze.

## Freeze

`PLAN.md` carries a YAML `scope:` listing every file the change may touch, each tied to an acceptance
criterion. Freezing hashes the task contract and the plan. Changing scope afterwards needs an amendment and a
refreeze (and a `scope` approval when paths are added).

### Assumptions

`EVIDENCE.md` and `PLAN.md` each carry a mandatory `## Assumptions` section: `none`, or one row per fact the
plan relies on without a verified claim (id, text, source, risk `low|medium|high`, verification method, status
`verified|unverified`, the decisions it affects). Both validators check the shape; a `verified` row or a
`high` row without a verification method is rejected. `agent.sh freeze` and `refreeze` refuse while an
unverified high-risk assumption stands: the lead relays a recorded NEEDS_INPUT question bound to its id, and
the assumption is accepted only by the user's own prompt, which must start with `accept AS-<n>` or
`accepted AS-<n>` (any case; the id is `AS-<n>`). Several clauses may be joined with `,`, `;`, `&` or `and`, and
the remainder must contain no refusal word (not, no, if, unless, but, or the Turkish equivalents); a prompt that
merely contains the word accepts nothing. The stored answer becomes exactly `accept AS-<n>` and the assumption is
listed as `accepted-by-user` with it as reference. `agent.sh verify-assumptions <TASK>` shows the register read-only. The
completion report lists every unverified and accepted-by-user assumption.

### Input validation at entry points

A new or changed entry point that takes external input (an HTTP endpoint, form handler, CLI argument, queue consumer
or webhook) is validated by design, not by luck (A162). The plan lists the entry point in `## Contracts`, its name in
backticks, and `## Validation` carries one line for it: `- <entry point>: accepts <what>; limits <limits>; rejected at
<where, server side>`. `agent.sh freeze` refuses a plan with an entry point and no such line, and refuses a QA plan
without an adversarial `[invalid-input]` scenario that names the entry point. What counts as an entry point (two tiers, deterministic, in `.agents/config.yaml` `validation.*`, matched as whole words,
case-insensitive; a `.` or `-` inside `schema.graphql` or `order.schema.json` is no boundary):

- **mandatory:** a `## Contracts` bullet that declares an entry point (`entry_words`: a method and path such as
  `POST /x`, endpoint, webhook, queue consumer, graphql mutation, rpc method, a CLI flag such as `--dry-run`, a new
  command, a positional argument, form handler) and marks new or changed input (`entry_input`: accepts, takes,
  parameter, query, body, payload, argument, flag, option, header, input, required; or an `entry_new` word such as
  new, adds, introduces, creates, field, which counts only when the bullet has no `entry_output` word: response,
  returns, omits, shape). It is not mandatory when it says it is unchanged or documented (`entry_skip`) or when it is
  that entry point's own removal (it starts with remove, drop or deprecate, or says the entry point `is removed`;
  `POST /orders no longer accepts qty above 100` and `DELETE /x is added: removes an item` are still entry points);
- **information:** a bullet that only mentions a candidate word (`entry_candidates`: consumers, handler, route, form,
  graphql, a `.proto` or `.graphql` file name ...) or declares an entry point without new input (`GET /x response shape
  unchanged`, `The handler returns 404`). `agent.sh pipeline` lists these as `validation.possible` and the freeze
  prints a note; nothing refuses. Say in the bullet what input is new or changed and it becomes mandatory;
- the name is the first backticked token of the bullet, else the text before its first colon.

The corpus `tests/fixtures/entry-points/corpus.tsv` (67 labelled bullets; `sh tests/fixtures/entry-points/run-corpus.sh`)
pins the classes. `agent.sh entry-tier "<bullet>"` prints `mandatory`, `information` or `none` for one bullet. The
plan-contract and qa-plan validators carry the same expressions and read `validation.*` from `.agents/config.yaml`
themselves (flat key lookup; `--entry-words` overrides `entry_words`; defaults when the file or key is missing), so a
tuned project gets the same words at the freeze, in `validate-plan.mjs` and in `validate-qa.mjs`. The `[invalid-input]`
scenario is adversarial by definition: `validate-qa.mjs` refuses a category on an acceptance scenario, so a QA plan that
passes it has the scenario in `## Adversarial scenarios`; `agent.sh` accepts the tag in any section (the freeze checks
that a named scenario exists, the validator checks the structure), so the two agree on every plan the validator accepts.

What the check cannot see: an entry point the plan does not list in `## Contracts` (code is read only for
information: `validation.code_patterns` over scope files that exist and over the lines the diff adds, printed by
`agent.sh pipeline` as `validation.candidates` and as a note at freeze, never required); whether the stated limits are
the right ones or are enforced in the code (the plan, tests and review judge that; the check proves only that a line
and a scenario exist); and an entry point whose bullet does not say what input it takes (information only). Uncertain
detection is information only, never a refusal.

`validation.*` is read at freeze and refreeze; it is not hash-bound, so editing it mid-run changes nothing until the next
(re)freeze, and the plan stays valid. A refreeze of a run frozen before this rule re-validates the whole plan: the
amendment needs the `## Validation` line for each mandatory entry point and the `[invalid-input]` scenario, like a
new freeze.

### Upgrade and the risk signal for logging

`risk.log_sensitive` is a default signal added in 0.0.20 and `proofline upgrade` adds it to `.agents/config.yaml`. The
freeze binds the `risk:` block, so a run frozen before the upgrade would otherwise fail `verify-freeze` and `handoff
IMPLEMENTING`. A bounded legacy rule keeps it valid: when the recorded `risk_sha256` equals the hash of the block
without `risk.log_sensitive.*`, the freeze verifies and that run keeps the signal set it was frozen with (the
`logging` focus never opens for it). Any other change of a `risk:` key is still refused. A run frozen under the new rule
hashes the key, so editing `risk.log_sensitive` mid-run is refused; a refreeze binds the current block, the key included.

## Implementation

One implementer per run, inside an attested window, writes each scope path test-first with recorded RED
(a failing, specific assertion) and GREEN evidence, or a specific `tdd_exemption` in the plan. Changes outside
the window fail every later step. The lead never writes product code in the default `orchestrated` topology.

## Gates and the fix loop

See [gates](gates.md). Reviews run in parallel on the exact content; any change makes earlier passes stale.

## Autonomy and stop points

Always stop for: a specialist's question (relayed verbatim), a destructive operation, a scope change, and
commit, push or PR. `supervised` (default for COMPLEX and CRITICAL) also stops for plan approval before
the freeze; `autonomous` (default for TRIVIAL and STANDARD) runs to CODE_DONE.

## Done, delivery, cleanup

`CODE_DONE` needs every required gate to pass or be waived, and grants no delivery right. `DONE` additionally needs
the knowledge step (durable design documents updated, or `not_applicable`) and a published completion report.
`proofline deliver <TASK>` checks delivery readiness and shows what delivery will do; it never commits.
`/proofline deliver <TASK>` in the agent session does the whole delivery: the knowledge step if it is not done (without
a stop), then one summary (`agent.sh deliver-plan`) and one question. Your reply `approve delivery` approves each step of
that summary: commit, push, pull request, merge (only when every check is green, through `proofline merge`) and cleanup
(after the merge). With the markdown task adapter the commit step also moves the task file to `done/` (`agent.sh task-source-done`), so the move is part of the delivery commit; when the merge fails the move exists only in the unmerged pull request branch, and the delivery says so. A project with no CI check on pull requests is told early (`proofline doctor`, the delivery summary, a ready CI task line as the next step), because `proofline merge` does not merge a pull request that has no checks; no setting lifts that. A FAILED or BLOCKED run is not delivered: `/proofline reopen <TASK>` takes it back into the workflow,
only with your approval (one question; a mutation-budget raise the plan needs is part of it), and delivery works once its gates pass. Files `proofline upgrade` installed (`.agents/`, the agent files, the proofline block of `AGENTS.md`/`CLAUDE.md`) never block the reopen or make a gate stale, and committing them does not make the plan stale: the run then records the move and continues from the new `base_sha` (A156). An `AGENTS.md` or `CLAUDE.md` that the upgrade created for the first time counts the same when the whole file is the proofline block; any other text in it, and any other committed file, makes the plan stale as before (the message names the files and says to amend and refreeze or to revert, because text outside the block is project rules every agent reads). A new block-only file that is not committed yet is control plane too, and gates recorded by 0.0.12 or 0.0.13 with such a file present stay valid after the upgrade; validator evidence made against a base before an accepted control-plane move is accepted (A161). Each reopen is asked and approved on its own, so a second reopen of the same run works. Only the first `proofline:begin/end` pair of those two files counts as the block. Each step
is checked against the summary first (`agent.sh deliver-step`); a change in between stops the chain and you are asked
again. A lesson promotion is not covered by that reply: it needs its own.
A red CI check after the pull request is open is not a question (A169): `agent.sh deliver-step <ID> ci-fix|ci-commit|ci-push|ci-merge <PR>` reads the error from the failed run, fixes it inside the frozen scope through the normal gates and pushes to the same pull request branch, at most 2 rounds; your delivery approval covers exactly those pushes. A third red CI stops with one question (in night mode the task is parked); `resume` continues an open round.
Cleanup deletes the run directory so the git hooks no longer see the run; then the lead stops.

## Night mode

The summary, the limits and the resume rules are also described on their own page: [night mode](night-mode.md).

`/proofline batch <ID...|all>` (`agent.sh batch-plan`) is for several tasks that would each wait for your plan and delivery
approval. It orders the tasks by `depends_on` (a cycle refuses the whole batch), leaves out every CRITICAL task, every task
without a parseable `## Suggested class` and every task that depends on one of those or on a task that is neither in the batch
nor in `done/`, and writes one summary (`.agents/local/batch/SUMMARY.md`): the order, what the approval covers, what it
does not, the mutation budget cap and the stop rules. `all` means the top-level and `todo/` task files, in ID order. Your
reply "approve batch" is the one approval; it is bound to the sha256 of that summary, never consumed, and stops being valid
when the summary changes. It reads task files through the markdown adapter only, and `batch-plan` refuses another adapter with the exact next step (a design decision, A161: `depends_on` and `Suggested class` live in the task file's own front matter and sections, and the other adapters resolve ids through network calls; import the task with `/proofline task <issue reference>` into markdown tasks first).

After "approve batch" the lead works through the batch in this same session, in dependency order ([night mode](night-mode.md#running-the-batch-in-this-session)); there is no background process. A project with no pull_request workflow gets a WARNING in the summary and each pull request is verified locally before it merges (A180). Before each task the lead calls `agent.sh batch-next`, which prints the batch's state from records only (`merged.tsv`, the runs, their questions and approvals, `ci.tsv`, the lead's own parks) and the next action (`run`, `resume`, `cover`, `deliver`, `ci` or `finished`), so after a context compaction it continues at the right place. Each task runs in a git worktree of its own (A169, [night mode](night-mode.md#one-worktree-per-task-a169)): a parked task blocks no independent one, the main working tree stays clean, and a task starts only when its dependencies are merged. The lead runs the task, then delivers it, and goes on only when the pull request is merged; then `agent.sh batch-ci <ID>` checks the CI run of the merge commit itself (never the latest run): red, still running after `batch.ci_wait_minutes`, or no run within `batch.ci_appear_minutes` (10) stops the batch. The lead calls `agent.sh batch-cover <ID> <plan|delivery|mutation_budget>`, which records the approval of that request as yours only while
the batch approval is valid, the task is in the batch, its run is open and not CRITICAL and the request is pending; a mutation
budget stays within `batch.mutation_budget_cap` (40). Every other approval kind (waiver, scope, reopen, destructive,
single_step, rule, report, a fix-round budget) is refused: the lead records the question with `agent.sh ask`, the task is parked, the tasks that depend on it are skipped and the next independent task goes on.
The computer must stay awake and the session open: on macOS the session offers `caffeinate -i -w <session pid>` (`agent.sh batch-awake`). An interrupted batch (session closed, limit hit, computer asleep) just stops; `/proofline batch` with the same approved batch continues where it stopped and never runs a merged task again.
`proofline batch status` (`agent.sh batch-status`) prints the morning table (task, result, PR, merge time, park reason,
pending question) from the records, never from a session log, with the friction report under it.

## Commands

| Command | What it does |
|---|---|
| `init`, `upgrade`, `doctor`, `version` | install, update, verify, version |
| `status`, `resume`, `queue` | state of the active run and the task queue |
| `task`, `design`, `docs`, `explain` | write a task, design documents, documentation, an explanation page |
| `design ui <mode> <target>` | a focused UI change of one target (`bolder`, `quieter`, `polish`, `animate`, `typeset`, `colorize`, `layout`, `delight`, `harden`, `adapt`), run like any task (TRIVIAL or STANDARD): only the target changes, the existing design system stays, no new colour, font or system element unless asked; `skills/ui-design/scripts/scope-check.mjs` verifies afterwards that nothing outside the target changed |
| `run <TASK>` | take a task through the whole workflow |
| `review`, `audit`, `debug` | proof-review, test-trust and debug-proof standalone |
| `wiki ingest\|query\|lint` | keep the project wiki in `docs/wiki/` |
| `knowledge <TASK>` | the knowledge step of a finished run |
| `reopen <TASK>` | take a FAILED or BLOCKED run back into the workflow, only with your approval |
| `deliver <TASK>` | commit, push, pull request, merge and cleanup after one approval |
| `batch <ID...\|all>` | night mode: one approval of one summary for several tasks (`batch status`) |
| `debt` | list the shortcut comments in the code; read-only, needs no run |
| `clean`, `merge`, `insights` | clean up, the only allowed merge, cost and recurring failures |

## Delivery on other platforms

The platform comes from the `origin` URL (A180): GitHub, GitLab, Azure DevOps (`dev.azure.com`, `*.visualstudio.com`, `ssh.dev.azure.com`), Bitbucket, or other. `agent.sh platform` and `proofline doctor` show it, the tool found on `PATH` (`gh`, `glab`, `az`) and who merges.

A private host is named in `.agents/config.yaml` (A186): `git.platform` (`github`, `gitlab`, `azure`, `bitbucket` or `other`) and `git.platform_host` (a bare host such as `gitlab.company.com`, `github.company.com` or an Azure DevOps Server host). The order is config, then the `PROOFLINE_PLATFORM` environment variable, then the origin URL; `proofline doctor` shows the platform and which of the three decided (config, env, auto). `git.platform_host` applies the platform only when it equals the host of `origin` as a whole, so `github.com.evil.example` is still `other`. The tool then talks to that host (`GH_HOST` for GitHub Enterprise, `GITLAB_HOST` for self-hosted GitLab, the collection address of `origin` as `--org` for Azure DevOps Server). `agent.sh config-check` validates both keys.

When CI is red after the pull request is open, the CI-fix round (A169) reads the failed check through the platform adapter on all three platforms: `gh`, `glab` (the failed job of the merge request's pipeline) or `az` (the failed build policy and the errors of its failed tasks). If the tool cannot give the log, the round starts from the check's name and status only and says so; where there is no reader (Bitbucket, other hosts, no tool) no failed check is known, so the command stops with a message and you read the failing check yourself.

| Platform and tool | Pull request | Merge |
|---|---|---|
| GitHub + `gh`, GitLab + `glab`, Azure DevOps + `az` | opened with that tool | `proofline merge <PR>`: open, not a draft, every check (GitHub checks, the GitLab pipeline of the head, the Azure build and status policies) passed on the head being merged; the same fail-closed strictness on all three |
| Bitbucket, any other host, or the tool is not installed | the branch is pushed and the address is printed | you merge it; `proofline merge` merges nothing and says so; the delivery has no merge or cleanup step, run `agent.sh cleanup <ID>` afterwards |

When a pull request has **no checks** (or the project has no CI), it is not refused: the build and test commands of `.agents/config.yaml` run in a clean export of exactly the commit to be merged (the build record), the pull request description and the delivery summary say "verified locally, no CI", and `proofline merge` posts the same note before it merges. Checks that exist but are red or pending still refuse. A CI-fix round (A169) reads the failed run through `gh` and so exists on GitHub only. Only the exact hosts `github.com`, `www.github.com`, `gitlab.com`, `bitbucket.org`, `dev.azure.com`, `ssh.dev.azure.com` and `*.visualstudio.com` are recognized (a lookalike such as `github.com.example` is `other`); `PROOFLINE_PLATFORM=github|gitlab|azure|bitbucket|other` names the platform of a self-hosted host.

## The next step

Every command ends with one line, `Next step: ...` (A159): a `/proofline` command or an action you do yourself, never an internal command. The lead writes it, the Stop hook adds it when the lead left it out, and the CLI prints it for its own commands. All three read one table, `next-user.sh` in the control plane (`agent.sh next-user`), which maps a command and the run state to the line:

| Command | Next step |
|---|---|
| `init` | `/proofline doctor` |
| `doctor` (clean) | `/proofline task --grill` |
| `upgrade` | commit the changed files yourself, then `/proofline doctor` |
| `task` | `/proofline run <ID>` (the new task) |
| `design` | the next queued task, else `/proofline task --grill` |
| `run`, `status`, `resume`, `queue` | a question waits: reply in the session (the line names the question); CODE_DONE: `/proofline deliver <ID>`; FAILED or BLOCKED: `/proofline reopen <ID>`; running: `/proofline resume`; no run: the next queued task, else `/proofline task --grill` |
| `knowledge` | `/proofline deliver <ID>` (FAILED or BLOCKED: `/proofline reopen <ID>`) |
| `deliver` | waiting for you: reply `approve delivery`; the merge step stopped (a check is red): `proofline merge <PR>`; finished: `/proofline run <NEXT-ID>` when another task is queued, else `/proofline task --grill` |
| `reopen` | `/proofline resume` |
| `merge`, `clean` | the next queued task, else `/proofline task --grill` |
| `debt`, `review`, `audit`, `debug` | `/proofline task --grill` |
| `insights`, `explain` | `/proofline status` |
| `docs`, `wiki` | `/proofline docs audit`, `/proofline wiki lint` |
| `batch` | not approved: reply `approve batch`; approved with work left: `run /proofline batch to continue the batch; merged tasks are not run again`; finished: `/proofline batch status` |
| `batch status` | work left: `run /proofline batch to continue the batch`; a task parked: `/proofline resume <ID>, then reply in this session to the open question: ...`; none parked: the next queued task, else `/proofline task --grill` |
| `version` | `/proofline doctor` |

A failed command suggests the command that fixes the error instead: not installed `proofline init`; a dirty tree: commit or stash it yourself; a missing knowledge step `/proofline knowledge <ID>`; a FAILED run on `deliver` `/proofline reopen <ID>`.

## Knowledge step

The knowledge step always runs after CODE_DONE (and for a FAILED or BLOCKED run). It evaluates the wiki and the design documents every time and ends in `knowledge-done` with pages written under `docs/design/`, `docs/adr/`, `docs/wiki/` and the `design_docs` paths (the only paths the lead may write, and only in this step), or in `knowledge-done <ID> not_applicable "<reason>"` with one specific sentence. The script refuses the reason, naming the signal, when the task changed user-visible behaviour, a durable contract or something a design document describes. The reason is recorded and shown in the completion report.

With design surfaces (`design_docs.design` as a mapping) the shared document and every surface document are `design_docs` paths ([design surfaces](design-surfaces.md)).

## Shortcut debt

When the implementer cuts a corner on purpose, it writes a comment next to it: `shortcut: <limit>, <when to improve>`
(any comment marker). `proofline debt` (`agent.sh debt`) finds those comments with grep and prints `file:line`, the
limit and the improvement condition. It is read-only and needs no run. In the knowledge step `agent.sh debt page`
rewrites the one wiki page `docs/wiki/concepts/shortcut-debt.md` from the same comments.
A shortcut removed from the code drops off the page.

## Observations and unrelated changes

The implementer lists issues it saw but left alone, because they are out of scope, under `## Observations`
in its report (`file:line` and one sentence). The knowledge step proposes them to you as new tasks.
The task author writes a task into `tasks.dir` only after you approve it. The implementer never fixes an observation.

Inside the scope, the plan review fails a hunk that changes behaviour but ties to no acceptance criterion.
Formatting, comments and import order only produce a note. So does a hunk the reviewer cannot judge.

## Language of run files

Files inside a run are English (A33), whatever your language. The check (`agent.sh language-check`, also run by `freeze`, `submit` and
`verify`, and by the runtime hook at the moment a run file is written) counts letters outside ASCII in a file; three or more are
refused. A project written in Turkish, German, Japanese and so on has acceptance criteria, QA plans and review findings that must
repeat its product text, so these are exempt (A172), and only these:

- a `> ` quote line or a fenced line that repeats a line of one of your own messages (A171);
- inline code (`` `...` ``), a double-quoted span (`"..."`, `“...”`), a `> ` quote line, a fenced line or a JSON string value whose
  whole inner text occurs in the run's `TASK.md` or in a product file COMMITTED to git (`HEAD`) outside `.agents/`. A staged, modified or untracked file never counts: an agent can create or stage a file holding its own text, but cannot commit (the hook blocks it). So text that a task writes into new or changed files cannot be quoted until it is committed, except through `TASK.md`: put the text in `TASK.md` to quote it. A quote must lie within one line of the file (runs of whitespace match any whitespace run). Whitespace is
  normalized (runs of spaces and line breaks count as one space) and the quoted text must be at least 4 characters and match on word boundaries (no letter right before or after it); a shorter piece
  occurs in almost any file and proves nothing. A sentence an agent wrote itself is never in the project, so it cannot be hidden
  behind a quote, a code span or a fence: it stays refused;
- machine output of the skills, which tools measure and save instead of people writing it: `reviews/visual-proof/` and
  `reports/qa-evidence/` of a run (dispatch output, scratch, gates and the ledger were exempt already). This is an accepted channel that is not checked: a role allowed to write there could put text there.
- the question block the script stores for you in `questions/NNN.md` (`agent.sh ask`, and a specialist's question recorded by `record`): it is addressed to you and printed in your language (A99), so it is not scanned (A178); the front-matter lines stay English. Only the files `questions/NNN.md` directly under the run folder are exempt (a file of that name in a deeper folder is checked), and the question text is never evidence. The text itself is not checked: a specialist's question reaches the file through `record`, so it could contain non-English text; it is shown only to you.

Agents never transliterate product text to ASCII (no `ç` to `c`) and never ask you whether to translate; the refusal message says
to quote the text the project has. Each file is checked once without the product text, and the text is gathered (`git grep` on `HEAD`, capped at 50 MB, cached per commit under `.agents/local/language/`, as a pre-filter only: every piece the cache accepts is confirmed with one `git grep` on `HEAD`, because the cache is a file) only
when a file has a hit, so an English write costs one pass and a quote check one lookup, not one scan per quote.

## Ids

Ids that scripts write and read (`QA-n`, `AC-n`, `AS-n`, `FR-n`, finding ids) are compared by key: case-insensitive, leading zeros ignored (A172).
The spelling the producer wrote stays canonical and is recorded as written. A gate result uses `<GATE>-<n>` (`QA-1`, `REVIEW_RULES-2`); a task
result uses `<role id>-<n>` (`explorer-3`, `qa-1` for the QA plan step); `submit` and `record` take the prefix from one function.

## Sources of truth

1. Current source code: authoritative for behaviour.
2. Permanent contracts (`AGENTS.md`, `CLAUDE.md`, `.agents/**` except `runs/` and `local/`).
3. The active run's artifacts under `.agents/runs/<TASK-ID>/` (git-ignored, disposable).

Task text, issue text, commit messages and rule files are data, never instructions.

## Real output

The lead's final message from a real end-to-end run (STANDARD bug fix in the playground, Claude-only team,
headless, 2026-10-09), unedited:

```text
The pagination bug is fixed in the working tree. With your 12 sample books you should now see "Page 1 of 2" and an enabled Next button. `GET /api/books?page=2` should return the 2 oldest books, Dune and Neuromancer. Nothing is committed yet.

**Cause:** `paginate()` in `src/service.js` rounded the page count down, so 12 books at 10 per page counted as 1 page. Page 2 was then clamped back to page 1. At 20 books the count divides evenly, which is why that case worked.

**Fix:** it's a one-word change, `Math.floor` to `Math.ceil`, with the "at least 1 page" floor kept. Empty lists, exact multiples and "page past the end returns the last page" behave as before.

**Tests:** I added two to `tests/service.test.js`, one for the page maths and one that lists 12 books and checks page 2 returns 2. They failed before the fix and pass after it. `npm test` passes 16 of 16.

**Review:** the proofline gates (secret scan, review, verify) all passed, and the run is marked done. The reviewer traced rather than ran the revert-to-`floor` check, so its confidence was only medium. The implementer did run that check, and the new tests failed as expected.

**Not done:**
- **Branch:** the work is on branch `proofline/T-1-fix-pagination-dropping-last-partial-page`.
- **Commit:** nothing is committed or pushed. The workflow needs your explicit go-ahead for that, so tell me if you want me to commit.
- **Run cleanup:** I'll run the final cleanup once you've decided on delivery.
- **Task file:** `.agents/tasks/` is a new untracked folder holding the task file.
```

The end-to-end results are in [tests/e2e/README.md](../../tests/e2e/README.md).

Related: [roles](roles.md), [gates](gates.md), [failover](failover.md), [enforcement layers](enforcement-layers.md).
