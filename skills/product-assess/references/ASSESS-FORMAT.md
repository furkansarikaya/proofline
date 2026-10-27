# Assessment document formats

Every file lives in `<product.dir>/<slug>/`. An item starts at the beginning of a line as `- <ID> <text>`; indented lines below it belong to it. A field is `key: value` on its own indented line, or after `;` on the first line. Comments (`<!-- -->`) and code fences are ignored. Ids are unique per file and never renumbered once referenced.

## ASSUMPTIONS.md (`check-assumptions.mjs`)

```markdown
- AS-1 Finance wants CSV instead of a spreadsheet, because of C-2. [assumption: value] importance: high; evidence: low; riskiest: yes
- AS-2 One engineer can build the export in a sprint. [assumption: feasibility] importance: medium; evidence: medium
- AS-3 Between 30 and 70 percent of the clerks would switch. [assumption: value estimate "one interview, so the range is wide on purpose"] importance: high; evidence: low; riskiest: yes
- AS-4 The accounting tool imports a comma-separated file in every locale. [assumption: feasibility source agent accepted by user] importance: high; evidence: low; riskiest: yes
```

- Exactly one `[assumption: <risk>]` marker; risk is `value`, `usability`, `viability` or `feasibility`.
- `importance` and `evidence`: `high|medium|low`. A number, `score:`, `rank:` or `3/5` is rejected (`numeric-score`).
- `riskiest: yes` exactly when importance is `high` and evidence is `low` (rule `riskiest`).
- Name the claim ids (`C-n`) the assumption rests on; the trace links a requirement's `[fact: ref <slug>#C-n]` to the assumption that names `C-n`.
- A number in the statement is an estimate with a basis, `[assumption: <risk> estimate "<basis>"]` (a range and why that range); without it the check says `unsourced-number`. The levels `importance` and `evidence` stay words.
- The agent contributes: at least 5 assumptions the user did not state, each `source agent accepted by user` (or `changed by user`) in its marker, or listed as rejected under `## Rejected proposals` (`- RP-1 <assumption> rejected by user: <reason>`); rule `min-proposals`. A `[proposal: ...]` marker left in the file is `pending-proposal`.

## PROBES.md (`check-probes.mjs`)

```markdown
- PB-1 Offer CSV export to five finance users for one week, tests AS-1.
  success: at least 3 of 5 users export without help
  failure: fewer than 2 of 5 users export
  locked: 2026-10-22T10:00:00.000Z sha256:<64 hex>
  result: confirmed
  evidence: five session notes in INTERVIEWS.md, INT-4 to INT-8
```

- Names the `AS-n` it tests. Both thresholds are required before the lock.
- `check-probes.mjs <slug> --lock PB-n` appends `locked:` (UTC timestamp and the sha256 of the lower-cased, whitespace-collapsed `success` and `failure` text). It refuses a probe that is locked, has a result or lacks a threshold.
- `result: confirmed|refuted|inconclusive` needs a lock; the thresholds must still hash to the lock. In a git-tracked file the earliest committed lock of the probe must equal the current hash.
- Between the two thresholds the result is `inconclusive`.

## PREMORTEM.md (`check-premortem.mjs`)

```markdown
- RK-1 Finance keeps the spreadsheet because the CSV columns differ. kind: real; response: map the columns with finance before the build (PB-2)
- RK-2 The first real month has refunds the test shop never had. kind: unspoken; response: ask finance for the refund rule (Q-1); source: agent accepted by user
```

`kind`: `real` (named and agreed), `overstated` (named, smaller than feared), `unspoken` (nobody said it before the premortem). Every risk has a response; "accept" is a response only with the reason.

`source:` is `user` (the default, may be left out), `agent accepted by user` or `agent changed by user`. The agent contributes at least 5 risks the user did not state: accepted ones carry the `source:` field, rejected ones are listed under `## Rejected proposals` (`- RP-1 <risk> rejected by user: <reason>`); rule `min-proposals`.

## REDTEAM.md

Written by the reviewer ([REDTEAM.md](REDTEAM.md)); not checked by a script. One `## AS-n` section per attacked assumption (the heading names the assumption, and the section names the claims `C-n` it uses), each with a `result: holds|weakened|broken` line.

## DECISION.md (`check-decision.mjs`)

```markdown
decision: build

- DEC-1 Build the CSV export first, on the evidence of PB-1 and AS-1.

## Context
## Decision
## Consequences
## Rejected
```

One effective `decision: build|clarify|stop` line. The four sections are not empty. The file names an `AS-n` or `PB-n`. `stop` blocks `check-prd.mjs --ready`; `clarify` means the open questions come first.

## OUTCOME.md (`check-outcome.mjs`)

```markdown
- OC-1 Share of orders exported one month after launch, follows DEC-1 and FR-1.
  metric: M-1
  baseline: 12 per week
  target: >= 40
  script: scripts/export-share.mjs sha256:<64 hex>
  output: outcome/OC-1.out sha256:<64 hex>
  value: 47
  result: reached
  follow-up: continue
```

- `metric` is an id of the slug's `PRD.md`. `script` is a path from the project root; `output` is `outcome/<OC-n>.out` from the slug folder; both carry the sha256 of the file.
- `value` equals the `value: <n>` line of the output file (else its last line). `target` is `>=`, `<=`, `>`, `<` or `=` and a number; `reached` and `not-reached` must follow from `value` and `target`; `inconclusive` is allowed when the measure was unreliable (say why in the text).
- `follow-up`: `continue`, `change` or `drop`.
- `--rerun` runs the script and compares the sha256 of its output with the recorded one.
- The line names a `DEC-n`, a `PB-n` or a requirement id so the trace reaches it.
