# Testing

This page lists what tests each capability. The README links here.

## Risk signals and their tests

**Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script; tested by the control-plane self-tests and the `risk-signals` fixture. The `dependencies` focus (manifest diff, license policy, the project's own audit tool when it exists; fixture `dependency-audit`) and the `config` focus (fixture `config-consistency`) have tool-free checks. The `concurrency` focus runs the concurrency-proof skill (tested: skill tests and the `concurrency-proof` fixture). The migration focus is data-design's migration validation (throwaway database of the project's own test suite, otherwise UNSUPPORTED); its helpers and report validator are tested by the `migration-validation` fixture and `tests/skills`. The QA `visual` focus runs the `visual-proof` skill (measured checks in a browser the machine or project already has; without one UNSUPPORTED): its report validator and depth rules are tested in every pull request, and the browser measurement of its fixture is run by a main/nightly CI step and is UNSUPPORTED where no browser is found. The `performance` focus runs the performance-proof skill (base against change with the project's own benchmark, interleaved runs, median and bootstrap interval; noise is INCONCLUSIVE, never a FAIL or a pass); its decision rule, validator and runner are tested by the `performance-proof` fixture and `tests/skills`, not on a real benchmark in CI. The `contract` focus runs contract-proof (tested: skill tests and the `contract-proof` fixture). Every risk focus now has its skill; a check that cannot run reports UNSUPPORTED, which is never a pass: by default it is unproven and reported (listed in the completion report with what it leaves unproven, the gate is not held), `risk.unsupported: block` makes it a blocking finding only the user can waive, and an INCONCLUSIVE measurement always blocks. An UNSUPPORTED result must cite the skill validator's own saved output, and the script cross-checks it against the contract and migration files it detected in the diff, so a reason line alone never skips a check (tested by the control-plane self-tests with the skills' real validator output).

## Capabilities and what tests them

"Tested" below means a test that runs in CI (on every code pull request; documentation-only pull requests skip the test jobs) or in `sh tests/selftest.sh`. "Tested on fixtures" means planted data with known answers (`fixtures/*/EXPECTED.md`) exercises the check, together with its validator or helper scripts. The end-to-end team runs and their results are in [tests/e2e/README.md](../../tests/e2e/README.md#capabilities-the-n--items).

| Capability | Status |
|---|---|
| Risk-adaptive pipeline (`agent.sh pipeline`, focuses inside the existing gates) | tested (control-plane self-tests, `risk-signals` fixture) |
| Assumption register (`## Assumptions`, freeze stop, completion report) | tested (self-tests, plan and evidence validators) |
| Metrics (`records.jsonl`) and `proofline insights` | tested (self-tests, CLI test, `insights` fixture); tokens only where a runtime reports them |
| evidence-map `impact` mode | tested on fixtures (`impact-map`, skill tests); static analysis limits stated in every report; not exercised by a team run |
| ui-design (creative direction, UX comparison, self-critique, `visual_proof` criteria) | tested on fixtures (`ui-design`, skill tests); not scored in a team run |
| visual-proof, report validator and depth rules | tested (skill tests on every code pull request) |
| visual-proof, browser measurement | run by the main/nightly CI step (`fixtures/visual-proof/browser-check.sh`); UNSUPPORTED where no browser is found |
| contract-proof | tested on fixtures (`contract-proof`, skill tests); compatibility tools of real projects not exercised |
| concurrency-proof | tested on fixtures (`concurrency-proof`, skill tests); a concurrent reproduction in a real project's test runner not exercised; not exercised by a team run |
| performance-proof | tested on fixtures (`performance-proof`, skill tests); not run against a real benchmark in CI; not exercised by a team run |
| data-design migration validation | tested on fixtures (`migration-validation`, skill tests); applying migrations to a project's own throwaway database not exercised |
| SECURITY `dependencies` and REVIEW `config` | tested on fixtures (`dependency-audit`, `config-consistency`); a project's own audit tool not exercised; not exercised by a team run |
| UNSUPPORTED reporting (A98, A102) and the database-unchanged check (A121) | tested (self-tests) |
| Benchmark report (`tests/benchmark`) | tested (its own known-answer test on every code pull request; full report on main/nightly CI) |

Skills and roles are counted from `skills/` (twenty-four method skills plus the `/proofline` entry skill) and
`roles/` (eleven roles); `sh adapters/generate.sh --check` and `sh docs/reference/generate-skills.sh --check` keep
the generated references in step with them. The self-tests (`sh tests/selftest.sh`), the skill tests (`node --test tests/skills/`) and the fixtures (`sh tests/fixtures/check-fixtures.sh`) hold more than 900 tests in all (counted 2026-10-17). A pull request takes about 8 minutes of wall time in CI (Linux only; A109).
