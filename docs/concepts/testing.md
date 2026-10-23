# Testing

This page lists what tests each capability. The README links here.

## Risk signals and their tests

Risk signals cover contract, migration, UI, dependency and config paths, and plan flags. They add focused checks inside the gates. A script chooses the checks. The control-plane self-tests and the `risk-signals` fixture test them.

- **Dependencies:** the `dependencies` focus checks the manifest diff, the license policy and the project's own audit tool when it exists. The fixture is `dependency-audit`.
- **Config:** the `config` focus has tool-free checks. The fixture is `config-consistency`.
- **Concurrency:** the `concurrency` focus runs the concurrency-proof skill. Skill tests and the `concurrency-proof` fixture test it.
- **Migration:** the migration focus is data-design's migration validation. It uses a throwaway database of the project's own test suite. Otherwise it is UNSUPPORTED. The `migration-validation` fixture and `tests/skills` test its helpers and report validator.
- **Visual:** the QA `visual` focus runs the `visual-proof` skill. It makes measured checks in a browser the machine or project already has. Without a browser it is UNSUPPORTED. Its SEO group reads `robots.txt` per bot (Googlebot, Bingbot; RFC 9309) and counts analytics as loaded only when a third-party request before consent was measured. Every pull request tests its report validator and depth rules. A main/nightly CI step runs the browser measurement of its fixture. That measurement is UNSUPPORTED where no browser is found. For a project that produces public HTML pages the same skill also measures technical SEO (title, description, canonical, hreflang, one h1, Open Graph, structured data, sitemap, robots) and whether an analytics script runs before consent; a failed item blocks, an unmeasurable one is informational, and a project without HTML pages runs none of it. Content SEO is never judged. Visual verification works on native apps with the project's own test tools. The optional `design` group measures craft in the rendered page at 1440, 768 and 390 wide (heading lines, type scale, empty hero, vacuum, untitled sections, motion, reduced motion, no-script text, untranslated text, image ledger) and a source lint reads the pattern registry; failed items and blocking lint findings can fail the gate, while the 14-point critique (ok or concern with a reason, no score) never does. The implementer runs the same auditor as a self-check (look and fix, at most three rounds); QA's independent evaluation is unchanged.
- **Performance:** the `performance` focus runs the performance-proof skill. It compares base against change with the project's own benchmark, in interleaved runs, with a median and a bootstrap interval. Noise is INCONCLUSIVE, never a FAIL or a pass. The `performance-proof` fixture and `tests/skills` test its decision rule, validator and runner. CI does not run a real benchmark.
- **Contract:** the `contract` focus runs contract-proof. Skill tests and the `contract-proof` fixture test it.

Every risk focus now has its skill. A check that cannot run reports UNSUPPORTED, which is never a pass. By default it is unproven and reported. The completion report lists it with what it leaves unproven, and the gate is not held. `risk.unsupported: block` makes it a blocking finding only the user can waive. An INCONCLUSIVE measurement always blocks.

An UNSUPPORTED result must cite the skill validator's own saved output. The script cross-checks it against the contract and migration files it detected in the diff. A reason line alone never skips a check. The control-plane self-tests test this with the skills' real validator output.

## UX rules in visual-proof

`skills/visual-proof/ux-rules.json` lists the UX rules QA checks (rule id, severity, `measure`). A rule with a measurable id (`design_ux_*`, or an existing design check such as reduced motion) is measured by the auditor and can fail the gate; the rest are judged items (`ux_review`), each `ok` or `concern` with a reason. A test checks that every id exists in the design library when both skills are installed. The library's chart guide chooses the chart type for surfaces with charts. Focused UI changes (`design ui <mode> <target>`) are verified with `skills/ui-design/scripts/scope-check.mjs`, which fails when a changed path or hunk lies outside the target.

## Native output formats of visual-proof

visual-proof measures native apps only from structured output of tools the project already runs ([details](../../skills/visual-proof/references/NATIVE.md)). Two formats are read directly, by `native.mjs --normalize`, `--check` and `--build`:

- an **Android uiautomator XML dump** (pass `--density` so pixel bounds become dp);
- the **generic JSON** below.

For every other tool (Flutter, iOS XCUITest, React Native tools, screenshot-test tools) the project converts the tool's output to the generic JSON. proofline adds no parser for them, and a screenshot alone is judged, not measured.

Schema `visual-proof.native/1`: `platform` (`android|ios|flutter|react-native|desktop`), `os` (`android|ios`), `device {name, width, height, unit, font_scale, theme}` and `elements[] {id, role, label, interactive, bounds {x, y, width, height}, unit (dp|pt|px)}`; `text_clipped` and `contrast` are optional per element. The example passes `node skills/visual-proof/scripts/native.mjs --check example.json --os ios` (labels and touch target pass at 48 pt >= 44; large text and dark theme are listed `not_measured`):

```json
{ "schema": "visual-proof.native/1", "platform": "flutter", "os": "ios",
  "device": { "name": "iphone", "width": 390, "height": 844, "unit": "pt", "font_scale": 1.0, "theme": "light" },
  "elements": [ { "id": "pay", "role": "Button", "label": "Pay", "interactive": true,
                  "bounds": { "x": 0, "y": 0, "width": 48, "height": 48 }, "unit": "pt" } ] }
```

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

Skills and roles are counted from `skills/` (twenty-four method skills plus the `/proofline` entry skill) and `roles/` (eleven roles). `sh adapters/generate.sh --check` and `sh docs/reference/generate-skills.sh --check` keep the generated references in step with them.

The self-tests (`sh tests/selftest.sh`), the skill tests (`node --test tests/skills/`) and the fixtures (`sh tests/fixtures/check-fixtures.sh`) hold more than 900 tests in all (counted 2026-10-17). A pull request takes about 8 minutes of wall time in CI (Linux only; A109).
