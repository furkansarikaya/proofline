#!/bin/sh
# Builds the contract-proof fixture repository in an empty directory given as $1.
# Deterministic, no network, no installs. Two commits: the first is the base contract set and PLAN.md,
# the second changes thirteen data and contract files, so `--base HEAD~1` has the known answer in EXPECTED.md.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
TARGET=$1
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2; exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"
git init -q
git symbolic-ref HEAD refs/heads/main
git config user.name Fixture
git config user.email fixture@example.invalid
git config commit.gpgsign false
git config core.hooksPath .git/hooks
mkdir -p api/fragments api/examples schemas/parts events graphql proto src/client data

cat > package.json <<'EOF'
{ "name": "shop-contracts-fixture", "private": true, "type": "module" }
EOF

cat > README.md <<'EOF'
# shop

Order, billing, shipment and inventory contracts plus the in-repo web client that consumes them.
EOF

# ---- in-repo consumers -------------------------------------------------------------------------
cat > src/client/orders.js <<'EOF'
export function orderLine(order) {
  return `${order.id} ${order.status} ${order.customerEmail}`;
}

export function isLost(shipment) {
  return shipment.status === "LOST";
}
EOF

cat > src/client/billing.js <<'EOF'
export function invoiceBody(orderId, currency) {
  return { orderId, currency };
}
EOF

cat > src/client/stock.js <<'EOF'
export function available(level) {
  return level.quantity > 0;
}
EOF

# ---- PLAN.md: the frozen plan's ## Contracts -----------------------------------------------------
cat > PLAN.md <<'EOF'
# PLAN CP-1

## Goal

Contract cleanup across the shop APIs.

## Contracts

- `api/openapi.yaml`: the order response schema moved to `components/schemas/Order` (refactor, no consumer-visible change).
- `api/openapi.yaml` `Order.customerEmail`: removed; bump info.version.
- `api/billing.json` `POST /invoices.currency`: new required request field, defaults to EUR; no versioning or migration needed.
- `schemas/shipment.schema.json` `status.LOST` removed: migration rewrites stored LOST shipments to RETURNED; deprecation window of 90 days announced to consumers.
- `proto/inventory.proto` `Order.quantity` renumbered: versioned under a new package.
- `proto/inventory.proto` `StockLevel.quantity` renumbered; this isn't versioned.
- `api/openapi.yaml` `Order.createdAt` format changed. Migration of other services is planned.
- `schemas/status-codes.json` value B removed: migration done.
- `api/billing.json` `POST /invoices.customerId` is now required: versioned through the Billing-Version header, old clients keep the previous behaviour.

<!--
- `proto/inventory.proto` `StockLevel.quantity` renumbered: versioned under a renamed package.
-->

```
- `api/openapi.yaml` `Order.customerEmail` removed: migration planned.
```

### Out of scope

- `api/openapi.yaml` `Order.createdAt` format change: migration later.

## Notes

- `schemas/customer.schema.json` `address.zip` removed: deprecation window 30 days.
EOF

# ---- base contracts -----------------------------------------------------------------------------
cat > api/openapi.yaml <<'EOF'
openapi: 3.0.3
info:
  title: Orders
  version: 1.4.0
paths:
  /orders/{id}:
    get:
      summary: Get one order
      operationId: getOrder
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: The order
          content:
            application/json:
              schema:
                type: object
                required: [id, status]
                properties:
                  id:
                    type: string
                  status:
                    type: string
                    enum: [placed, shipped]
                  customerEmail:
                    type: string
                    format: email
                  createdAt:
                    type: string
                    format: date-time
        "404":
          description: Not found
  /customers/{id}/address:
    put:
      operationId: putAddress
      parameters:
        - $ref: '#/components/parameters/CustomerId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Address'
      responses:
        "204":
          description: Saved
components:
  parameters:
    CustomerId:
      name: id
      in: path
      required: true
      schema:
        type: string
  schemas:
    Address:
      type: object
      required: [street]
      properties:
        street:
          type: string
        country:
          type: string
          enum: [DE, FR]
        zip:
          type: string
EOF

cat > api/billing.json <<'EOF'
{
  "openapi": "3.0.3",
  "info": { "title": "Billing", "version": "1.3.1" },
  "paths": {
    "/invoices": {
      "post": {
        "operationId": "createInvoice",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["orderId"],
                "properties": {
                  "orderId": { "type": "string" },
                  "note": { "type": "string", "maxLength": 200 }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Created" },
          "409": { "description": "Duplicate" }
        }
      }
    }
  }
}
EOF

