# Data model

<!-- Reverse-engineered by data-design; describes only what exists. design-sync checks every table below
     against the schema. Replace <...>; delete these comments. -->

engine: <postgres|mysql|sqlite|sqlserver|mongo|other> (<version>; evidence: <path:line>)
migrations: <directory or glob> (tool: <how they are applied>)

## Diagram

```mermaid
erDiagram
  <TABLE> {
    <type> <column> PK
  }
```

## Tables

### <table>

source: <path:line of the defining migration or schema file>

| column | type | null | default | key | notes |
|---|---|---|---|---|---|
| <column> | <type> | <yes|no> | <default or -> | <PK|FK -> table.column|UK|-> | <readers/writers path:symbol when relevant> |

indexes: <name (columns) [unique], ... or none>

## Invariants

- INV-<n>: <rule> (enforced by: <constraint | unique index | path:symbol>)
