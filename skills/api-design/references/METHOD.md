# api-design method

## 1. Discover the existing contract

Search the tracked files (exclude dependency and build folders) for, in order:

| Format | Patterns |
|---|---|
| `openapi` | `openapi.{yaml,yml,json}`, `swagger.{yaml,yml,json}`, files whose first lines contain `openapi:` or `"openapi"` / `swagger:` |
| `graphql` | `*.graphql`, `*.gql`, `schema.graphql`, SDL embedded in `typeDefs` |
| `protobuf` | `*.proto` (services and messages) |
| `jsonschema` | `*.schema.json`, files with `"$schema"` and `"properties"` used as request/response schemas |
| `api-md` | `design_docs.api` (default `docs/design/API.md`) |

Prove a candidate is the live contract: it is referenced by the build, a codegen config, a test, a router or CI (`grep` for its path). Several contracts: the one the changed operations belong to; name any other in the ledger. Generated contract files (regenerated from code by the build) are not edited: the code annotation is the source, name it. Record the patterns searched in `searched` in `api.json`.

No contract found: format is `api-md`, `existing_contract` is `null`.

## 2. Read the existing style

From two or three existing operations (verified `path:symbol`): naming and casing, path scheme and versioning (`/v1/`, header, media type), error envelope shape, status-code use, pagination scheme (cursor/offset/page) and parameter names, auth mechanism, idempotency-key convention, date/ID/money formats. The new design reuses each; every deviation is listed with a reason.

## 3. Breaking change catalog

Breaking for consumers (set `breaking: true`, with `breaking_reason`):
- removing or renaming an operation, path, field, enum value, parameter, header, message field number (protobuf) or GraphQL field/type;
- making an optional request field required, adding a required request field, narrowing accepted values/length/format;
- changing a field type, nullability (nullable -> non-null in responses is compatible; non-null -> nullable breaks), units, format or semantics;
- removing or changing the meaning of a response status code or error body shape consumers branch on; adding an enum value consumers cannot ignore;
- changing auth requirements (new scope, stricter role), rate limits that fail existing traffic, default pagination or ordering;
- protobuf: reusing a field number, changing wire type, removing a field without `reserved`;
- GraphQL: changing argument nullability, removing a field, narrowing a union.

Compatible: new optional request fields, new endpoints, new response fields (when consumers ignore unknowns), new optional parameters with a default preserving old behaviour, loosening validation. `versioned: true` marks any change to an operation inside an already published, versioned surface (`/v1`, a published proto package, a public schema) even when compatible; the lead names it in `## Contracts`.

## 4. Operation checklist

Per operation: id (`METHOD /path`, `Type.field` for GraphQL, `Service.Method` for RPC), purpose (one sentence tied to an AC), request (params, headers, body shape with types, required/optional, limits), success response (status, body shape), errors (each status, body, trigger), auth, idempotency (mutating operations), pagination and ordering (lists), versioning impact, implementing handler path (when it exists).

## 5. Validation rules

The validator enforces: `schema_version` 1; `format` in `openapi|graphql|protobuf|jsonschema|api-md`; `existing_contract` is `null` only for `api-md`, and for `api-md` it must be `null` while `searched` is non-empty (no contract existed); non-`api-md` has `contract_file` equal to `existing_contract`; operations have unique ids, `style` `rest|graphql|rpc` with `rest` ids matching `METHOD /path` (path starts with `/`); `change` in `added|modified|removed|unchanged`; `removed` implies `breaking: true`; `breaking: true` requires non-empty `breaking_reason` and an entry in `contracts_text`; `versioned: true` requires an entry in `contracts_text`; `contracts_text` mentions each such operation id; non-`unchanged` operations have non-empty `errors` (strings of the form `<status> <when>`), `auth`, and for mutating REST methods (POST, PUT, PATCH, DELETE) `idempotency`; list operations (`list: true`) have `pagination`; a stated `handler` path is relative and (with `--root`) exists unless `change` is `added`; `contract_file` (with `--root`) exists for non-`api-md` formats.
