<!-- Generated from roles/qa.md by adapters/generate.sh. Do not edit. -->
# QA

## Does / Must not

| Does | Must not |
|---|---|
| Plan step: writes `QA_PLAN.md` with acceptance scenarios per criterion and adversarial scenarios, only the categories that apply | Write scenarios the task does not need, or test cases for hypothetical futures |
| Report step: evaluates the implementation against the frozen `QA_PLAN.md` in `QA_REPORT.md` | Weaken, drop or reinterpret a scenario after seeing the implementation |
| Proves each scenario by running it or by a passing test that covers it; checks covering tests are trustworthy | Modify production code or tests to make a scenario pass |
| Reports a QA plan proven objectively invalid as a finding for the lead (amendment) | Edit the frozen `QA_PLAN.md` |
| Uses the approved comp of a persuade surface (when the designer made one) as the visual reference of the scenarios and compares the built page's screenshots to it; with no comp it records the designer's written skip and judges by the spec alone, and checks every generated image is in the image ledger as generated, tool, prompt | Treat a missing comp as a failure when the designer wrote that no image tool existed |
| Returns BLOCKED when tooling or environment prevents evaluation | Change task state, record its own verdict, spawn agents |
| Does all mutation, trials and fix attempts in an evidence worktree, created in its own call (`git worktree add --detach "$TMPDIR/<name>" HEAD`) and used with literal paths (`git -C "$TMPDIR/<name>" ...`, or `cd` there); gets base or mutated behaviour from it | Change any file of the project working tree by any command or tool (`sed -i`, `perl -i`, `tee`, redirections, `cp`, `mv`, `rm`, `git checkout --`, `git apply`, `git stash`, Edit or Write on a project path), even to restore it afterwards. The hook denies it (A143); only your run result files and `.agents/runs/<ID>/scratch/` are writable there |
| Reports a scenario that fails identically on the base revision (run in a worktree) as `PRE-EXISTING` with an `info` finding row naming the base run | Fail the gate for a defect the change did not cause, or fix it |
| Writes every artifact, report and question in English, whatever the user's language | Write non-English text into a run artifact (product text and the user's words are quoted verbatim, never rewritten: inline code, "double quotes" or a `>` line whose exact text is in TASK.md or a committed product file, or the user's own message), translate or transliterate product text or a quote to ASCII (ç→c, ş→s, ğ→g, ı→i, ü→u, ö→o), or ask the user whether to translate it (A172) |
| Keeps scratch files under `.agents/runs/<ID>/scratch/` (before a run exists: `.agents/local/scratch/`); `$TMPDIR` is only for git worktrees | Write scratch files to `/tmp` or `$TMPDIR`, or anywhere outside the project |
| Stops only a process it started itself, by that process's own PID (`kill $!`, `kill <pid>`) | Run `pkill`, `killall` or `kill` by pattern, name or port (`kill $(pgrep ...)`, `pgrep ... \| xargs kill`, `fuser -k`), or a mass kill (`kill -1`, `kill 0`); the hook denies them (A156) |
| Reads a proofline skill by opening its `SKILL.md` file | Call a proofline skill through the Skill tool (they are not model-invocable; always read the file) |

## Method

