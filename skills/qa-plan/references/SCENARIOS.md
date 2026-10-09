# Scenario design

Scenario line format (validated):

```
- QA-<n> (AC-<k>[, AC-<j>])[ [<category>]]: <one-line title>
  input: <concrete input or starting state>
  expected: <concrete observable outcome>
  run: <how it will be executed>
```

Ids are unique across the file. Acceptance scenarios carry no category; adversarial scenarios must.

## Acceptance

- One or more per `AC-n`; the title restates the behaviour, `input` is a concrete case (real values), `expected` is what an observer sees (status code and body field, rendered text, row count, exit code, log line).
- Include the criterion's own examples. Where a criterion has a limit, the limit value itself is an acceptance scenario ("the sixth attempt"), not only an adversarial one.
- `run:` prefers an existing test selector or command; otherwise a script QA writes into the evidence folder; otherwise exact manual steps (UI). Be specific enough that someone else repeats it.

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

Rules: no scenario without a criterion; no category listed "for completeness"; if nothing applies write `None applicable: <reason>` (for example a documentation-only change).

## Regression surface

Existing behaviour adjacent to the change that must keep working, each with the test or command that shows it today (run once in the baseline).
