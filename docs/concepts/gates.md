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
come from `review.risky_paths` plus, at read time, the manifests, lock files, package-source settings and
build-changing files of every ecosystem in `.agents/ecosystems.tsv` ([ecosystems](ecosystems.md), A174). Code-like Markdown (`.agents/**`, `skills/**`, `roles/**`, agent definitions,
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
the runtime version the project's CI specifies with the one installed here (`skills/verify-proof/scripts/runtime-versions.sh`,
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
`cookie`, `email`, `phone`, `card`, `iban`, `ssn`, `tckn` (config `risk.log_sensitive.content` and `.words`, both
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
- **REVIEW `config`** (proof-review). `skills/proof-review/scripts/check-config.mjs` judges only the lines the
  change adds: a variable read in code or `${VAR}` in config that no example env file, config sample or document
  defines; a secret in plain text in a config file (masked, `proofline:allow-secret` marks a deliberate fake);
  a feature flag added with default on that the plan does not name; a flag removed while still referenced.

Other FAIL rules: a failing test that also fails at the base in a clean worktree is reported as pre-existing;
a new dependency not named in the plan is a FAIL; so is a change to a versioned contract the plan does not name. Inside the plan scope, a hunk that changes behaviour and ties to no acceptance criterion is a blocking finding of the plan review (A153); a hunk that does not change behaviour (formatting, comments, import order), and any hunk the reviewer is unsure about, stays informational.

## Fix loop

A FAIL goes back to the implementer (same worktree). Each round carries the previous findings; only gates made
stale by the change re-run. `review.max_fix_rounds` defaults to 2 and round 2 escalates to a stronger model.
If findings remain after the last round the run ends `terminate FAILED`, commit and push stay locked, and the
lead reports what remains. There is never an endless loop.

Three rules keep the loop fair (A171). A rules review scans for the whole class of a finding in one pass and records
the scan and every instance, so the examples are fixed together. A failing record whose every blocking row cites a
line that was already in the previously reviewed revision (and was not cited before) is a missed example and does not
use up a round. Blocking or info follows a written rule (`GATES.md`), and the same observation keeps its
classification from round to round. A mutation budget overrun in the tests review (21 of 20) is a warning, not a block.

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
