// Builds the contract-proof fixture in <target-dir>: a shop repository with two commits (base contracts, contract changes).
// Deterministic and offline. usage: node setup.mjs <target-dir>
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.git/hooks']] });
  f.mkdir('api/fragments', 'api/examples', 'schemas/parts', 'events', 'graphql', 'proto', 'src/client', 'data');
  f.w(`package.json`, `{ "name": "shop-contracts-fixture", "private": true, "type": "module" }
`);
  f.w(`README.md`, `# shop

Order, billing, shipment and inventory contracts plus the in-repo web client that consumes them.
`);
  f.w(`src/client/orders.js`, `export function orderLine(order) {
  return \`\${order.id} \${order.status} \${order.customerEmail}\`;
}

export function isLost(shipment) {
  return shipment.status === "LOST";
}
`);
  f.w(`src/client/billing.js`, `export function invoiceBody(orderId, currency) {
  return { orderId, currency };
}
`);
  f.w(`src/client/stock.js`, `export function available(level) {
  return level.quantity > 0;
}
`);
  f.w(`PLAN.md`, `# PLAN CP-1

## Goal

Contract cleanup across the shop APIs.

## Contracts

- \`api/openapi.yaml\`: the order response schema moved to \`components/schemas/Order\` (refactor, no consumer-visible change).
- \`api/openapi.yaml\` \`Order.customerEmail\`: removed; bump info.version.
- \`api/billing.json\` \`POST /invoices.currency\`: new required request field, defaults to EUR; no versioning or migration needed.
- \`schemas/shipment.schema.json\` \`status.LOST\` removed: migration rewrites stored LOST shipments to RETURNED; deprecation window of 90 days announced to consumers.
- \`proto/inventory.proto\` \`Order.quantity\` renumbered: versioned under a new package.
- \`proto/inventory.proto\` \`StockLevel.quantity\` renumbered; this isn't versioned.
- \`api/openapi.yaml\` \`Order.createdAt\` format changed. Migration of other services is planned.
- \`schemas/status-codes.json\` value B removed: migration done.
- \`api/billing.json\` \`POST /invoices.customerId\` is now required: versioned through the Billing-Version header, old clients keep the previous behaviour.

<!--
- \`proto/inventory.proto\` \`StockLevel.quantity\` renumbered: versioned under a renamed package.
-->

\`\`\`
- \`api/openapi.yaml\` \`Order.customerEmail\` removed: migration planned.
\`\`\`

### Out of scope

- \`api/openapi.yaml\` \`Order.createdAt\` format change: migration later.

## Notes

- \`schemas/customer.schema.json\` \`address.zip\` removed: deprecation window 30 days.
`);
  f.w(`api/openapi.yaml`, `openapi: 3.0.3
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
`);
  f.w(`api/billing.json`, `{
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
`);
  f.w(`api/legacy.yaml`, `openapi: 3.0.3
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
`);
  f.w(`schemas/shipment.schema.json`, `{
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
`);
  f.w(`events/asyncapi.yaml`, `asyncapi: 2.6.0
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
`);
  f.w(`graphql/schema.graphql`, `"""A customer."""
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
`);
  f.w(`proto/inventory.proto`, `syntax = "proto3";

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
`);
  f.w(`api/catalog.yaml`, `openapi: 3.0.3
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
`);
  f.w(`api/fragments/item.yaml`, `type: object
required: [sku]
properties:
  sku:
    type: string
  name:
    type: string
`);
  f.w(`api/examples/order-example.json`, `{ "id": "o-1", "status": "placed" }
`);
  f.w(`schemas/status-codes.json`, `{ "enum": ["A", "B"] }
`);
  f.w(`schemas/customer.schema.json`, `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "address": { "$ref": "/schemas/parts/address.json" }
  }
}
`);
  f.w(`schemas/parts/address.json`, `{
  "type": "object",
  "properties": {
    "street": { "type": "string" },
    "zip": { "type": "string" }
  }
}
`);
  f.w(`data/seed.json`, `{ "orders": 3 }
`);
  f.commit('base contracts');
  f.w(`api/openapi.yaml`, `openapi: 3.0.3
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
`);
  f.w(`api/billing.json`, `{
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
`);
  f.w(`api/legacy.yaml`, `openapi: 3.0.3
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
`);
  f.w(`schemas/shipment.schema.json`, `{
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
`);
  f.w(`events/asyncapi.yaml`, `asyncapi: 2.6.0
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
`);
  f.w(`graphql/schema.graphql`, `"""A customer of the shop."""
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
`);
  f.w(`proto/inventory.proto`, `syntax = "proto3";

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
`);
  f.w(`api/fragments/item.yaml`, `type: object
required: [sku]
properties:
  sku:
    type: integer
  name:
    type: string
`);
  f.w(`api/examples/order-example.json`, `{ "id": "o-1", "status": "shipped" }
`);
  f.w(`schemas/status-codes.json`, `{ "enum": ["A"] }
`);
  f.w(`schemas/parts/address.json`, `{
  "type": "object",
  "properties": {
    "street": { "type": "string" }
  }
}
`);
  f.w(`data/seed.json`, `{ "orders": 4 }
`);
  f.w(`package.json`, `{ "name": "shop-contracts-fixture", "private": true, "type": "module", "description": "shop" }
`);
  f.commit('contract changes');
  console.log(`contract-proof fixture ready: ${target}`);
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
