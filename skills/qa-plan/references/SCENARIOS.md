# Scenario design

Scenario line format (validated):

```
- QA-<n> (AC-<k>[, AC-<j>])[ [<category>]]: <one-line title>
  input: <concrete input or starting state>
  expected: <concrete observable outcome>
  execution: <auto | manual>
  run: <how it will be executed>
  reason: <manual only: why no automated way exists>
  human-check: <manual only: what the human observes>
```

Ids are unique across the file. Acceptance scenarios carry no category; adversarial scenarios must.

## Acceptance

- One or more per `AC-n`; the title restates the behaviour, `input` is a concrete case (real values), `expected` is what an observer sees (status code and body field, rendered text, row count, exit code, log line).
- Include the criterion's own examples. Where a criterion has a limit, the limit value itself is an acceptance scenario ("the sixth attempt"), not only an adversarial one.
- `run:` prefers an existing test selector or command; otherwise a script QA writes into the evidence folder; otherwise (only when nothing can run it) a manual scenario. Be specific enough that someone else repeats it.

## Execution: auto or manual

- Every scenario declares `execution: auto | manual`. `auto` = runnable with tools available in the repo or on this machine; prefer a headless check (start the server and assert on the HTML/JS output with node, or call the API) over a browser.
- `manual` only when no automated way exists. It must carry `reason:` (why nothing automated can check it) and `human-check:` (what a human observes). The report lists it as `not-run (manual)`; it never changes the verdict.

## Adversarial categories

Include a category only when it applies to a criterion; each scenario names the defect it would expose.

| Category | Applies when | Typical scenario |
|---|---|---|
| `boundaries` | numeric, length, size, date or count limits exist | at the limit, one below, one above, zero, empty, maximum length |
| `invalid-input` | the behaviour takes input | wrong type, missing field, malformed, unicode, injection-shaped strings where input reaches a query or a shell |
| `concurrency` | shared state, counters, queues, two actors | two simultaneous requests for the last unit; interleaved update |
| `idempotency` | retry-able operations, webhooks, jobs | same request twice; replay after timeout |
| `permissions` | roles, ownership, tenants | another user's id; missing or expired credential; lower role |
| `persistence` | stored data, migrations | restart between steps; existing rows before migration; rollback |
| `ui-states` | a screen or component | empty, loading, error, long text, narrow viewport, repeated click |
| `error-paths` | dependencies can fail | dependency timeout or error; disk full; partial failure midway |

A visual criterion (layout, overflow, truncation, wrapping, spacing, alignment, a narrow viewport) is executed by browser measurement with the `visual-proof` skill (element boxes, `scrollWidth` against `clientWidth`, computed styles, at the viewport widths the criterion names), and its `run:` line says so. A unit test that counts characters or assumes a font width does not observe layout; it is not the proof of such a criterion.

Mandatory (A162): an entry point that takes external input (HTTP endpoint, form handler, CLI argument, queue consumer, webhook) listed in the plan's `## Contracts` always gets at least one `invalid-input` scenario naming it, with an input the server must reject (the plan's `## Validation` line says what is accepted, the limits and where it is rejected: probe just outside each). `validate-qa.mjs plan --plan PLAN.md [--entry-words REGEX]` checks it, with the project's `validation.*` keys read from `.agents/config.yaml` (the same words as the freeze); only a mandatory entry point is checked, a bullet that merely mentions one is information. The scenario is adversarial, so it sits in `## Adversarial scenarios` (the validator refuses a category on an acceptance scenario).

Rules: no scenario without a criterion; no category listed "for completeness"; if nothing applies write `None applicable: <reason>` (for example a documentation-only change).

## Regression surface

Existing behaviour adjacent to the change that must keep working, each with the test or command that shows it today (run once in the baseline).
