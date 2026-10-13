# contract-proof fixture: expectations

Evaluator-only. A runner never reads this file; build the scenario outside this repository.

## Scenario

`sh fixtures/contract-proof/setup.sh <dir>` builds a shop repository with two commits. The first holds the
base contracts, three in-repo consumers under `src/client/` and `PLAN.md` (its `## Contracts` as frozen).
The second changes seven contract files. Run, from this repository:

    node skills/evidence-map/scripts/impact.mjs --repo <dir> --symbol customerEmail --symbol currency --symbol quantity --symbol LOST --out <tmp>/impact.json
    node skills/contract-proof/scripts/diff-contract.mjs --repo <dir> --base HEAD~1 --plan <dir>/PLAN.md --impact <tmp>/impact.json --out <tmp>/contract.json
    node skills/contract-proof/scripts/validate-contract.mjs <tmp>/contract.json --table

`EXPECTED.json` is the machine-readable form of this file; `selfcheck.sh` and
`tests/skills/contract-proof.test.mjs` compare the differ's output with it. The planted facts below were
written before the scripts existed.

## Planted facts per file

| File | Change | Rule | Side | Expected |
|---|---|---|---|---|
| `api/openapi.yaml` | `info.version` 1.4.0 -> 1.5.0 | CP-N05 | both | non-breaking (metadata; not versioning) |
| `api/openapi.yaml` | `GET /orders/{id}` summary reworded | CP-N05 | both | non-breaking |
| `api/openapi.yaml` | 200 response schema moved inline -> `$ref: '#/components/schemas/Order'`; the component lacks `customerEmail` | CP-B02 | response | **breaking, uncovered** |
| `api/openapi.yaml` | `Address.postalCode` added, optional | CP-N01 | request | non-breaking |
| `api/openapi.yaml` | `Address.zip` gets `deprecated: true` | CP-N08 | request | non-breaking |
| `api/openapi.yaml` | `Address.zip` gets a description | CP-N05 | request | non-breaking |
| `api/billing.json` | `note.maxLength` 200 -> 500 | CP-N06 | request | non-breaking (request accepts more) |
| `api/billing.json` | `currency` added, `required`, `default: EUR` | CP-B05 | request | **breaking, uncovered** |
| `api/billing.json` | response `422` added | CP-N07 | response | non-breaking, info row |
| `api/legacy.yaml` | uses a YAML anchor and alias | - | - | **unsupported**, never a pass |
| `schemas/shipment.schema.json` | `status` enum value `LOST` removed | CP-B06 | both | breaking, **covered** by PLAN.md:11 |
| `schemas/shipment.schema.json` | `status` enum value `RETURNED` added | CP-N04 | both | non-breaking, info row |
| `events/asyncapi.yaml` | channel description and a payload description reworded, a comment added | CP-N05 x2 | both | non-breaking (documentation only) |
| `graphql/schema.graphql` | `Customer.fullName` gets `@deprecated` | CP-N08 | response | non-breaking |
| `graphql/schema.graphql` | `Customer.displayName` added | CP-N01 | response | non-breaking |
| `graphql/schema.graphql` | `Customer.orders(status: OrderState! = PLACED)` added | CP-N10 | request | non-breaking (non-null with a default) |
| `graphql/schema.graphql` | `Query.customers` added | CP-N01 | response | non-breaking |
| `proto/inventory.proto` | `StockLevel.quantity` number 2 -> 4 | CP-B10 | both | **breaking, uncovered** |
| `proto/inventory.proto` | `StockLevel.location` `[deprecated = true]` | CP-N08 | both | non-breaking |
| `proto/inventory.proto` | `StockLevel.warehouse = 5` added | CP-N01 | both | non-breaking |
| `proto/inventory.proto` | `reserved 2` added | CP-N09 | both | non-breaking |

Consumers (impact report, kind `heuristic` except where noted): `customerEmail` -> `src/client/orders.js:2`;
`currency` -> `src/client/billing.js:1`, `:2`; `quantity` -> `src/client/stock.js:2`; `LOST` ->
`src/client/orders.js:6` (`textual`, a string). `PLAN.md` mentions `currency` and `LOST` in prose: never a
consumer. Every consumer outside the repository is `unknown`.

## Expected results

| Run | RESULT | Blocking rows |
|---|---|---|
| whole diff | FAIL | `api/openapi.yaml` customerEmail, `api/billing.json` currency, `proto/inventory.proto` quantity, `api/legacy.yaml` UNSUPPORTED (4) |
| `--path schemas/shipment.schema.json --path events/asyncapi.yaml --path graphql/schema.graphql` | PASS | none (the covered LOST removal is an `info` row) |
| `--path api/legacy.yaml` | UNSUPPORTED | none; REASON names the anchor |

## Traps

- **Breaking change hidden in a refactor.** The openapi.yaml diff looks like "move the schema to
  components"; resolving the `$ref` shows `customerEmail` is gone from the response. PLAN.md even calls it a
  refactor with no consumer-visible change: that bullet has no versioning, migration or deprecation and does
  not name `customerEmail`, so it covers nothing.
- **Rename that looks breaking but keeps an alias.** `zip` -> `postalCode` (OpenAPI) and `fullName` ->
  `displayName` (GraphQL) keep the old name as a deprecated field: no removal, non-breaking.
- **Required field with a default.** `currency` is `required` with `default: EUR`: still breaking, because
  `required` rejects the absent value before a default applies. PLAN.md names `currency` but states no
  versioning or migration: uncovered. Contrast: the GraphQL non-null argument with a default is
  non-breaking (CP-N10).
- **Documentation only.** asyncapi.yaml changes only wording and a comment: no breaking row. `info.version`
  in openapi.yaml moving is metadata, not contract versioning.
- **Covered by the plan.** `LOST` removal is breaking but PLAN.md:11 names the file, the value and a
  migration plus a deprecation window: an `info` row, and the PASS run proves it does not fail the gate.
- **Uncovered break.** proto field renumbered: wire-breaking although the name is unchanged.
- **Unparseable.** legacy.yaml uses an anchor/alias outside the YAML subset: UNSUPPORTED, never PASS.
