# contract-proof fixture: expectations

Evaluator-only. A runner never reads this file; build the scenario outside this repository.

## Scenario

`sh fixtures/contract-proof/setup.sh <dir>` builds a shop repository with two commits. The first holds the
base contracts, three in-repo consumers under `src/client/` and `PLAN.md` (its `## Contracts` as frozen).
The second changes thirteen JSON, YAML, GraphQL and protobuf files. Run, from this repository:

    node skills/evidence-map/scripts/impact.mjs --repo <dir> --symbol customerEmail --symbol createdAt --symbol currency --symbol quantity --symbol LOST --symbol sku --symbol customerId --symbol zip --symbol B --out <tmp>/impact.json
    node skills/contract-proof/scripts/diff-contract.mjs --repo <dir> --base HEAD~1 --plan <dir>/PLAN.md --impact <tmp>/impact.json --out <tmp>/contract.json
    node skills/contract-proof/scripts/validate-contract.mjs <tmp>/contract.json --table --plan <dir>/PLAN.md --repo <dir> --base HEAD~1

`EXPECTED.json` is the machine-readable form of this file; `selfcheck.sh` and
`tests/skills/contract-proof.test.mjs` compare the differ's output with it. The planted facts below were
written before the scripts existed (each review round's traps before its fixes).

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
| `api/billing.json` | `customerId` added to `required` without a property schema (a required set change on its own) | CP-B05 | request | `POST /invoices.customerId` | breaking, **covered** by PLAN.md:17 |
| `api/billing.json` | response `422` added | CP-N07 | response | `POST /invoices.422` | non-breaking, info row |
| `api/catalog.yaml` (unchanged root) + `api/fragments/item.yaml` (changed fragment behind an external `$ref`) | `sku` string -> integer | CP-B03 | response | `GET /items/{id}.sku` | **breaking, uncovered**; reported in `catalog.yaml`, cited at `api/fragments/item.yaml:5`; the fragment row says `via: api/catalog.yaml` |
| `api/examples/order-example.json` | changed, under `api/`, referenced by nothing | - | - | - | **unsupported** ("not recognized as a contract"), never silently skipped |
| `schemas/status-codes.json` | enum-only JSON Schema (no `type`, no `properties`) loses `B` | CP-B06 | both | `B` | **breaking, uncovered** (PLAN.md:16 says "value B" without a code span: a bare element only counts as `` `B` ``) |
| `schemas/customer.schema.json` (unchanged JSON Schema root) + `schemas/parts/address.json` (changed, behind the repository-root-absolute `$ref: "/schemas/parts/address.json"`) | `zip` removed | CP-B02 | both | `address.zip` | **breaking, uncovered** (PLAN.md:33 is under `## Notes`, not `## Contracts`); cited at the fragment; the fragment's row says `via: schemas/customer.schema.json` |
| `data/seed.json` | changed data, no contract, not on the not-a-contract list | - | - | - | **unsupported** |
| `package.json` | changed, on the not-a-contract list | - | - | - | **ignored** with an info row, no finding |
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
| whole diff (validated with `--plan` and `--repo/--base`) | FAIL | `Order.customerEmail`, `Order.createdAt`, `POST /invoices.currency`, `GET /items/{id}.sku` (at the fragment), `StockLevel.quantity`, `B`, `address.zip` (at the fragment), `api/legacy.yaml`, `api/examples/order-example.json` and `data/seed.json` UNSUPPORTED (10) |
| `--path schemas/shipment.schema.json --path events/asyncapi.yaml --path graphql/schema.graphql` | PASS | none (the covered LOST removal is an `info` row) |
| `--path api/legacy.yaml` | UNSUPPORTED | none; REASON names the anchor |

## Traps

Round 3 (planted before the round 3 fixes):

- **Enum-only schema.** `schemas/status-codes.json` has neither `type` nor `properties`; it is still a JSON
  Schema and its removal is found, never dropped.
- **JSON Schema root with a root-absolute fragment.** `customer.schema.json` is unchanged and a JSON Schema
  (not OpenAPI); its `$ref: "/schemas/parts/address.json"` is resolved from the repository root.
- **Required set without a property.** `customerId` joins `required` with no property schema: CP-B05.
- **Plan structure.** PLAN.md bullets inside an HTML comment (line 20), a fenced code block (line 24), an
  `### Out of scope` child (line 29) and a later `## Notes` section (line 33) cover nothing.
- **Clause-level negation.** PLAN.md:14 "`StockLevel.quantity` renumbered; this isn't versioned": the keyword
  is negated and sits in another clause. PLAN.md:15: the element and "Migration" are in different sentences.
- **Bare element.** PLAN.md:16 names `B` as a plain word: not a code span, covers nothing.
- **Config and data files.** `package.json` (`"type": "module"`) is ignored with a note, never read as a
  schema; `data/seed.json` is UNSUPPORTED.

Rounds 1 and 2:

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
