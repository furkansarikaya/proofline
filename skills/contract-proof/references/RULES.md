# Classification rules

Every change gets exactly one rule id. The id fixes the classification; `validate-contract.mjs` rejects a
change whose classification does not match its rule, and an id that is not in this table. `diff-contract.mjs`
applies these rules mechanically; a change you classify by reading (a tool's output, a format the differ does
not parse) uses the same ids.

## Direction: who reads, who writes

Compatibility depends on which side of the contract a change sits on.

- **request** (the consumer writes, the provider reads): OpenAPI `parameters` and `requestBody`, GraphQL
  arguments and `input` types. A provider that accepts *less* than before breaks existing callers; accepting
  *more* is safe.
- **response** (the provider writes, the consumer reads): OpenAPI `responses`, GraphQL object and interface
  fields. A provider that guarantees *less* than before breaks existing consumers; guaranteeing *more* is
  safe, *except* that new values in a closed set (an enum value, a status code, a union member) reach
  consumers that may not handle them.
- **both** (the side is unknown or the data is written and read by different parties): AsyncAPI messages,
  standalone JSON Schema, protobuf messages, GraphQL enums, OpenAPI component schemas no operation uses. The
  stricter of the request and response rule applies, so loosening *and* tightening a constraint are both
  breaking there.

A `$ref` is resolved before comparing: local `#/...` references and relative external ones
(`./fragments/item.yaml#/Item`, loaded from the same side of the diff). A cycle, a URL, an absolute path or a
path leaving the repository is compared as the reference text; a relative target that cannot be loaded is
reported UNSUPPORTED. A schema reached from an operation is classified where the operation uses it, with
that operation's side; moving an inline schema into `components` and pointing a `$ref` at it is no change
at all unless the resolved shape differs.

## Breaking

| Rule | Change | Notes |
|---|---|---|
| `CP-B01` | operation, path, channel, type, message, service or rpc removed | any side |
| `CP-B02` | field or property removed | any side: request callers still send it (and may be rejected), response consumers still read it. A protobuf field removed with `reserved` is still `CP-B02`: wire-safe, but its readers lose the data. |
| `CP-B03` | type changed; on request a type narrowed, on response a type widened; a media type removed; protobuf `repeated` toggled; an rpc's request or response type changed | `integer` -> `number` widens |
| `CP-B04` | optional became required on the **request** side, or required became optional on the **response** side | also a non-null GraphQL argument or input field made from a nullable one; a `both` side always takes this rule |
| `CP-B05` | new required request field, parameter or `requestBody`, or a new non-null GraphQL argument / input field without a default; a new protobuf `required` field | **A `default` does not help in OpenAPI or JSON Schema**: `required` rejects an absent value before any default is applied, so `required` + `default` is `CP-B05`. GraphQL is different: a non-null argument with a default may be omitted (`CP-N10`). |
| `CP-B06` | enum value or union member removed | any side (a request caller still sends it; a producer of a `both` message may still emit it) |
| `CP-B07` | parameter, header or argument removed; a `requestBody` removed | |
| `CP-B08` | response status code removed | consumers branch on it |
| `CP-B09` | constraint narrowed on the request side or relaxed on the response side; a `pattern`, `format`, `multipleOf` or `const` **changed** on any side | `maxLength`, `maxItems`, `maxProperties`, `maximum`, `exclusiveMaximum` down; their `min` counterparts up; `pattern`, `format`, `multipleOf`, `const` added (request) or removed (response), and changed anywhere (a different value set is neither narrower nor wider); `additionalProperties: false`; `uniqueItems: true`; `nullable` removed (request) or added (response); a GraphQL response field made nullable |
| `CP-B10` | protobuf field number or enum number changed | wire-breaking even when the name is kept |

## Non-breaking

