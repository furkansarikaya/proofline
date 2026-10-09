# API

Contract source: this file (no OpenAPI/GraphQL/protobuf/JSON Schema contract exists in the repository).
Conventions: <naming, versioning, error envelope, pagination scheme, auth>

## `METHOD /path`

Purpose: <one sentence>
Auth: <mechanism and required role/scope>
Idempotency: <by nature | key header <name> | not idempotent: <retry consequence>>
Pagination: <scheme, default and max page size, ordering> (list operations only)
Handler: `<repo path>`

Request
| Name | In (path/query/header/body) | Type | Required | Constraints |
|---|---|---|---|---|

Success: `<status>` body `<shape>`

Errors
| Status | Body | When |
|---|---|---|

## Breaking and versioned changes
- `<operation id>`: <consumer impact, migration path> or "none"
