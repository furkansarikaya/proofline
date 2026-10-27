# Examples

One shallow and one good example for a PRD section. They show quality, not format; the format is in [PRD-FORMAT.md](PRD-FORMAT.md). Names are invented. The examples sit inside code fences on purpose: a checker never reads them, and you never copy them into a real PRD.

## Problem and completeness

Shallow:

```markdown
## Problem

Users find exporting orders hard. [assumption: usability]
Who: users.

## Completeness

- security: standard
```

Good:

```markdown
## Problem

Finance copies the monthly orders by hand from the orders page into a spreadsheet. [fact: interview INT-1 "I copy around 400 rows every month"]
Who: the finance clerks of a shop that closes the books in the first days of the month. [fact: interview INT-1 "we close the books in the first days of the month"]

## Completeness

- error and empty states: AC-2
- permissions and roles: Q-2 asks whether a clerk without the finance role may export
- security: not applicable to this project
```

Difference: the good section names the person, the situation and the evidence, answers the completeness topics with an id or says "not applicable to this project", and turns the permission gap into a question; the shallow one is true of any product and hides what nobody decided.
