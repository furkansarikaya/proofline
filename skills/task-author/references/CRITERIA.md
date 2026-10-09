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

The validator's heuristics (observable-verb list, vague-word list) catch the obvious cases; it cannot judge the rest, so the self-check below is still required.

## Out of scope
Things a reader could assume are included and are not; deliberately deferred behaviour; other components. At least one line.

## Constraints
Only what the user stated or the repository forces (language, existing API shape, compatibility, deadline), each with its source. "None stated." is valid.

## Risks
What could make the task larger or wrong: unclear boundary, shared code, data that cannot be rolled back, missing tests around the area. Each risk names what it would change.

## Suggested class
See [CLASSES.md](CLASSES.md).

## Verification commands
The project's own commands that prove the criteria (`commands.test`, a named test file). Never invented; if unknown, ask.

## Self-check

Run each item; any "no" is fixed before returning.

1. Every `AC-n` is observable behaviour (a verb a test can assert).
2. No criterion dictates implementation unless the user stated it, and then the statement is also in Constraints.
3. Criteria are numbered from 1, no gaps, each is one behaviour.
4. Out of scope is explicit and non-empty.
5. Every line traces to the request, the issue, or a `path:symbol` fact; nothing was invented.
6. The class matches the highest indicator and names it.
7. No placeholder (`<...>`, TBD, TODO, `QUESTION-n`) remains.
8. Open questions were asked in one round, or there are none.
9. The validator exits 0.