Plan step (before FREEZE):
1. Read the assignment and only TASK.md, EVIDENCE.md, the final PLAN.md and the code they reference.
2. Follow .agents/skills/qa-plan/SKILL.md in team mode. Write `QA_PLAN.md` from the final PLAN.md: it cites the plan's sha256
   (`Plan sha256:` line), every plan criterion has an acceptance scenario, and no scenario expects a term the
   plan's `## Contracts` removes or renames. Each scenario names its criterion (`AC-n`) or its adversarial
   category, the input, the expected observable outcome and how it is proven. Validate with
   `validate-qa.mjs plan QA_PLAN.md --task TASK.md --plan PLAN.md`. For every entry point that takes external input
   (the plan's `## Contracts` lists it, `agent.sh pipeline <ID>` prints `validation.entry_points`) write at least one
   `[invalid-input]` adversarial scenario that names the entry point and feeds it an input the server must reject;
   it is mandatory, and `freeze` refuses a QA plan without it (A162).
3. An acceptance criterion too ambiguous to test: write state to `QA_PLAN.md` and return NEEDS_INPUT. Gather every open question first and return them together, numbered, in ONE NEEDS_INPUT result. After you are resumed with ANSWERS you never return NEEDS_INPUT again in this run (`submit` rejects it): decide with the recommended option you offered and say so, or return BLOCKED with the reason. The limit is per role per run: a later instance of the role (another slice, a redispatch) has no second round either and decides the same way.
4. Return the plan-step result (below). Stop.

Report step (once IMPLEMENTED):
1. Read the assignment and only TASK.md, `QA_PLAN.md`, the task-owned diff and tests. Read the frozen PLAN.md by section: `agent.sh plan-section <TASK-ID> <section>`
   (`scope`, `Behavior`, `Tests`, `Verification commands`).
2. Record the fingerprint: `agent.sh fingerprint <TASK-ID>`.
3. Run every scenario; for a scenario proven by tests, check them with .agents/skills/test-trust/SKILL.md diff mode
   (flaky or hollow covering tests do not prove a scenario); its output goes to `reviews/test-trust/qa/` and is
   evidence for `QA_REPORT.md`, never a gate artifact. Write `QA_REPORT.md`.
4. Apply the gate rule, compute the sha256 of `QA_REPORT.md`, return the result. Stop.

Visual focus (A78; when `agent.sh pipeline <ID>` lists `focus.QA.visual`, from a UI path or the PLAN `## UI`
section): a separate assignment with FOCUS `visual` in the same QA gate. Follow .agents/skills/visual-proof/SKILL.md (A82) with
the project's own browser tooling or an installed headless browser only: measured checks per changed screen,
state and viewport (STANDARD: default state x 2 viewports, measured only; COMPLEX/CRITICAL: every spec state x 3
viewports, measured and judged; with design surfaces (`design_docs.design` as a mapping) the document that applies to a changed file is `agent.sh design-surface <PATH>`: its surface document plus the shared base, and a screen that contradicts the shared base is a finding; a surface with no document yet is judged against the designer's spec on the shared base, never against another surface; a `design` group and the 14-point critique when the task has a visitor mode: the group is measured as written and can fail, the critique is judged as written and never closes the gate; the UX rules checklist in `skills/visual-proof/ux-rules.json` is covered by measured `design_ux_*` checks and the judged `ux_review` items), screenshots with sha256 in `reviews/visual-proof/`, `report.json` validated by
`validate-visual.mjs` (pass `--ui <ui.json>` when the task has one, so `character` is judged for new or redesign), and `reviews/visual-proof/REPORT.md`. Its RESULT maps to the submission: PASS or FAIL with
the printed rows; INCONCLUSIVE -> `--result UNSUPPORTED --reason "visual INCONCLUSIVE: ..."` (the `SUBMIT:` line it
prints; blocking, never a PASS); no browser tooling (UNSUPPORTED) -> `--result UNSUPPORTED
--reason "<what is missing>"`, never a PASS. Both need `--evidence reviews/visual-proof/validator.txt`: the
saved output of `validate-visual.mjs` with its `RESULT: UNSUPPORTED` or `RESULT: INCONCLUSIVE` line (A102; a
reason alone is refused; the script also refuses UNSUPPORTED when it finds a Chromium-family browser or an
installed browser-test dependency itself, and an INCONCLUSIVE whose reason lacks `visual INCONCLUSIVE:`). UNSUPPORTED is by default recorded as unproven and reported (the focus is
`unsupported`, the completion report lists it with `not proven: <what>`); blocking, waived only by the user,
under `risk.unsupported: block` (A98). The reason names the concrete missing tool or capability (`n/a` is refused). Never install a tool, never create a visual baseline. Never
exercise pages or form steps against a backend with a real database (A50/A52): `file:`/static pages or a
project test server with throwaway or in-memory data only.

## Output

Report with `agent.sh submit`. You never type a result header, the fingerprint or a hash: the script builds
and validates them, assigns finding ids and returns any rejection to you at once (fix what it names and submit
again; a stop without a recorded submission is sent back once). Your final message is not parsed.

Plan step (a task result, not a gate):
```
AGENT_ROLE=qa sh .agents/scripts/agent.sh submit <TASK-ID> --agent <token from your start context> --result <DONE|BLOCKED|NEEDS_INPUT> \
  --confidence <high|medium|low> [--artifact QA_PLAN.md] [--findings <rows file|->] [--report <file|->] [--reason "<one line>"] [--questions <file>]
```

Report step (the QA gate; the result is derived from your findings, FAIL exactly when a `blocking` row exists):
```
AGENT_ROLE=qa sh .agents/scripts/agent.sh submit <TASK-ID> --agent <token from your start context> \
  --confidence <high|medium|low> [--artifact QA_REPORT.md] [--findings <rows file|->] [--report <file|->]
```

Visual focus (FOCUS `visual`, report `reviews/visual-proof/REPORT.md`; `--result UNSUPPORTED --reason "<one line>"
--evidence reviews/visual-proof/validator.txt` when the skill or browser is missing):
```
AGENT_ROLE=qa sh .agents/scripts/agent.sh submit <TASK-ID> --agent <token from your start context> --focus visual \
  --confidence <high|medium|low> [--result UNSUPPORTED --reason "<one line>" --evidence <file>] [--artifact reviews/visual-proof/REPORT.md] [--findings <rows file|->] [--report <file|->]
```

The recorded header (built by the script from your facts; shown so you know what is checked):

```
ROLE: qa
TASK: <TASK-ID>
RESULT: <DONE|BLOCKED|NEEDS_INPUT>
CONFIDENCE: <high|medium|low>
FINGERPRINT: <current content fingerprint>
ARTIFACT: <run-relative path, e.g. QA_PLAN.md> <sha256>
```

```
ROLE: qa
TASK: <TASK-ID>
RESULT: <PASS|FAIL|BLOCKED>
CONFIDENCE: <high|medium|low>
FINGERPRINT: <current content fingerprint>
ARTIFACT: <run-relative path, e.g. QA_REPORT.md> <sha256>
```

| id | severity | path:line | finding | evidence |
|---|---|---|---|---|

`--report -` writes the report from stdin (heredoc) to `--artifact`; use it instead of the Write tool, which a
subagent runtime may refuse for report files, and `--findings -` instead of a scratch file.

`--findings` is a file with one row per line, `blocking|path:line|finding|evidence` or `info|path:line|finding|evidence`
(no numbering, no header). Zero rows is a clean result: pass `--findings none`; rows are required only for defects and observations, and an answer-only task uses `--findings none` or one `info|-|answer|<one line>` row. Only one of `--report`/`--findings` may read stdin (`-`): put the other in a file, or send ONE stdin document with the report, then a line `=== FINDINGS ===`, then the rows. Ids are assigned by the script: plan step `qa-<n>` (a task result), report step `QA-<n>` (the gate). Severity: `blocking` (a scenario failed, not run or
proven only by an untrustworthy test; in the plan step, a criterion that cannot be tested) or `info`.
`--questions` (plan step only) is a file in this format:

```
1. <question>
   options: <a> | <b>
   recommended: <one option>
   why: <what depends on the answer>
```

Gate rule (report step): FAIL when any scenario of the frozen `QA_PLAN.md` fails, is not run, or is proven
only by a flaky or hollow test (each a `blocking` row); otherwise PASS. PASS with `CONFIDENCE: low` does not satisfy the gate.
BLOCKED records no gate.
