# Fixture expectations

Two modes are exercised: **full** (the planted projects below, `go/` and `ts/`) and **diff** (the same code split into a base commit and a task, built by `diff-setup.sh`; see "Diff mode" at the end).

Two small projects with deliberately planted test problems, used to check that `test-trust` finds what it should and nothing else. Both implement the same tiny checkout library, so findings should line up across ecosystems.

## How to run an audit on a fixture

Audit a **copy**, so the agent sees a standalone repo and cannot read this file:

```sh
cp -R fixtures/test-trust/go /tmp/tt-go && cd /tmp/tt-go
git init -q && git add -A && git commit -qm fixture
# then, in your agent:  /test-trust .   (mode full; results land in .agents/local/test-trust/<slug>/)
```

For `fixtures/ts`, run `npm install` in the copy first (the skill never installs anything). Requires Go 1.22+ or Node 20+.

Record what the audit reported against the tables below, and note every difference, missing or extra, in the PR that changes the skill.

**Re-run before blaming the skill for a missed flaky test.** `TestBackoff` / `backoffMs` and the order-dependent test each fail in about 50% of runs. The chance that 5 stage-1 runs all give the same outcome for one of them is 2 × 0.5⁵ ≈ 6%. If one is missed in a single audit, run the audit again; count it as a skill failure only if it is missed repeatedly.

## fixtures/go (Go, `go test`)

Expected probe: all four capabilities proven (`-run '^Name$'`, `-count=N`, `-shuffle=on`, `-json`).

| Test | Planted problem | Expected finding |
|---|---|---|
| `TestBackoff` | Asserts `Backoff(1) < 300ms`, but jitter puts it in [200ms, 400ms): fails about half the time. | `flaky_nondeterministic`, `confirmed`. For hollow, it is its unit's only covering test, so `Backoff` gets `hollow`, `needs_validation`, `missing`: "covering tests are flaky"; no `Backoff` mutants are run. |
| `TestFormatPrice` | Expects `USD`, but `TestFormatPriceEuro` sets the package-level `DefaultCurrency` to `EUR` without restoring it. Passes alone and in the default order; fails when shuffled after the euro test. | `flaky_order_dependent`, `confirmed` |
| `TestNormalizeEmail` | Calls `NormalizeEmail` and asserts nothing. | `hollow`, `confirmed` (any mutant of `NormalizeEmail` survives) |
| `TestCheckout` | Store and mailer are fakes; only checks that no error is returned. | `hollow`, `confirmed` for `Checkout` (for example, `total += item` → `total -= item` survives), and also `hollow`, `confirmed` for `NormalizeEmail`: `Checkout` calls it, so `TestCheckout` covers that unit and stays green under its mutants (one finding per covering test that stays green) |
| `TestReconcile` | Sleeps 1 s; every other test takes well under 10 ms. | `slow`, `confirmed`; `Reconcile` mutants are killed (cleared for hollow) |
| `TestApplyDiscount` | Solid: boundary cases 9999, 10000, 20000, 0. | No finding; `ApplyDiscount` mutants killed |
| `TestParseAmount` | Solid: valid and invalid inputs. | No finding; `ParseAmount` mutants killed |
| `TestFormatPriceEuro` | Pollutes shared state, but its own outcome is stable. | No finding (it is the polluter, not the victim) |

Red at baseline: none in the default order. A baseline run may still catch `TestBackoff` failing by chance; it must then reappear as flaky, not stay "red at baseline".

## fixtures/ts (TypeScript, Vitest)

The hollow stage needs `node_modules/` symlinked into the worktree; if the skill does not link it, the unmutated verification run fails and the skill must stop and ask (not install).

Expected probe: all four capabilities proven (`vitest run <file> -t <name>`, a shell loop for repeat, `--sequence.shuffle` with `--sequence.seed`, `--reporter=junit` or `--reporter=json`).

