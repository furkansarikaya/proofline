# contract-proof fixture: expectations

Evaluator-only. A runner never reads this file; build the scenario outside this repository.

## Scenario

`sh fixtures/contract-proof/setup.sh <dir>` builds a shop repository with two commits. The first holds the
base contracts, three in-repo consumers under `src/client/` and `PLAN.md` (its `## Contracts` as frozen).
The second changes nine contract-related files. Run, from this repository:

    node skills/evidence-map/scripts/impact.mjs --repo <dir> --symbol customerEmail --symbol createdAt --symbol currency --symbol quantity --symbol LOST --symbol sku --out <tmp>/impact.json
    node skills/contract-proof/scripts/diff-contract.mjs --repo <dir> --base HEAD~1 --plan <dir>/PLAN.md --impact <tmp>/impact.json --out <tmp>/contract.json
    node skills/contract-proof/scripts/validate-contract.mjs <tmp>/contract.json --table --plan <dir>/PLAN.md --repo <dir> --base HEAD~1

`EXPECTED.json` is the machine-readable form of this file; `selfcheck.sh` and
`tests/skills/contract-proof.test.mjs` compare the differ's output with it. The planted facts below were
written before the scripts existed (round 2 traps before the round 2 fixes).

## Planted facts per file

Elements are qualified names (A83): the named schema, operation or channel, then the property.

| File | Change | Rule | Side | Element | Expected |
|---|---|---|---|---|---|
| `api/openapi.yaml` | `info.version` 1.4.0 -> 1.5.0 | CP-N05 | both | `info` | non-breaking (metadata; not versioning) |
| `api/openapi.yaml` | `GET /orders/{id}` summary reworded | CP-N05 | both | `GET /orders/{id}` | non-breaking |
| `api/openapi.yaml` | 200 response schema moved inline -> `$ref: '#/components/schemas/Order'`; the component lacks `customerEmail` | CP-B02 | response | `Order.customerEmail` | **breaking, uncovered** |
| `api/openapi.yaml` | `createdAt` format `date-time` -> `date` (changed, response side) | CP-B09 | response | `Order.createdAt` | **breaking, uncovered** |
| `api/openapi.yaml` | `Address.country` enum gains `NL` (request side) | CP-N03 | request | `Address.country.NL` | non-breaking |
| `api/openapi.yaml` | `Address.postalCode` added, optional | CP-N01 | request | `Address.postalCode` | non-breaking |
| `api/openapi.yaml` | `Address.zip` gets `deprecated: true` and a description | CP-N08, CP-N05 | request | `Address.zip` | non-breaking |
| `api/billing.json` | `note.maxLength` 200 -> 500 | CP-N06 | request | `POST /invoices.note` | non-breaking (request accepts more) |
| `api/billing.json` | `currency` added, `required`, `default: EUR` | CP-B05 | request | `POST /invoices.currency` | **breaking, uncovered** |
| `api/billing.json` | response `422` added | CP-N07 | response | `POST /invoices.422` | non-breaking, info row |
| `api/catalog.yaml` (unchanged root) + `api/fragments/item.yaml` (changed fragment behind an external `$ref`) | `sku` string -> integer | CP-B03 | response | `GET /items/{id}.sku` | **breaking, uncovered**; reported in `catalog.yaml`, cited at `api/fragments/item.yaml:5`; the fragment row says `via: api/catalog.yaml` |
| `api/examples/order-example.json` | changed, under `api/`, referenced by nothing | - | - | - | **unsupported** ("not recognized as a contract"), never silently skipped |
| `api/legacy.yaml` | uses a YAML anchor and alias | - | - | - | **unsupported**, never a pass |
| `schemas/shipment.schema.json` | `status` enum value `LOST` removed | CP-B06 | both | `status.LOST` | breaking, **covered** by PLAN.md:12 |
| `schemas/shipment.schema.json` | `status` enum value `RETURNED` added | CP-N04 | both | `status.RETURNED` | non-breaking, info row |
| `events/asyncapi.yaml` | channel and payload descriptions reworded, a comment added | CP-N05 x2 | both | `order.placed`, `order.placed.total` | non-breaking (documentation only) |
| `graphql/schema.graphql` | `Customer.fullName` gets `@deprecated` | CP-N08 | response | `Customer.fullName` | non-breaking |
| `graphql/schema.graphql` | `Customer.displayName` added | CP-N01 | response | `Customer.displayName` | non-breaking |
| `graphql/schema.graphql` | `Customer.orders(status: OrderState! = PLACED)` added | CP-N10 | request | `Customer.orders(status)` | non-breaking (non-null with a default) |
| `graphql/schema.graphql` | `Query.customers` added | CP-N01 | response | `Query.customers` | non-breaking |
| `proto/inventory.proto` | `StockLevel.quantity` number 2 -> 4 | CP-B10 | both | `StockLevel.quantity` | **breaking, uncovered** |
| `proto/inventory.proto` | `location` deprecated, `warehouse = 5` added, `reserved 2` | CP-N08, CP-N01, CP-N09 | both | `StockLevel.location`, `StockLevel.warehouse`, `StockLevel.reserved(2)` | non-breaking |

