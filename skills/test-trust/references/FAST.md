# Fast and deterministic tests (REVIEW_TESTS, issue 265)

Question answered: **"Do the tests this change added or edited wait for real, read the system clock, run over their budget, or escape measurement?"** Diff mode only, inside a run. Nothing here is measured by test-trust: the control plane measured it (package B), and you read it and judge it.

## 1. The input

Run once and save the output under `evidence/` (`evidence/test-scan.txt`, command `agent.sh build-record <TASK-ID> scan`; `--json` gives the same facts as JSON):

- `candidate: <file>:<line> <kind> <pattern> | <line text>`: the files the task added or changed, found by the ecosystem data (`fast_tests` in `ecosystems.json`). `wait` is a sleep or timer call (test files); `clock_read` is a direct clock read (test files and other code files). A candidate is a TEXT match: a name inside a string or a comment is a false positive.
- `plan-exception: wait|budget <target> -- <reason>`: the only justification the gate accepts (PLAN `## Test exceptions`, frozen with the plan).
- `measurement:` the `test-measure` ledger row, a `NOT MEASURED` line when nothing was run twice, each GREEN command with its `source` (`plan-listed`, `project test command` or `neither`), the plan's tests with no recorded duration, the recorded durations and the `BUDGET` findings.

The scan exits 1 when it lists a candidate. That is information, not a failure of your run.

## 2. Findings

One finding per candidate or per fact. `observed` shapes are in the schema (`observedCandidate`, `observedOverBudget`, `observedNotMeasured`).

| kind | when | verdict |
|---|---|---|
| `real_wait` | a `wait` candidate in a test file | `confirmed` when `traced` (you followed the path from the test to the wait; `trace` says how) or `untraced` (you could not rule it out: it stays a finding, the safe side). `cleared` only as `false_positive` (`reason` of at least 30 characters that names the traced path: the file name and the line number or the matched text, for example "retry.test.js:8 setTimeout is inside a string literal") or `plan_justified` (`plan_exception`: the exact `- wait:` line of PLAN `## Test exceptions`). |
| `clock_not_injected` | a `clock_read` candidate in a changed test or in changed code the tests exercise, where the time-dependent code reads the system clock itself instead of taking a clock (a parameter, a constructor argument, a provider) | `confirmed` traced or untraced, or `cleared` as `false_positive`. The plan cannot justify it. A test that only builds a fixed date from literals is a false positive. |
| `over_budget` | a `BUDGET test` finding of the measurement | `confirmed` with `measured_ms` and `budget_ms` copied from it (`budget_source` plan or config), or `cleared` as `plan_justified` with the exact `- budget:` line. A `BUDGET suite` finding is reported the same way with the suite as `test`. |
| `not_measured` | `NOT MEASURED` or `NOT SCANNED` in the input; a plan test with no recorded duration; a GREEN command whose `source` is `neither`; a stability or duration finding in the `test-measure` row; or a double-run command that does not execute a changed test | `confirmed` with `reason` and `detail`. Never cleared by you: only a `- measure:` line of the plan that quotes it clears it. |

Confirming that the double-run command really executes the tests is YOUR job (package B only checked that the command is plan-listed or the pinned project test command): read the command and the project's runner configuration, and compare with the task's test files. A command that runs a different suite, or filters the new tests out, is `command_does_not_run_test`. A test the plan names with no recorded duration is `no_recorded_duration`.

## 3. Rules

- A time-dependent test passes a fake clock; a plan exception is for a wait that cannot be faked (a real process signal, a socket), never for a clock the code could take by injection.
- Never lower a budget, edit the plan or the scan output, or run the tests yourself to replace a missing measurement: report `not_measured` and stop there.
- Every candidate, every `BUDGET` line and every NOT MEASURED or NOT SCANNED fact needs a finding of its own (`submit` checks this in a measured run): passing one over by not mentioning it is refused. `over_budget` for a suite names the suite as the test, `suite unit`.
- A finding and a plan line are bound to the OBLIGATION, not to your wording. A wait or clock finding names the candidate's `file`, `line` and `pattern` exactly as the scan printed them; an `over_budget` finding's `test.name` is the BUDGET line's test name (`suite unit` for a suite); a `not_measured` finding's `observed.subject` is exactly: the file for `file_not_scanned`, the plan test for `no_recorded_duration`, the command for `command_not_double_run`, and the reason itself for `no_test_measure_row`, `not_double_run` and `measurement_finding`, and `ecosystems.json` for `definition_changed` (the scan input says the definition changed since the run started). One finding per obligation. A plan line clears a finding only when its target is that obligation's: a `- wait:` line names the candidate's file (the same path, or its end on a directory boundary, with an optional `:line`), a `- budget:` line the test name (equal), a `- measure:` line the subject. A line for another target, or a name that merely contains the target, clears nothing.
- A finding of these kinds is `blocking` when `confirmed`; a `cleared` one is listed in `REPORT.md` only. `validate-findings.mjs --plan <PLAN.md>` checks that a quoted `plan_exception` is a line of the plan.
