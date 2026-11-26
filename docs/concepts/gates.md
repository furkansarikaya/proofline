# Gates

This page explains how a change is judged: which gates a run needs, who records them, what a waiver or an approval is, and what happens after a failed review. It is for users who read a gate result and for contributors who change the gates.

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
come from `review.risky_paths` plus, at read time, the manifests, lock files, package-source settings and
build-changing files of every ecosystem in `.agents/ecosystems.json` ([ecosystems](ecosystems.md), A174). Code-like Markdown (`.agents/**`, `skills/**`, `roles/**`, agent definitions,
`AGENTS.md`, `CLAUDE.md`, prompt files) is never docs. The tier never decreases within a run.

## Weight by work type

A364. Weight comes from the work, decided by the control plane, never by an agent's claim.

| Class | `max_fix_rounds` | `mutation_budget` | Light profile |
|---|---|---|---|
| TRIVIAL, STANDARD | 2 (`review.max_fix_rounds`) | 20 (`test_trust.mutation_budget`) | when the task `type:` is `content` or `docs` and nothing below disqualifies it: no mutation budget approval (need 0), mutation testing not required by instruction |
| COMPLEX, CRITICAL | 3 (`pipelines.<CLASS>.max_fix_rounds`) | 30 (`pipelines.<CLASS>.mutation_budget`) | never |

