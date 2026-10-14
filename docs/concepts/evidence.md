# Evidence, assumptions and unsupported checks

proofline claims only what it can show. This page explains the vocabulary that every gate and skill shares.

## Evidence classes

Every finding carries one class. The class decides what the finding may do.

| Class | Meaning | Can close a gate alone |
|---|---|---|
| `measured` | a tool or script observed it (a number, a rendered state, a diff result) | yes |
| `reproduced` | a test or command made the problem happen, and the command is recorded | yes |
| `traced` | a concrete path through the code (`file:line` per step, checked against the repository) | yes |
| `judged` | an opinion: hierarchy, density, naming, a pattern that looks risky | no |

A `judged` finding fails a gate only when it violates a criterion that is written in the spec or the plan. Judged
findings are reported in their own section so they are never mistaken for proof. There is no numeric confidence
score: the class plus the content fingerprint is the whole statement (decision A91).

A PASS means "no proven problem was found", never "safe". Risks that were examined but could not be proven are
listed separately in the result.

## UNSUPPORTED

A check that needs a tool the project does not have (a browser, a benchmark command, a throwaway test database, a
parser for a contract format) reports `UNSUPPORTED`. proofline installs nothing to make a check run.

- `UNSUPPORTED` is never counted as a PASS: the claim stays unproven (A98).
- By default (`risk.unsupported: report`) it does not block its gate; the completion report lists it under
  `## Unsupported Checks`, one line per check with `not proven: <what>`, and never asserts it as verified.
  `risk.unsupported: block` makes it a blocking finding that only the user can waive.
- UNSUPPORTED is itself evidence-backed (A102): the result cites the skill validator's saved output that says
  `RESULT: UNSUPPORTED`, bound by its sha256, and the control plane refuses it when a contract or `.sql` migration
  file it detected in the diff is missing from that output. A reason alone is not enough.
- A tool that exists but cannot run (no network for an audit tool) is recorded as `tool_unavailable` in the report.
- Noise is not unsupported: a performance measurement whose spread exceeds the threshold is `INCONCLUSIVE`, which is
  neither a FAIL nor a PASS, and the report says so. It is submitted as UNSUPPORTED with an `INCONCLUSIVE:` reason
  and is blocking in both modes (a measurement ran and was unreliable; the user decides).

## Assumptions

`EVIDENCE.md` and `PLAN.md` carry a mandatory `## Assumptions` section: `none`, or one row per assumption with its
text, source, risk (low, medium, high), verification method, status (verified, unverified) and the decisions it
affects. An unverified high-risk assumption stops the freeze: the lead asks the user (NEEDS_INPUT) and the assumption
is accepted only by the user's own prompt starting with `accept AS-<n>`, and is then listed as `accepted-by-user`.
Unverified and accepted assumptions appear in the completion report. Details: [workflow](workflow.md#assumptions).

## Risk-adaptive checks

Deterministic risk signals add focused checks inside the existing gates (contract, concurrency, performance,
migration, visual, dependencies, config). See [gates](gates.md#risk-signals). Each check is a skill that applies the
classes above: contract-proof, concurrency-proof, performance-proof, visual-proof, data-design (migration
validation), exploit-proof (dependencies) and proof-review (config).

## Metrics, insights and benchmark

- **Metrics** (`.agents/local/metrics/`): time, runtime-reported tokens (never estimated), turns, retries,
  delegations and gate results per run. See [metrics](metrics.md). `metrics: off` disables all of it.
- **`proofline insights`**: a read-only report of cost per run, role and model, and of recurring failures with
  suggestions. It never changes a rule, skill or config.
- **Benchmark** (`node tests/benchmark/benchmark.mjs`): scores recorded results of the existing fixtures and
  end-to-end runs per skill (correct, missed, false positives, scope adherence, duration, tokens). It invents no
  scenario and calls no model. It is a report, not a gate.

## What proofline deliberately does not do

No new agent for a new capability, no end-of-task quiz, no separate decision memory, no confidence number, no style
catalogue for UI design, and the agent never deploys or releases. Reasons and rejected alternatives: decision A91 in
the [design decisions](../decisions.md).