| Test | Planted problem | Expected finding |
|---|---|---|
| `backoffMs > stays under 300ms for the second attempt` | Same jitter bug as Go. | `flaky_nondeterministic`, `confirmed`; for hollow, `backoffMs` gets `hollow`, `needs_validation`, `missing`: "covering tests are flaky" |
| `formatPrice > formats cents in the default currency` | Shared `settings.currency` mutated by the euro test, same file. | `flaky_order_dependent`, `confirmed` |
| `normalizeEmail > normalizes an email address` | No assertion. | `hollow`, `confirmed` |
| `checkout > saves the order and sends a receipt` | Store and mailer are `vi.fn()` mocks; only asserts they were called. | `hollow`, `confirmed` for `checkout`, and also for `normalizeEmail` (called by `checkout`, same rule as Go) |
| `reconcile > returns charged minus settled` | Waits 1 s. | `slow`, `confirmed`; `reconcile` mutants killed |
| `applyDiscount(...)` (4 cases) | Solid. | No finding |
| `parseAmount > parses valid amounts` / `rejects invalid amounts` | Solid. | No finding |
| `formatPrice > formats cents in euros` | Polluter, stable outcome. | No finding |

## Unplanned but real

Findings that were not planted on purpose but are genuine. They are **accepted, not required**: mutation choice varies between runs, so an audit may or may not hit them. Do not change the fixtures to remove them.

- **Go, `FormatPrice`:** `TestFormatPriceEuro` (and `TestCheckout`, which calls `FormatPrice`) only use `1250`, so a mutant dropping the zero padding (`%02d` → `%d`) stays green. Reported as `hollow`, `confirmed` on those tests for `FormatPrice`. (`TestFormatPrice` is excluded from the covering set because it is flaky.)
- **TS, `formatPrice`:** same weakness: removing `padStart(2, "0")` stays green because only `1250` is tested.

## What counts as a failure of the skill

- A planted problem not reported as `confirmed` when the needed capability was proven.
- Any `confirmed` finding on a solid test.
- Any change to the fixture's files left behind after the audit (mutations must happen in a worktree).
- Anything installed by the skill.

`needs_validation` on a planted problem is acceptable only if `missing` names a real, unproven capability.

## Diff mode (D20)

`diff-setup.sh` builds a repository whose base commit holds `shop` plus the solid price tests, and whose **uncommitted working tree is the task**. Run it outside this repository (the agent must not see this file):

```sh
sh fixtures/test-trust/diff-setup.sh go /tmp/tt-diff-go fail     # also: ts, and scenario pass
cd /tmp/tt-diff-go     # then, in your agent:  /test-trust diff
```

For `ts`, put `node_modules/` next to `package.json` first (copy or symlink; the skill never installs). Go 1.22+ or Node 20+ is required. Defaults apply (`repeat` 5, `mutation_budget` 20, `slow_ratio` 3) unless the copy has `.agents/config.yaml`; a copy with `test_trust: repeat: 3` must report `thresholds.repeat` 3 in `findings.json`.

The same tests run inside a proofline run (phase 9: the lead dispatches `reviewer` with `FOCUS: tests` on a task whose diff is this working tree); the expectations are identical, plus the result header of `SKILL.md` ("Result in a run"), with `ARTIFACT: reviews/test-trust/tests/REPORT.md <sha256>`.

### Scenario `fail`

The task refactors `ApplyDiscount` (`* 90 / 100` to `* 9 / 10`) and `NormalizeEmail` (call order of lower-casing and trimming), both behaviour-preserving, and adds the checkout tests. Diff scope: the changed tests (`TestCheckout`, `TestNormalizeEmail`, `TestBackoff`, `TestReconcile`; TS: the four `checkout.test.ts` cases) plus tests covering the changed units (`TestApplyDiscount`; TS: `applyDiscount` cases). `mutation_budget` 20 is not exhausted: 2 changed units, 3 to 5 mutants each.

