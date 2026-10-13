# impact-map fixture: expectations

Evaluator-only. A runner never reads this file; build the scenario outside this repository.

## Scenario

`sh fixtures/impact-map/setup.sh <dir>` builds a small stock library with two commits. The second commit
changes the body of `reserveStock` (not `releaseStock`) and one line of `openapi.yaml`. Run:

    node skills/evidence-map/scripts/impact.mjs --repo <dir> --base HEAD~1

`EXPECTED.json` is the machine-readable form of this file; `selfcheck.sh` and
`tests/skills/evidence-map.test.mjs` compare the report with it. The planted facts below were written
before the script existed.

## Planted facts

Changed: `src/stock/reserve.js:reserveStock` (line 4, modified) and `openapi.yaml` (contract, changed).
`releaseStock` sits in the same file but its lines are untouched: it must NOT be a changed symbol.

References of `reserveStock`, kind in the second column:

| Where | Kind | Why |
|---|---|---|
| `src/stock/reserve.js:4` | exact | definition |
| `src/stock/index.js:1` | exact | barrel re-export |
| `src/orders/place.js:1`, `:4` | exact | import and call |
| `src/api/handlers.js:1`, `:4` | exact | imported through the barrel under the alias `hold`; the call `hold(...)` is a reference |
| `src/gen/client.generated.js:2`, `:4` | exact | generated file, flagged `generated: true` |
| `test/reserve.test.js:3`, `:6` | exact | import and call |
| `test/stock-barrel.test.js:3`, `:6` | exact | test reaching it through the re-export |
| `src/notes.js:1` | textual | the identifier in a comment |
| `src/notes.js:3` | textual | the identifier in a string |
| `README.md:3` | textual | prose |
| `test/reserve.test.js:5`, `test/stock-barrel.test.js:5` | textual | the identifier in a test title |

Traps, none of which may be a reference:

- `src/legacy/warehouse.js` declares its own `reserveStock`; `src/legacy/report.js` and `test/legacy.test.js` call it. They go to `excluded_homonyms` (also the string on `test/legacy.test.js:5`), and `test/legacy.test.js` is not a test of the symbol.
- `src/orders/cancel.js` imports the same barrel but only `releaseStock`: not affected. `test/cancel.test.js` is not a test of the symbol.
- `src/plugins/dispatch.js` builds the name at runtime (`"reserve" + "Stock"` through `Reflect.get`): no reference is found. It imports the defining module, so it is an affected file (`imports-defining-module`), and its line 5 is listed under `unknown` as a dynamic site.

Affected files: `src/stock/reserve.js`, `src/stock/index.js`, `src/orders/place.js`, `src/api/handlers.js`,
`src/gen/client.generated.js`, `src/plugins/dispatch.js`. Modules: `src/stock`, `src/orders`, `src/api`,
`src/gen`, `src/plugins`.

Tests: `test/reserve.test.js` and `test/stock-barrel.test.js` (references-symbol, exact);
`test/orders.test.js` (covers-affected-file, heuristic: it imports the affected `src/orders/place.js`).

Contracts: `openapi.yaml` (changed; mentions `reserveStock` on line 8, textual);
`proto/warehouse.proto` (`ReserveStock`, heuristic: same name up to case); `schemas/reservation.schema.json`
(`reserve_stock`, heuristic: same name up to separators). NOT listed: `openapi-billing.yaml` (no mention, unchanged).

Limits: the report states all of dynamic-dispatch, reflection, string-built-names, generated-code,
cross-repo-consumers, unresolved-imports, language-coverage and lexing; `cross-repo-consumers` is also under
`unknown` with status `unknown`.

`--file src/stock/reserve.js` (no diff) reports both exported symbols, `releaseStock` and `reserveStock`; the
module-private `held` is not a symbol of the request.
