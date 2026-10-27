# Examples

One shallow and one good example for the assessment documents. They show quality, not format; the format is in [ASSESS-FORMAT.md](ASSESS-FORMAT.md). Names are invented. The examples sit inside code fences on purpose: a checker never reads them, and you never copy them into a real document.

## ASSUMPTIONS

Shallow:

```markdown
- AS-1 Users will like the feature. [assumption: value] importance: high; evidence: low; riskiest: yes
```

Good:

```markdown
- AS-1 At least half of the finance clerks who copy orders by hand would use a CSV export instead, because of C-1. [assumption: value estimate "half is a guess from one interview; the range 30 to 70 percent is what a probe with five clerks can tell apart"] importance: high; evidence: low; riskiest: yes
- AS-2 The accounting tool accepts a CSV with a comma as the separator in every locale of our users. [assumption: feasibility source agent accepted by user] importance: high; evidence: low; riskiest: yes
```

Difference: the good assumption can be shown false by one observation, carries its number as an estimate with a basis, and one of the two is a candidate the user never raised.

## PREMORTEM

Shallow:

```markdown
- RK-1 The project may be late. kind: real; response: plan well
```

Good:

```markdown
- RK-1 The export is correct in the test shop, and the first real month has refunded orders that make the totals disagree with the accounting tool. kind: unspoken; response: ask finance for the refund rule before the build (Q-1); source: agent accepted by user
```

Difference: the good risk tells a story that only this product can have, names a response that changes the plan, and was raised by the agent and accepted by the user; the shallow risk fits every project.
