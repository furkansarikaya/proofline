# Red team

The red team is the reviewer role with focus `strategy`: an independent agent that did not write the plan, the assumptions or the decision, and attacks the assumptions the plan trusts most. The procedure (most-trusted assumptions, restate each at its strongest, attack, judge) is in product-spec `references/STRATEGY-REVIEW.md`; this page says how the assessment uses it. The red team also holds the documents to the [quality bar](QUALITY-BAR.md) and writes a `## Quality bar` section with one line per question.

## Start

The main session starts the reviewer through the proofline lead (focus `strategy`, outside any run) with the slug. The reviewer reads `<product.dir>/<slug>/` (PRD.md, ASSUMPTIONS.md, PROBES.md, PREMORTEM.md, DECISION.md when present, and the discovery files), edits nothing, and writes `REDTEAM.md`. This skill never reviews its own assumptions.

## File layout

```markdown
round: 1

## AS-1
Strongest form: <the assumption as its best defender states it, with claim ids such as C-3>
Attack: <the cheapest observation that would show it false; the nearest alternative explanation>
Evidence: <what is on disk that points that way; `unverified` for what could not be checked>
result: weakened

## Quality bar
- concrete: <pass | fail: the line -> the fix>
- sourced: <pass | fail: ...>
- new: <pass | fail: ...>
- unknowns: <pass | fail: ...>
- so what: <pass | fail: ...>
- consistency: <pass | fail: two lines that contradict, e.g. two risk responses>

## Summary
- AS-1 weakened: <what the plan must change or test before it relies on it>
```

- One `## AS-n` section per attacked assumption, at most five, the most trusted first. The section names the claims (`C-n`) it relies on, so the trace can follow them.
- `result: holds|weakened|broken`. Never a numeric score.
- At most 2 rounds. After the author answers (new evidence, a probe, a changed plan) the reviewer runs once more and sets `round: 2`. A `broken` assumption after round 2 goes back to the user to decide.

## After the review

For each `weakened` or `broken` assumption the main session offers: a new probe (a new `PB-n`, never an edited threshold), a changed plan, or a recorded decision to proceed with the risk. A `DECISION.md` that says `build` while a `broken` assumption stands names that assumption and the reason in its Consequences section.
