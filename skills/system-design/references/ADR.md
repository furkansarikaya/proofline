# ADRs

Write an ADR only when all hold: a decision with lasting consequences, at least two real alternatives, and evidence (repo or task) that separates them. Otherwise record one line in `tradeoffs`.

File: `<adr_dir>/NNNN-<kebab-slug>.md`; NNNN = highest existing number + 1 (read the directory; never reuse or renumber). Format:

```
# NNNN. <Title: the decision, not the problem>

Status: proposed | accepted | superseded by NNNN | deprecated
Date: <YYYY-MM-DD>

## Context
What forces the decision: requirement (AC id or task text), current constraint (path:symbol).

## Decision
What is decided, in one or two sentences, active voice.

## Alternatives considered
- <alternative>: why not (evidence).
- <alternative>: why not (evidence).

## Consequences
What becomes easier, what becomes harder, what must follow (migration, contract change, follow-up task).
```

In a run the new ADR is `proposed` and stored under `design/adr/`; the knowledge step moves it to `adr_dir` and sets `accepted` once the plan is approved. Never edit an accepted ADR's decision: supersede it with a new one and change only the old one's Status line.