cat > api/legacy.yaml <<'EOF'
openapi: 3.0.3
info:
  title: Legacy
  version: 1.0.1
paths:
  /ping:
    get:
      responses:
        "200": &ok
          description: Pong
  /pong:
    get:
      responses:
        "200": *ok
EOF

cat > schemas/shipment.schema.json <<'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.invalid/shipment.schema.json",
  "title": "Shipment",
  "type": "object",
  "required": ["id", "status"],
  "properties": {
    "id": { "type": "string" },
    "status": { "type": "string", "enum": ["PENDING", "IN_TRANSIT", "DELIVERED", "LOST"] }
  }
}
EOF

cat > events/asyncapi.yaml <<'EOF'
asyncapi: 2.6.0
info:
  title: Order events
  version: 1.0.0
channels:
  order.placed:
    description: Published when an order is placed.
    subscribe:
      message:
        name: OrderPlaced
        summary: An order was placed.
        payload:
          type: object
          required: [orderId]
          properties:
            orderId:
              type: string
            total:
              type: number
              description: Order total in minor units.
EOF

cat > graphql/schema.graphql <<'EOF'
"""A customer."""
type Customer {
  id: ID!
  fullName: String
  orders(first: Int): [Order!]!
}

type Order {
  id: ID!
  state: OrderState!
}

enum OrderState {
  PLACED
  SHIPPED
}

type Query {
  customer(id: ID!): Customer
}
EOF

cat > proto/inventory.proto <<'EOF'
syntax = "proto3";

package inventory;

message StockLevel {
  string sku = 1;
  int32 quantity = 2;
  string location = 3;
}

service Inventory {
  rpc GetStock (StockRequest) returns (StockLevel);
}

message StockRequest {
  string sku = 1;
}
EOF

# catalog.yaml is a root contract that is NOT changed; its response schema lives in a fragment file.
cat > api/catalog.yaml <<'EOF'
openapi: 3.0.3
info:
  title: Catalog
  version: 1.1.0
paths:
  /items/{id}:
    get:
      operationId: getItem
      responses:
        "200":
          description: The item
          content:
            application/json:
              schema:
                $ref: './fragments/item.yaml'
EOF

cat > api/fragments/item.yaml <<'EOF'
type: object
required: [sku]
properties:
  sku:
    type: string
  name:
    type: string
EOF

cat > api/examples/order-example.json <<'EOF'
{ "id": "o-1", "status": "placed" }
EOF

# status-codes.json: an enum-only JSON Schema (no type, no properties).
cat > schemas/status-codes.json <<'EOF'
{ "enum": ["A", "B"] }
EOF

# customer.schema.json is NOT changed; it reaches the fragment through a repository-root-absolute $ref.
cat > schemas/customer.schema.json <<'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "address": { "$ref": "/schemas/parts/address.json" }
  }
}
EOF

cat > schemas/parts/address.json <<'EOF'
{
  "type": "object",
  "properties": {
    "street": { "type": "string" },
    "zip": { "type": "string" }
  }
}
EOF

cat > data/seed.json <<'EOF'
{ "orders": 3 }
EOF

git add -A
git commit -q -m "base contracts"

# ---- head contracts -----------------------------------------------------------------------------
# openapi.yaml: summary and info.version (documentation), the order response moved to a $ref whose
# component no longer has customerEmail (a breaking removal hidden in a refactor), Address gains
# postalCode while zip stays as a deprecated alias (looks like a rename, is not breaking).
cat > api/openapi.yaml <<'EOF'
openapi: 3.0.3
info:
  title: Orders
  version: 1.5.0
paths:
  /orders/{id}:
    get:
      summary: Get one order by its id
      operationId: getOrder
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: The order
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        "404":
          description: Not found
  /customers/{id}/address:
    put:
      operationId: putAddress
      parameters:
        - $ref: '#/components/parameters/CustomerId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Address'
      responses:
        "204":
          description: Saved
components:
  parameters:
    CustomerId:
      name: id
      in: path
      required: true
      schema:
        type: string
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id:
          type: string
        status:
          type: string
          enum: [placed, shipped]
        createdAt:
          type: string
          format: date
    Address:
      type: object
      required: [street]
      properties:
        street:
          type: string
        country:
          type: string
          enum: [DE, FR, NL]
        zip:
          type: string
          deprecated: true
          description: Use postalCode.
        postalCode:
          type: string
EOF