| Test | Expected in diff mode |
|---|---|
| `TestBackoff` / `backoffMs` "stays under 300ms" | `flaky_nondeterministic`, `confirmed` (jitter fails about half of the isolated runs; with `repeat` 5 the chance of 5 equal outcomes is about 6%, so re-run before blaming the skill). **Gate FAIL.** No `Backoff` hollow finding: `Backoff` is not a changed unit. |
| `TestNormalizeEmail` / "normalizes an email address" | `hollow`, `confirmed` on unit `shop.go:NormalizeEmail` (`shop.ts:normalizeEmail`): a mutant such as returning `email` unchanged survives. **Gate FAIL.** |
| `TestCheckout` / "saves the order and sends a receipt" | `hollow`, `confirmed` on `NormalizeEmail`: `Checkout` calls it and the test stays green under its mutants. **Not** hollow on `ApplyDiscount`: `TestApplyDiscount` kills every `ApplyDiscount` mutant, so the unit is cleared. |
| `TestReconcile` / "returns charged minus settled" | `slow`, `confirmed`, severity `info` in the result table (1 s against a median of a few ms, ratio far above 3). Informational: **never** part of the gate. `Reconcile` is not a changed unit, so it is not mutated. |
| `TestApplyDiscount` / `applyDiscount(...)` cases | Solid. No finding. Its unit `ApplyDiscount` is `cleared`. |
| `TestFormatPrice`, `TestFormatPriceEuro` / `formatPrice` cases | Not in the diff scope (not changed, `FormatPrice` unchanged). No finding. The order-dependent pollution is **not** reported: order dependence is checked in full mode only, and the report notes say so. |

Expected `findings.json`: `mode` `diff`, `gate.result` `FAIL`, `gate.failing` = the `flaky_nondeterministic` finding plus the hollow findings (`TestNormalizeEmail`, `TestCheckout` on `NormalizeEmail`), `scope.diff.changed_units` = `ApplyDiscount` and `NormalizeEmail` (TS: `applyDiscount`, `normalizeEmail`), `mutants_run` at most 20, `evidence_pruned` true, and it validates with `node skills/test-trust/scripts/validate-findings.mjs`. In a run the result header is `ROLE: reviewer`, `FOCUS: tests`, `RESULT: FAIL`, and the table lists the blocking rows (`severity` `blocking`) and the slow row (`info`).

### Scenario `pass`

The task only refactors `ApplyDiscount`; no test is added or edited. The diff scope is the covering test `TestApplyDiscount` (TS: the `applyDiscount` cases). It is solid, so all `ApplyDiscount` mutants are killed.

- `gate.result` `PASS`, `gate.failing` empty, no `confirmed` finding, `RESULT: PASS`.
- Any `confirmed` finding on a solid test is a failure of the skill (a false FAIL).

### What counts as a failure in diff mode

- Scenario `fail` returns `PASS`, or lacks a `confirmed` flaky or hollow finding after the flaky test was re-run (see the 6% note).
- `TestReconcile` (slow) makes the gate fail, or the slow finding is missing while per-test durations were proven.
- A finding on `TestFormatPrice`, `TestFormatPriceEuro`, `Backoff` or `Reconcile` units (outside the diff scope), or a hollow finding on a unit that is not changed.
- More mutants than `mutation_budget`, or a gate that does not match the rule (the validator rejects this).
- Any change to the files left behind after the run (mutations happen in a worktree), anything installed.

### Verified when the fixtures were ported (no LLM run)

Run by hand against the built repositories: Go baseline passes except for the intended `TestBackoff` coin flip (5 of 10 isolated runs failed); `TestReconcile` measures 1.00 s; a mutant of `NormalizeEmail` returning `email` leaves `TestNormalizeEmail` and `TestCheckout` green; a mutant of `ApplyDiscount` returning `cents` is killed by `TestApplyDiscount`; scenario `pass` is green. TS under Vitest: same results (`backoffMs` failed 2 of 6 isolated runs, the `normalizeEmail` mutant survives, the `applyDiscount` mutant is killed, scenario `pass` is green).