Consumers (impact report, kind `heuristic` except where noted): `customerEmail` -> `src/client/orders.js:2`;
`currency` -> `src/client/billing.js:1`, `:2`; `quantity` -> `src/client/stock.js:2`; `LOST` ->
`src/client/orders.js:6` (`textual`, a string); `createdAt` and `sku`: none found statically. `PLAN.md`
mentions some of them in prose: never a consumer. Every consumer outside the repository is `unknown`.

## Expected results

| Run | RESULT | Blocking rows |
|---|---|---|
| whole diff (validated with `--plan` and `--repo/--base`) | FAIL | `Order.customerEmail`, `Order.createdAt`, `POST /invoices.currency`, `GET /items/{id}.sku` (at the fragment), `StockLevel.quantity`, `api/legacy.yaml` UNSUPPORTED, `api/examples/order-example.json` UNSUPPORTED (7) |
| `--path schemas/shipment.schema.json --path events/asyncapi.yaml --path graphql/schema.graphql` | PASS | none (the covered LOST removal is an `info` row) |
| `--path api/legacy.yaml` | UNSUPPORTED | none; REASON names the anchor |

## Traps

- **Breaking change hidden in a refactor.** openapi.yaml looks like "move the schema to components";
  resolving the `$ref` shows `customerEmail` is gone. PLAN.md:9 calls it a refactor: no versioning, no
  element, covers nothing.
- **`info.version` is not coverage.** PLAN.md:10 names `Order.customerEmail` and says "bump info.version":
  still uncovered.
- **Negated coverage.** PLAN.md:11 names `POST /invoices.currency` but says "no versioning or migration
  needed": uncovered. `currency` is `required` with `default: EUR`: still breaking, because `required`
  rejects the absent value before a default applies (contrast: the GraphQL non-null argument with a default
  is non-breaking, CP-N10).
- **Wrong element.** PLAN.md:13 says `Order.quantity` is versioned; the change is `StockLevel.quantity`:
  uncovered.
- **Changed format on the response side.** `date-time` -> `date` is neither a pure narrowing nor a pure
  widening: breaking on every side (CP-B09), not CP-N06.
- **Request enum change.** A value added on the request side is CP-N03, non-breaking.
- **Fragment file.** The root `catalog.yaml` is unchanged; only its external `$ref` fragment changed. The
  differ follows the reference and classifies the change in the root with the response side.
- **Unrecognized file under a contract path.** `api/examples/order-example.json` is UNSUPPORTED, not dropped.
- **Rename that keeps an alias.** `zip` -> `postalCode` (OpenAPI) and `fullName` -> `displayName`
  (GraphQL) keep the old name as a deprecated field: non-breaking.
- **Documentation only.** asyncapi.yaml changes only wording and a comment.
- **Covered by the plan.** `status.LOST` removal is breaking but PLAN.md:12 names the file, the element and
  a migration plus a deprecation window: an `info` row; the PASS run proves it does not fail the gate.
- **Unparseable.** legacy.yaml uses an anchor/alias outside the YAML subset: UNSUPPORTED, never PASS.