# billing.json: currency is a new REQUIRED request field with a default (still breaking: required
# rejects the absent value before any default applies), note's maxLength relaxed, a 422 response added.
cat > api/billing.json <<'EOF'
{
  "openapi": "3.0.3",
  "info": { "title": "Billing", "version": "1.3.1" },
  "paths": {
    "/invoices": {
      "post": {
        "operationId": "createInvoice",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["orderId", "currency", "customerId"],
                "properties": {
                  "orderId": { "type": "string" },
                  "note": { "type": "string", "maxLength": 500 },
                  "currency": { "type": "string", "default": "EUR" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Created" },
          "409": { "description": "Duplicate" },
          "422": { "description": "Invalid currency" }
        }
      }
    }
  }
}
EOF

# legacy.yaml: anchors and aliases are outside the built-in YAML subset -> UNSUPPORTED, never PASS.
cat > api/legacy.yaml <<'EOF'
openapi: 3.0.3
info:
  title: Legacy
  version: 1.0.1
paths:
  /ping:
    get:
      responses:
        "200": &ok
          description: Pong
  /pong:
    get:
      responses:
        "204": *ok
EOF

# shipment.schema.json: LOST removed (breaking, covered by PLAN.md), RETURNED added.
cat > schemas/shipment.schema.json <<'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.invalid/shipment.schema.json",
  "title": "Shipment",
  "type": "object",
  "required": ["id", "status"],
  "properties": {
    "id": { "type": "string" },
    "status": { "type": "string", "enum": ["PENDING", "IN_TRANSIT", "DELIVERED", "RETURNED"] }
  }
}
EOF

# asyncapi.yaml: documentation only.
cat > events/asyncapi.yaml <<'EOF'
asyncapi: 2.6.0
info:
  title: Order events
  version: 1.0.0
channels:
  order.placed:
    # wording only
    description: Published once when an order is placed.
    subscribe:
      message:
        name: OrderPlaced
        summary: An order was placed.
        payload:
          type: object
          required: [orderId]
          properties:
            orderId:
              type: string
            total:
              type: number
              description: Order total in minor currency units.
EOF

# schema.graphql: fullName kept as a deprecated alias of displayName, a non-null argument WITH a
# default, a new query field, a description edit.
cat > graphql/schema.graphql <<'EOF'
"""A customer of the shop."""
type Customer {
  id: ID!
  "Use displayName."
  fullName: String @deprecated(reason: "Use displayName.")
  displayName: String
  orders(first: Int, status: OrderState! = PLACED): [Order!]!
}

type Order {
  id: ID!
  state: OrderState!
}

enum OrderState {
  PLACED
  SHIPPED
}

type Query {
  customer(id: ID!): Customer
  customers(after: String): [Customer!]!
}
EOF

# inventory.proto: quantity renumbered 2 -> 4 (wire-breaking), 2 reserved, location deprecated,
# warehouse added.
cat > proto/inventory.proto <<'EOF'
syntax = "proto3";

package inventory;

message StockLevel {
  reserved 2;
  string sku = 1;
  int32 quantity = 4;
  string location = 3 [deprecated = true];
  string warehouse = 5;
}

service Inventory {
  rpc GetStock (StockRequest) returns (StockLevel);
}

message StockRequest {
  string sku = 1;
}
EOF

# item.yaml (a fragment of the unchanged catalog.yaml): sku becomes an integer, a breaking response change
# found only by following the external $ref. order-example.json is changed, under api/, and referenced by
# nothing: it must be reported UNSUPPORTED, never silently skipped.
cat > api/fragments/item.yaml <<'EOF'
type: object
required: [sku]
properties:
  sku:
    type: integer
  name:
    type: string
EOF

cat > api/examples/order-example.json <<'EOF'
{ "id": "o-1", "status": "shipped" }
EOF

# status-codes.json loses B (breaking, bare element: the plan's "value B" without a code span covers nothing).
cat > schemas/status-codes.json <<'EOF'
{ "enum": ["A"] }
EOF

# address.json (a fragment of the unchanged customer.schema.json) loses zip.
cat > schemas/parts/address.json <<'EOF'
{
  "type": "object",
  "properties": {
    "street": { "type": "string" }
  }
}
EOF

# seed.json: changed data that is no contract and not on the not-a-contract list -> UNSUPPORTED.
cat > data/seed.json <<'EOF'
{ "orders": 4 }
EOF

# package.json: on the not-a-contract list -> ignored with a note, no finding.
cat > package.json <<'EOF'
{ "name": "shop-contracts-fixture", "private": true, "type": "module", "description": "shop" }
EOF

git add -A
git commit -q -m "contract changes"
echo "contract-proof fixture ready: $TARGET"
