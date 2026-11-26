# Writing the sections

## Goal
One or two sentences: who gets what and why, in the user's terms.

## Context
Facts only: what exists today (`path:symbol`), links the user gave, stated assumptions (`Assumption: ...`, only after a NEEDS_INPUT round).

## Acceptance criteria
Format, one per line, numbered from 1 without gaps: `AC-1: <situation> -> <observable outcome>`; a continuation line is indented.

A good criterion:
- names the trigger (input, state, user action) and the observable result;
- has a concrete value where one exists (status code, message text, count, limit);
- can be falsified by one test;
- describes one behaviour (split "and" chains that can fail separately).

Includes the unhappy paths the request implies (invalid input, unauthorized, not found) as their own criteria, but does not add behaviour the user did not ask for.

Rewrite examples:

| Rejected | Why | Accepted |
|---|---|---|
| The login is secure | not observable | AC-1: The sixth failed login for one account within 10 minutes returns HTTP 429 |
| Errors are handled properly | vague | AC-2: A request with a missing `email` returns HTTP 400 and the body names the field |
| Use Redis for the counter | implementation | (constraint, only if the user said so) |
| It should be fast | not testable | AC-3: `GET /report` for a 10k-row account returns within 2 seconds (the user's number) |

### Count and feasibility

Write **3 to 6** outcome-focused criteria (U4, A366). Fewer than 3 usually means a vague task; more than 6 means several outcomes in one task: group the criteria by outcome (what the user sees, what is stored) or split the task. A criterion states the result, not the steps, and gives a number, a path or an exact message. `validate-task.mjs` WARNS (exit 0) with the count when the task has fewer than 3 or more than 6; it never refuses.

Before the task is final, check each criterion that rests on a library, a version, a limit, a selector or an operator against the pinned tool: read the version in the manifest or lockfile and the library's documentation for it (a quick check, not a prototype). Record it as one indented line under the criterion:

    - AC-2: The list page shows only the direct children of the node.
      Feasibility: lib@2.1.0 (package.json); its docs list no `>` combinator, so the criterion names the `.child` class instead

An example of what this prevents: a criterion that asked for a `>` selector the pinned library could not match, found only at the end of the run (R4-8). A criterion that names a library, version or limit without a `Feasibility:` line gets a validator warning, never a refusal; when the check shows the criterion cannot be met, rewrite the criterion (or ask) before the task is final.

The validator's heuristics (observable-verb list, vague-word list) catch the obvious cases; it cannot judge the rest, so the self-check below is still required.

## Out of scope
Things a reader could assume are included and are not; deliberately deferred behaviour; other components. At least one line.

## Constraints
Only what the user stated or the repository forces (language, existing API shape, compatibility, deadline), each with its source. "None stated." is valid.

## Risks
What could make the task larger or wrong: unclear boundary, shared code, data that cannot be rolled back, missing tests around the area. Each risk names what it would change.

## Pre-existing defects

A defect the work runs into that the user did not ask about is never an acceptance criterion and never the recommended answer of a question. Write it under `## Pre-existing defects` as `decision: report` (leave it unchanged; the completion report names it). `decision: fix` is written only when the user's own words ask for the fix; the freeze then needs the user's `scope` approval. The validator and `agent.sh freeze` enforce the declaration (A105): in a COMPLEX or CRITICAL task whose request (title, Goal, the user's quotes, Suggested class line) names no defect, a Context, criterion, constraint or risk line that speaks of a defect or a fix needs at least one entry here, and every entry carries `decision: report` or `decision: fix`. A delegated answer ("use your recommended option") never turns a defect fix into requested work: the fix is not a criterion and not a Context decision. A criterion that cannot be met without the defect fixed is reworded to what can be observed without it, or asked as a question whose recommended option is "report it, out of scope".

## Test exceptions

Optional. The plan of a task may later need a line of its own `## Test exceptions` (a real wait, a test over its budget, an unmeasured test) before the tests review accepts it, and in a night batch no one is there to approve it then. You may PROPOSE the line in the task file in advance, so the batch summary shows it to the user (task, sha256 of the exact line) and the user's "approve batch" accepts it (A285, A294). It is a proposal of an agent, never an approval: the plan still has to carry the identical line, and an exception that was not proposed here still parks the task.

Write it only when you can foresee a real need from the request and the repository: a test that must receive a real process signal, an end-to-end test that must wait for a real browser, a test that must measure a slow external thing. Never as a blanket, never "in case", never for a test you could design without the wait. First prefer the design without the exception (an injected clock, an event, a fake); propose only when none of those can replace the real thing. The reason says which real signal, browser or measurement is involved and why an injected clock or an event cannot replace it (at least 20 characters; vague text such as "needs to wait" is not a reason).

Format, one line per need (the exact grammar of the plan):

    ## Test exceptions

    - wait: `tests/e2e/login.test.mjs` -- the test drives a real browser and waits for its load event, no clock or event of ours stands in for it
    - measure: `tests/perf/import.test.mjs` -- times a real import against the external service, a fake would measure nothing

`wait`, `budget` or `measure`, then the test file in backticks (for `budget` the test name in double quotes), then ` -- ` (or an em dash) and the reason. The target must be the full repo-relative path (with the test name in double quotes or `:line` where the grammar allows): a bare basename such as `sleepy.test.js` clears every finding of that file name in any directory, and a wildcard matches nothing (targets are exact). State that reach in two sentences so the user accepts exactly what they picture. Do not pad, trim or reformat a line after you wrote it: the batch hashes its exact bytes. The validator refuses a malformed line, and so does `proofline batch` (it stops with the task id, the line number and the reason; nothing is planned until the line is fixed). The github, jira, linear and markdown templates carry the section, so an exported task keeps it. The batch lists at most 50 lines per task and none over 1000 bytes (the validator refuses more). No section means no proposal; the section is not part of the class or of any criterion.

## Suggested class
See [CLASSES.md](CLASSES.md).

## Verification commands
The project's own commands that prove the criteria (`commands.test`, a named test file). Never invented; if unknown, ask.

## Self-check

Run each item; any "no" is fixed before returning. Run `validate-task.mjs` before the task file is committed (A366): its warnings (criteria count, Feasibility) are read, not ignored.

1. Every `AC-n` is observable behaviour (a verb a test can assert).
2. No criterion dictates implementation unless the user stated it, and then the statement is also in Constraints.
3. Criteria are numbered from 1, no gaps, each is one behaviour.
4. Out of scope is explicit and non-empty.
5. Every line traces to the request, the issue, or a `path:symbol` fact; nothing was invented.
6. The class matches the highest indicator and names it.
7. No placeholder (`<...>`, TBD, TODO, `QUESTION-n`) remains.
8. Open questions were asked in one round, or there are none.
9. The validator exits 0.
10. Two-engineer test (A202, every source, not only a PRD): would two engineers who never spoke build the same thing from each criterion? A place where they would not is rewritten with a number, a path or an observable result, or asked as a question. The validator already refuses the ambiguous words of product-spec's list in a task that names no PRD.
11. 3 to 6 criteria, or the reason for another count is in the report; each criterion that rests on a library, version or limit has its `Feasibility:` line.
12. In a split: every `depends_on` was derived from the tasks' content and `validate-task.mjs --check-deps <dir>` exits 0 ([PLANNING.md](PLANNING.md#dependency-check)).