A class key replaces the global value for that class, except a global value below the default (2 fix rounds, 20 mutants) that the project set itself, which is kept (a stricter project setting wins; to keep the default for COMPLEX or CRITICAL set the class key); fix rounds stay bounded (1 to 10) and a value above the class default is still the plan's `## Test review budget` with your `scope` approval, or your
`mutation_budget` approval ([gate set](#fix-loop)). A `max_scope_paths` count leaves out test files and fixture or test-data files (`fixtures/`, `testdata/`, `__snapshots__/`; data only: a script in a fixture folder counts as code); a product file stays counted.

The light profile (`profiles.light` in the config) holds while the class is TRIVIAL or STANDARD, the sealed task says `type: content` or `type: docs`, the plan has no `## Data`, no destructive flag and no risk
focus except the plain visual one, and every scope path and changed path is documentation text or an image (`profiles.light.content_globs`, default `*.md *.mdx *.txt *.rst *.adoc` and common image types): json, xml, html, svg, css, scripts, tests, fixtures and configuration make the run full, as does a risky, dependency, CI or code-like path. The check
runs at every call from the manifest and stores nothing: a code file in the diff makes the run full at the next call. Light removes only the mutation budget approval need, and, by instruction to the reviewer and QA, the mutation testing of the tests review and the optional `design` group of the
visual check; SECRETS, SECURITY, the reviews of the tier, QA with its plain visual check and VERIFY all run. `agent.sh pipeline <ID>` prints `profile`, `profile_reason`, `mutation_testing`, `design_group`,
`max_fix_rounds` and `max_mutants`. The plan approval request prints the median and p90 wall time, agent time and tokens of finished runs of the same class (`no history` when none; informational) and the test review budget the plan states (a CRITICAL plan states one).

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

Gates run in parallel except where one reads another's output: `VERIFY` waits for the `QA` visual focus when the
run has one (`next` does not offer it earlier, `decide` and `record` refuse it). The build record is made before the
review wave, at `handoff IMPLEMENTED`; if it is missing, `next` lists it first.
The build record runs in a clean export that holds no git-ignored file, so no `.env*`. A project whose tests need a
secret-free env file names it in `verification.env_files` in `.agents/config.yaml` (space-separated project-relative names,
default none, for example `.env.test`). Each named file is scanned first; one visible secret makes the build record refuse
with the file and line (never the value), and nothing is built. Every other `.env*` still stays out. The scan uses the token
patterns and the quoted-value rule only: the `.env` rule does not apply to these files, so a low-entropy value such as
`DB_PASSWORD=hunter2` passes, and only secret-free files belong in `verification.env_files`. A `proofline:allow-secret`
marker on a line skips that line. A listed file that is a symbolic link, or whose directory resolves outside the project or
under `.git`, rejects the run; a listed file that does not exist only prints a note.

**Documents and takeovers (A197, A198).** A document path in the plan scope (`verification.doc_paths`, default `docs/ *.md *.mdx *.rst *.adoc`, plus the design documents and the knowledge scope) needs a `tdd_exemption` or a meaningful proof; `agent.sh freeze` prints one warning line for one without, and does not stop. Code that was edited without RED evidence (a retry, or another runtime did it) is bound by the implementer without asking: put the change back to the base content, record RED, restore it, record GREEN. The recorder accepts GREEN only when an implementation file differs from its state at RED.

Status per gate: `pass`, `pass_low` (a PASS with `CONFIDENCE: low` does not count; re-run with a stronger model),
`waived`, `fail`, `stale`, `missing`. `agent.sh pipeline <ID>` prints them.

## Runtime versions (doctor and VERIFY)

A green local run proves little when CI runs another language version. `proofline doctor` and the verifier compare
the runtime version the project's CI specifies with the one installed here (`skills/verify-proof/scripts/runtime-versions.mjs`,
read-only). The CI version is the first found of: a workflow's `node-version`, `go-version`, `dotnet-version` or
`python-version` (a value, an inline list or a block list; `${{ ... }}` expressions are skipped), a version file
(`.nvmrc`, `.node-version`, `.python-version`, `global.json`, `.tool-versions`), a manifest (`package.json`
`engines.node`, `go.mod` `go`, `pyproject.toml` `requires-python`) or a `.gitlab-ci.yml` image. The check covers node, python, go,
java, rust, dotnet, php, ruby, swift and dart, in the root and in nested projects. Node and dotnet compare the major version; go and python compare major.minor, because their
major never changes. `go.mod` and `>=` specs are minimums, a list (a matrix) matches when the local version is in it,
and a spec that cannot be compared (`lts/*`, `stable`, a `<` range) is `unknown`.

- `proofline doctor` prints `WARN toolchain <name>: local <v>, CI specifies <spec> (<file>); the major version differs ...`
  on a difference and `PASS toolchain <name>: ...` otherwise. It never prints FAIL for this. A project with no
  language runtime prints no toolchain line (`runtime: none` is not a runtime).
- The verifier records the script's `runtime:` lines unchanged in a `## Runtime` section of `VERIFY.md`, so the report
  says which version it verified with (`runtime: node local=22.13.0 ci=20 source=.github/workflows/ci.yml status=mismatch`).
  `validate-verify.mjs` requires the section and checks the line format; a `mismatch` never changes the verdict.

## Risk signals

Besides class and tier, deterministic risk signals choose extra checks, each a focus inside an existing gate
(decision A78; table in `.agents/GATES.md`). A signal comes from a changed or planned path (contract files,
migrations, UI files, dependency manifests, config and env files), from text the diff adds (optional, off by
default), or from a flag the architect or data architect writes into PLAN.md (`## Risk`: `contract_change`,
`concurrency`, `performance_critical`; `## Data`; `## UI`). The checks: REVIEW focuses `contract`,
`concurrency`, `performance`, `config`; REVIEW_DATA `migration`; QA `visual` (the visual-proof skill, A82); SECURITY `dependencies` and `logging`.

The `logging` focus (A162) opens when a line the diff adds is a log call (`logger.`, `log.`, `console.`, `print`,
`printf`, `Log.` and the like) and names a sensitive-looking word: `password`, `token`, `secret`, `authorization`,
`cookie`, `email`, `phone`, `card`, `iban`, `ssn`, `tckn` (a national identity number; config `risk.log_sensitive.content` and `.words`, both
extensible; case-insensitive, whole identifier parts, so `userPassword` matches and `discard` does not). The word
match only opens a review: the security reviewer then checks the `[log]` sink of exploit-proof, whether a request
body, an `Authorization` or `Cookie` header, a token, a password, a secret key or personal data reaches the changed
log call unmasked, and whether user input with CR or LF can forge a line in a plain-text log. Only a concrete path
is a finding. An ordinary `logger.info("started")` opens nothing, and a call split over several lines is not seen.
proofline sets no logging standard: write yours in `AGENTS.md`, in your own part of the file outside the
`<!-- proofline:begin -->` block (`proofline upgrade` replaces the block and reports a conflict when you edit
inside it; the template carries no logging text for that reason), for example:

```markdown
## Logging
- Log through `internal/logx` only; never `fmt.Println` or `print`.
- Never log request bodies, tokens, passwords or personal data; pass user input through `logx.Redact`.
```

The `rules` focus of the code review checks every rule it can verify on a changed line in each task that has a rules
review; the implementer is told to use the project's own logger and standard and never to log secrets or personal data.

- `agent.sh pipeline <ID>` shows every signal, its source, the check it triggers and why. Before FREEZE the
  signals of the planned scope are visible, so the right design role declares the flag.
- A signal in the diff without its plan flag (a contract file changed, `contract_change` not set) is a
  blocking finding of that focus, and the check still runs.
- A gate passes only when its own focus and every risk focus it carries pass.
- The `contract` focus is required when a recognised contract file is in the task-owned diff or the plan says `contract_change: yes` (A362). A contract path that only the plan scope names does not add it; the control plane decides from the manifest, again at every call, so a round that adds a contract file adds the focus and a focus already recorded stays on its record.
- A finding id names one finding of a gate: the findings of a second focus of the same gate (`QA` and `QA:visual`, `REVIEW_RULES` and its `contract` focus) are numbered above those of the first, and `record` refuses an id that another focus of the gate holds (A362). A report file the agent did not write with its submission (no `--report`) is refused when its bytes equal the report of an earlier record of another gate or focus, or of the same gate on another tree: a stale file under a shared name (`QA_REPORT.md`, `VERIFY.md`, a `REPORT.md`).
- A check whose skill or tool is missing is `UNSUPPORTED`: never a PASS, unproven and reported (A98). By default
  (`risk.unsupported: report`) it does not block the gate; the completion report must list it under
  `## Unsupported Checks` with `not proven: <what>`. `risk.unsupported: block` makes it blocking (only the user
  waives it), and an INCONCLUSIVE measurement is blocking in both modes. An UNSUPPORTED result must cite the
  skill validator's own saved output (`RESULT: UNSUPPORTED`), and the script cross-checks it against the contract
  and migration files it found in the diff itself, so one line of text cannot skip a check (A102). The `contract` check is the contract-proof skill (A83): every change in a contract
  file gets a breaking/non-breaking rule, in-repo consumers come from the impact report, and a breaking
  change that PLAN.md `## Contracts` does not cover with versioning, migration or deprecation fails; it is
  UNSUPPORTED only for a contract file it cannot parse and no compatibility tool already present covers.
- The `concurrency` focus runs the concurrency-proof skill (A86): a finding is a traced interleaving (two or
  more actors, `file:line` per step) or a concurrent reproduction in the project's own test runner; PASS
  means no proven problem, never that the code is free of races; unproven risks are listed separately, and a
  reproduction the project cannot run is stated as UNSUPPORTED inside the result.
- The `performance` focus (performance-proof skill, A87) measures: the project's own benchmark command runs
  repeatedly in a base and a change worktree, interleaved, and a script decides from the median and a bootstrap
  interval (default threshold 10 %, `.agents/config.yaml` `performance:`, the plan's stated budget wins). A
  regression beyond the threshold is a FAIL; noise or too few runs is INCONCLUSIVE, submitted as UNSUPPORTED
  with a `performance INCONCLUSIVE:` reason (not a FAIL, never a PASS, blocking: the user re-runs or waives it);
  no benchmark command in the project is UNSUPPORTED (unproven, reported).
  Patterns read from the code (an N+1 query) are judged and fail only against a written criterion.
  The bootstrap seed and resample count are pinned, the direction follows the unit (a time is lower-is-better),
  and a PASS whose thresholds were not recomputed from the config and the plan is submitted as UNSUPPORTED (A93).
- The `visual` focus (visual-proof skill, A82) uses the same INCONCLUSIVE mapping: a required cell or criterion
  it could not measure is submitted as UNSUPPORTED with a `visual INCONCLUSIVE:` reason (A93). Its browser
  blocks every request outside the page's own origin, and it never drives a backend with a real database. A failed technical SEO item (A158) is a blocking row like any measured failure; a fact it cannot measure is an info row.
- The mapping lives in `.agents/config.yaml` and is frozen with the plan; the lead cannot change it during a run.

Two of these focuses are tool-free (decision A88):

- **SECURITY `dependencies`** (exploit-proof). A manifest diff of the changed manifests, lockfiles and package-source settings
  of every ecosystem in the definition (`skills/exploit-proof/scripts/diff-manifests.mjs`; [ecosystems](ecosystems.md)) is checked against PLAN `## Dependencies`: an undeclared new
  or changed direct dependency or install hook is blocking, lockfile-only and transitive changes are notes, git or
  URL sources and unpinned ranges are flagged. The license policy comes from `security.licenses.allow|deny` in
  `.agents/config.yaml` (unset: "not configured", never a pass). The project's own audit tool is used only if it
  already exists (never installed); known vulnerabilities come only from its output, a tool that cannot run
  (for example no network) is recorded `tool_unavailable`. Without a tool the report says "manifest diff and plan
  check only" and the confidence is `medium`. Never UNSUPPORTED, never waivable.
  The security role itself is network-blocked, so the check that "never ran" is made by the control plane, once (A373): with `security.advisory_check: on`
  (your hand edit of `.agents/config.yaml`, your one-time consent; default off) `agent.sh advisory-check <ID>` sends the package names and versions of the root `package-lock.json` or
  `npm-shrinkwrap.json` (and nothing else: no user, project or machine data) to `registry.npmjs.org` over HTTPS, one POST per batch of at most 500 packages (at most 5000 packages and 10 requests),
  to the bulk advisory endpoint named in the control plane's own ecosystem table. No npm and no project script or config runs or is read: the lock (a regular file up to 16 MiB) is only parsed
  as JSON and each entry's name and version must pass a strict grammar. A redirect, a timeout, a non-200 or an oversized or malformed answer is a failure that is recorded with its reason, never a
  clean result; no proxy is used, so on a network that allows only a proxy the check says `network error`. It writes `ADVISORY_CHECK.json` in the run (ids, packages, severities, counts and a
  few bounded strings; no role can write it) together with a ledger row, and the role reads it, the validator ignoring a record without its row:
  a high or critical advisory in a dependency the diff added or changed is a blocking finding the reviewer must address, every other advisory is an info row, and a request
  that was not made says why instead of "unavailable". Every package name in the lock goes to the public registry, private or internal scoped names included, and the setting is the consent for that: users with private packages should leave it off. An alias is asked about by its real name; a link or a git, file or http entry is skipped and shown as `skipped N of M packages`, and too many skipped (over 5 percent or over 25) make the record `partial`, never a clean result. One request set per lock file content (at most three attempts per content and six sets per run). Only the npm lock file is read (`package-lock.json` / `npm-shrinkwrap.json`); pnpm, yarn and bun lock files are not supported, an accepted limit ([A377.1](../limits.md)); an offline advisory database is not shipped.
- **REVIEW `config`** (proof-review). `skills/proof-review/scripts/check-config.mjs` judges only the lines the
  change adds: a variable read in code or `${VAR}` in config that no example env file, config sample or document
  defines; a secret in plain text in a config file (masked, `proofline:allow-secret` marks a deliberate fake);
  a feature flag added with default on that the plan does not name; a flag removed while still referenced.

Other FAIL rules: a failing test that also fails at the base in a clean worktree is reported as pre-existing;
a new dependency not named in the plan is a FAIL; so is a change to a versioned contract the plan does not name. Inside the plan scope, a hunk that changes behaviour and ties to no acceptance criterion is a blocking finding of the plan review (A153); a hunk that does not change behaviour (formatting, comments, import order), and any hunk the reviewer is unsure about, stays informational.

## Fix loop

A FAIL goes back to the implementer (same worktree). Each round carries the previous findings; only gates made
stale by the change re-run. `review.max_fix_rounds` defaults to 2 and round 2 escalates (a stronger model for a first attempt; a role that is run again on the same task never runs above its first attempt or above `execution_policy.repeat_model_cap`, so the strongest model is spent once, A362; a role's tier floor still wins, a security reviewer is never lowered).
If findings remain after the last round the run ends `terminate FAILED`, commit and push stay locked, and the
lead reports what remains. There is never an endless loop.

Three rules keep the loop fair (A171). A rules review scans for the whole class of a finding in one pass and records
the scan and every instance, so the examples are fixed together. A failing record whose every blocking row cites a
line that was already in the previously reviewed revision (and was not cited before) is a missed example and does not
use up a round. Blocking or info follows a written rule (`GATES.md`), and the same observation keeps its
classification from round to round. A mutation budget overrun in the tests review (21 of 20) is a warning, not a block. The cap is enforced while the mutants run: `gate.mjs mutant <review-folder>/mutants.count ...` refuses a mutant past the budget, and the validator fails a finding that records more executed mutants than the budget (A203).

### The tests review loop is bounded (A359)

Hours of the loop were lost to mutation results that were thrown away and re-run, survivors that appeared one round at a
time, and caps the user had to type late. Now: (1) the mutation results of the tests review are rows of the sealed run ledger, written by the control plane for the
reviewer only (`agent.sh build-record <ID> mutant-record`), keyed on the product file AND every file the task owns:
`mutant-known` answers `KNOWN killed|survived` for a mutant that already ran on the same code and the same tests and
spends no budget; a change of any owned file or a weakened or added test runs again, and no file an agent can write counts. (2) The first survivor of a unit makes the reviewer run that unit's other
mutants in the same round, so one round lists all its survivors. (3) The plan may carry an optional `## Test review budget`
(`rounds`, `minutes`, `mutants`, `units`, `lines`): the round and time caps, and the mutation budget derived from the changed
units and lines (4 per unit, 1 per 25 lines; never only the criteria count). A number above `test_trust.mutation_budget` is
still your `mutation_budget` approval, once; a `rounds` or `minutes` above the config defaults is yours too (your `scope` approval of that plan, at the first freeze and at every refreeze); the control plane then applies it at the freeze and at every `handoff
IMPLEMENTED`, so the reviewer never stops on an approval already given, and a reopen carries the new budget with its one
approval. Without the section the config defaults `test_trust.review_rounds` (4) and `review_minutes` (120) apply. The minutes are counted by the control plane's clock (A379): from the first sealed ledger row of the loop that shows the tests reviewer at work (its dispatch decision, or a mutant result it recorded; after a reopen or a REVIEW_TESTS pass the next loop starts its own clock) to now, checked when a fix round opens and at `--re-review`; `mutant-summary` prints them as a `TIME:` line, `not recorded` when no such row exists (then only the round cap bounds the loop). The tests reviewer mutates the units of security-relevant files first: `build-record <ID> scan` prints them first in its `mutation-order:` line (from `review.risky_paths` and `global.security_paths` of ecosystems.json, compared in lower case), and `mutant-summary` lists their units first. (4) The loop
ends with an `ADEQUACY:` line (units closed, units with survivors, survivors found only by widening the mutant set, which are
labelled `new class` and are not new findings). When the round cap or the minutes cap is reached with REVIEW_TESTS still failing, the gate does
NOT pass: the state is `test review cap reached` and you are asked once to choose between a larger cap (an amended plan), a
written waiver of the named residual survivors (your message only; SECURITY and SECRETS findings are never waived), or
stopping the run.

## Waivers

Security and secret findings can never be waived. Another blocking finding is waived only by the user's explicit
message, finding by finding, with a specific reason (at least 20 characters). The waiver is ledgered and listed
in the completion report; `review.waiver_followup: task` also creates a follow-up task per waiver.

A waiver follows the **finding**, not the gate record: it carries the finding's persistent key (gate and focus, the cited line's text, how many identical lines
precede it, and the finding text). When the gate runs again and finds the same finding, even on changed content, it is still waived and nothing is asked again;
the same rule at a new place, or a changed finding, is another finding and asks again. Findings of one rule (for example 93 lines of one visual rule) are one
decision: the request names the count and the first ids, and `agent.sh waive <ID> <FINDING-ID> --group --reason TEXT` records the waiver of every open blocking
finding of the same record and rule on your one approval. The detail stays in the gate record and the report.

## Approvals

Kinds: `plan`, `destructive`, `scope`, `budget`, `tree`, `commit`, `push`, `waive:<FINDING-ID>`. The lead requests an
approval with `agent.sh request-approval`; the answer counts only if it comes from a terminal you typed in or from a
prompt your runtime captured after the request. Approvals are single-use and ledgered as `answered_by: user`.
The accepted approval phrases are configurable: `approval.phrases` in the project's `.agents/config.yaml`, a comma-separated list (a phrase may contain spaces) whose defaults are English and Turkish. A reply approves only when it contains one of the phrases and a kind word, and every word in it belongs to some phrase, is a kind word or is a filler.
The `scope` approval also covers a change of the frozen plan's `## Test exceptions` at a refreeze (A284): it is bound to the
hash of the exact new PLAN.md, so changing the line afterwards, or approving before writing it, leaves the refreeze refused.
A line the lead wrote into `## Test exceptions` clears a finding of the tests review only when you approved that exact line (A285): your `scope` approval for the
PLAN.md (the freeze consumes it and the ledger row `test-exceptions` names it), or, in a night batch, the line is listed in the approved batch summary. A plan frozen
without it is accepted, but the lines clear nothing (the freeze says so, and `submit` refuses a clearing with `exception not approved: stays blocking`); ask for the
approval with `agent.sh request-approval <ID> scope`, which then shows the lines. The task author may propose such lines in the task file in advance (A294, night-mode.md): a proposal is shown in the batch summary and accepted only by your approval of the batch.
Commit and push need both a gate pass for the current content and your approval in the current message;
`push_requires_approval` is `true` by default.

Further kinds (A200): `rationale:<pattern-id>` approves one design rationale and is bound to the sha256 of the exact `DESIGN.md` line; it is
recorded only from your reply. Only such an approved rationale can downgrade a visual finding; an agent-written one never does. A visual PASS also needs an
independent `reviews/visual-proof/report.json` that says PASS, and a FAIL or INCONCLUSIVE report never counts as PASS.

**Standing approvals (A361).** What you approve once is not asked again for the same thing, but only when you say so: add the word `standing` (or `kalıcı`) to the approval,
for example `approve rationale numbered-steps standing` or `approve qa-1 standing` (the request tells you the phrase; a plain "approve" is for that run only). Two things can
stand: a rationale (bound to the exact `DESIGN.md` line) and the waiver of a finding of a registry rule (a `lint <id>:` row of the visual lint) in a tracked file that the task
did not change and that was already there on the unchanged base (bound to its rule, text, file and the file's content at the base). They are kept in
`.agents/local/standing/STANDING.tsv`: scope, rule, file, fingerprint, your message id, the date, who named it. Only the control plane writes it, and every row is checked
against your message at every use (the message must be in the prompt history, unchanged, and say an approval, the name and `standing` in one segment): a row without such a
message is ignored. A later task, batch or run is not asked again while the line, the file and the finding are the same; an edited line, a changed file or finding, another rule, a free-form
finding of a reviewer, a finding in a file the task changed and every SECRETS or SECURITY finding are asked again (a standing approval is never inferred from silence and never created by a batch
cover). `agent.sh standing list` shows what stands (the night batch summary lists it too), and `agent.sh standing revoke <rule> [<surface>]` removes it, only when your newest
message says "revoke <rule>". The QA visual lint of a task covers the files it changed (`agent.sh design-rationales <ID> --json --out reviews/visual-proof/approved-rationales.json`
writes the approved file and prints them; no role builds it by hand); the control plane's own rerun at the visual `record` lints the whole tree and subtracts the base: a finding in a file
the task did not change is the base's, not this change's.

**Measured items and page kinds (A380).** A third thing can stand: the waiver of a failed MEASURED item of the QA visual report (`touch_target`, `design_empty_hero` and the
like; never `design_raw_markup` or `raw-markup-in-text`). The UI spec and the visual config may name page kinds (`page_kinds: [{ kind, paths: [glob], text_only?, reason }]`).
A standing waiver of a measured item writes one row per check, threshold and page kind (or per page, for a page with no kind) with the worst value of the waived group, and the request
shows what it would keep ("touch_target >= 44 on pages of kind legal (paths legal/*.html) at a value no worse than 19"). A later page is not asked again only when the check and the
threshold are the same, its value is no worse, and the report declares it of that kind AND its path matches the glob you were shown (a page that only claims the kind, a worse value,
another threshold or another check is asked again). `standing list` and `standing revoke <check>` cover these rows. **Text-only pages (A380).** A page of a kind declared
`text_only` is not asked for the hero, the motion layer and the image ledger when the measurement shows no visual medium or background image of 80 px or more, no hero visual, no
raster image and no motion on it; a page that shows any of them is measured as before (see the visual-proof MEASURE reference).

**Several approvals in one message (A202, A350).** When the whole message is not one approval, it is split only on commas, semicolons and newlines
("approve scope; approve budget") and each segment goes through the same strict check; every approved segment is its own record bound to the same captured message (at most
`approval.max_per_message`, 8). One phrase may approve several open kinds only when it names each kind ("approve plan and scope"); "approve everything" or "approve all"
approves none. A rejected segment prints `not recorded: <segment>: <reason>`; a negated, hedged or retracting segment
vetoes the whole message. A closed-choice user-only question (`SPLIT:` or `USER_ONLY:`, two to four listed answers) is also offered in Claude Code's option picker (A367): `agent.sh questions` prints an `ask=` block, the PostToolUse hook of the AskUserQuestion tool records the selection as the user's answer (`source: ui`) only when the tool input equals the block the control plane derived from the stored question, the result holds the user's answer, the call is the lead's own, in the asking session, and the tool call has not answered anything before; approvals, assumption tokens and every other question stay typed, and without the tool (headless, Codex, hook not wired) the written options apply. A segment that is the answer to a pending user-only question (one of its listed forms, or `soru 1: a` / `question 1: a` for the option labelled `a)`) may stand beside the approvals: the
hook records it as your answer (`answered_by: user`) from the same message; a hedged rest ("böl, but wait") records nothing.
Only a request that no approval answers yet counts as waiting. When several runs wait, name the run: a run id may follow the kind word ("approve scope TASK-004 TASK-010"
approves those two runs); a word that is not the id of a real, waiting run (the control plane's `RUN.yaml` must name it and its request must be open; a folder name alone proves nothing; an id with a digit may be named beside the run's own, an id without a digit such as `add-login` only as the run being checked, and never when the id or a part of it split on `-` and `_` is a refusal, filler, approval or kind word such as `no-way` or `do-not`), or a reply that names other runs and not this one, approves nothing. Recording comes first: the hook copies your message to `.agents/local/prompts/intake/` before any parse, git or
scan, so the size of a run cannot lose an approval (`hook.approve_budget_seconds`, `doctor` times it). Limits: [timeouts](timeouts.md).

## Recovering a tree that changed outside the run

Under the orchestrated topology only the implementer's recorded worker windows may change the product tree. A change that entered it any other way (a failover
worker that was never stopped, an editor, another process) makes the run refuse to go on, and it used to cost the run. Now `agent.sh tree-inspect <ID>` (read-only)
shows what differs, and `agent.sh tree-accept <ID>` (lead) asks you to approve exactly that tree (kind `tree`: "approve the tree"). The accepted change is
attested by a window of role `user` that the ledger binds to that command (a hand-written one counts for nothing), the handoff goes back to IMPLEMENTING, and
because the tree fingerprint changed every gate, SECRETS and SECURITY included, runs again. Stopping a dispatch also stops its worker, a failover worker included.

## Known issues (A202)

A blocking finding in a place the task does not touch (not in its frozen scope or diff) can be recorded as a **known issue** so it does not
stop every later task. The lead proposes one record (`known-issue-propose <RUN> <FINDING-ID> --followup <TASK>`, an open markdown follow-up
task is required) and only your reply `approve known issue` applies it (`known-issue-apply`); the list is local
(`.agents/local/known-issues/LIST.tsv`), matches only the exact gate, place (`path[:line]` of a tracked file) and text, drops when the
follow-up is done, and never covers SECRETS or SECURITY. A matched finding is shown as "known issue" with its record id in the report and the
status block; the gate record keeps it. `known-issue-list` and `known-issue-candidates` are read-only.

## Reopened runs and re-review without a code change (A353)

`agent.sh reopen` voids the failing records so every gate can run again, but a run reopened on unchanged content opens its fix round from the findings recorded before the reopen (`agent.sh handoff <ID> IMPLEMENTING`; `next` prints a `note=` line): no gate is dispatched only to say the content is unchanged, the fix is bounded by the recorded `fix_scope`, and the passes that survive the read-set rule stay. A review of the SAME tree needs no code change either: `agent.sh handoff <ID> IMPLEMENTED --re-review` (the lead, `reason:` of 20 or more characters on stdin) returns an IMPLEMENTING run to IMPLEMENTED on a tree that is byte-identical to the one the latest finding judged, once per finding record, and the ledger row names the finding and the reason. Nothing else is skipped: every gate still has to pass for the current content, SECRETS and SECURITY are never waived and run whenever product code, dependencies or configuration changed.

## Repeating gates after a fix round (A200)

The QA `visual` focus is carried over a fix round only when every changed path is provably not UI (A340). The `ui_path` signal reads the html-like globs of `config.yaml` and the frontend file types of `global.ui_paths.always` in `ecosystems.json` (`.html .htm .jsx .tsx .vue .svelte .astro .css .scss .sass .less .styl`), plus the script types `global.ui_paths.ambiguous` (`.js .mjs .cjs .ts`) only under a `global.ui_dirs` directory (`public assets www frontend ui components pages ...`, not `client web static views src/app`; scripts under `pages/api` or `app/api` never count) or a mapped surface, so server code raises no signal; extensions and folders compare without case. An existing pass survives a change only to strict test code (`*.test.*`, `*.spec.*`, `*_test.*` of a non-UI type, a root-level `tests/ test/ __tests__/ spec/ e2e/ cypress/` folder or a `__tests__/` segment), to a run file, to a document (`md rst adoc txt`) outside every surface path and `ui_dirs`, and, when the project maps surfaces (`design_docs.design.surfaces.<name>.paths`), to a file that is under no surface path or `ui_dir`, not a UI file, not a UI-driving file (`global.ui_config`: tailwind, postcss, vite, theme, tokens, styles, locales, routes) and not a dependency manifest. Without surfaces any other change makes it stale. Missing UI data makes the pass stale. Known edges: `docs/limits.md` A340.1.

A fix round is counted once for each distinct content that collected a blocking FAIL, plus one for each evidence-only repair (A325). A verifier's own retry is not a round (A326): a failing VERIFY followed by a passing VERIFY on the very same content, with no repair between them, counts as none; a failing review of unchanged content, a real fix and the bound itself (`max_fix_rounds`) are unchanged.

After a fix round, an amendment or a reopen a gate re-runs when its read-set changed (A353). The read-set is derived by the control plane, never taken from what an agent says it read: every gate record carries `readset_sha256` and a `<record>.readset` file (path and content hash of each file the gate reads), computed from the task-owned patch manifest. REVIEW_PLAN, RULES, DATA and SECURITY read the task-owned paths except test code (a SECURITY run also reads a test whose path names a security word); every other gate reads the whole patch, and the frozen contract is bound by every record. The read-set is the conservative superset of the task-owned diff: a gate that cannot prove its set unchanged runs again, and a record whose read-set file was edited or lists other files than the control plane derives from the record's own manifest is not trusted. A `pass` REVIEW_PLAN, RULES, DATA or SECURITY record is
carried over only when every changed path is a test path; SECURITY also runs when a changed test touches security behaviour (identity, authorization,
input validation, secrets). SECRETS, REVIEW_SMALL, REVIEW_TESTS, QA and VERIFY always run, and any product, dependency or configuration change, or a
change that cannot be determined, runs everything. `refreeze` invalidates only the gates whose input changed. The judged design audit is reused only for pages
whose screenshots are byte-identical (measurement is always recomputed). The verifier's re-run ignores a short tested list of volatile fields (ISO
timestamps, `HH:MM:SS`, durations, the trailing duration of the `[build] Complete!` line); counts, names and exit status stay exact (`agent.sh repro-normalize`).
A debug-proof is required by the task type or label (`bug`, `defect`) and `decision: fix`, not by the word "fix" in the text; a reviewer may still ask for it.
`agent.sh design-rationales <ID>` lists the rationales and whether each is approved. `knowledge-done` checks the page, the secret scan and the wiki lint
before DONE and refuses when the lint cannot run. In a task of an approved night batch with no knowledge page, `knowledge-done` records `not_applicable` with a visible reason instead of asking you (A291); see [night mode](night-mode.md). The invariants these speed-ups must keep are the six "Core invariants" of CONTRIBUTING.md, tested in `tests/invariants-node/`.

Related: [workflow](workflow.md), [enforcement layers](enforcement-layers.md).