| Rule | Change | Direction nuance |
|---|---|---|
| `CP-N01` | optional field, property or parameter added; any field added on the response side (required there is a stronger guarantee) | a consumer that rejects unknown properties is outside the contract; list it if found |
| `CP-N02` | operation, path, channel, type, message, service or rpc added | |
| `CP-N03` | enum value or union member added on the **request** side | the provider accepts more |
| `CP-N04` | enum value or union member added on the **response** or **both** side | non-breaking **only for consumers that tolerate unknown values**. The report lists the in-repo consumers (an exhaustive `switch`, a strict decoder is the risk) as an `info` row; outside consumers are unknown. A plan or spec that says consumers must not see new values turns it into a judged FAIL. |
| `CP-N05` | documentation or metadata only: `description`, `summary`, `title`, `example(s)`, `externalDocs`, `$comment`, `info` (including `info.version`), `tags`, `contact`, `license` | `info.version` changing is not versioning of the contract surface; it never covers a breaking change |
| `CP-N06` | requirement, type or constraint loosened on the request side, or tightened on the response side | |
| `CP-N07` | response status code added | consumers that do not handle unknown codes break; reported as an `info` row like `CP-N04` |
| `CP-N08` | deprecation marker added or removed (`deprecated: true`, `@deprecated`, `[deprecated = true]`) | the element still exists, so a rename that keeps the old name as a deprecated alias is `CP-N01` + `CP-N08`, not a removal |
| `CP-N09` | protobuf `reserved` entry added | |
| `CP-N10` | non-null GraphQL argument or input field added **with** a default value | callers may omit it (GraphQL applies the default) |

## Needs review

| Rule | Change |
|---|---|
| `CP-U01` | anything else: a keyword the rules do not know (`default`, `readOnly`, `x-*` extensions, `servers`, `operationId`, composition `allOf`/`oneOf`/`anyOf` whose length changed, a changed `$ref` target that cannot be resolved, protobuf `package`, `syntax`, `option`, `oneof` membership or a removed `reserved` entry, GraphQL directives other than `@deprecated`, `implements`, a changed default value, a type that tightens one marker and loosens another). |

`needs-review` counts as **breaking** for the gate until it is classified. To classify it, the reviewer reads
both versions and either keeps `CP-U01` or replaces it by the matching rule above with `evidence.class:
traced` and `evidence.detail` naming what was read (never by the reviewer's preference).

## Parser limits (UNSUPPORTED, never guessed)

YAML: anchors, aliases, tags, merge keys, complex keys, multi-documents, multi-line plain or flow scalars,
folded `>` blocks with blank-line paragraphs or more-indented lines, flow pairs without a space after the colon
(`{x:1}`). GraphQL: multi-line argument lists, several fields on one line, `extend`. Protobuf: a statement
spanning lines, `extend`, groups.

## Not compared (documentation by definition)

GraphQL descriptions (`"..."`, `"""..."""`) and comments, protobuf comments, YAML comments and `import`
lines in protobuf are not compared; they cannot change what a consumer receives.

## Elements

A change's `element` is a qualified name: the named schema a `$ref` led to (`Order`), else the operation
(`GET /orders/{id}`) or channel (`order.placed`), then the property path (`Order.customerEmail`,
`Address.country.NL` for an enum value); a standalone JSON Schema starts at its root properties
(`status.LOST`); GraphQL `Type.field`, `Type.field(arg)`, `Enum.VALUE`; protobuf `Message.field`,
`Enum.VALUE`, `Service.rpc`.

## Coverage by the plan

A `breaking` or `needs-review` change is **covered** when one bullet of PLAN.md `## Contracts`

1. names the contract file by its exact repository path (`api/openapi.yaml`; `b/openapi.yaml` or a bare
   `openapi.yaml` does not name it),
2. names the whole element (`Order.id`; `Order.id` does not cover `User.id`, `id` alone covers nothing),
   and
3. states versioning, migration or deprecation (`version`, `versioned`, `versioning`, `migrate`,
   `migration`, `deprecate`, `deprecation`, ...) that is not negated ("no versioning needed", "migration not
   required") and is not only `info.version` ("bump info.version" moves a number, it gives consumers no path).

A bullet that misses one of the three ("refactor, no consumer-visible change", "new field, defaults to EUR")
covers nothing. An uncovered breaking or needs-review change is a `blocking` row. `validate-contract.mjs
--plan` re-derives coverage from the plan; a report's own `covered: true` is never trusted.
