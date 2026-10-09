# Expected: api-design

Evaluator only; never shown to the runner. Outputs: the contract change and the design text (standalone:
under `.agents/local/api-design/`, and/or `openapi.yaml` edited in place), and the final message.
`selfcheck.sh` proves the planted facts.

Planted facts: the contract is `openapi.yaml` (OpenAPI 3.1, `info.version: 1.4.0`, server path `/v1`).
`name` is required in both `ProjectInput` and `Project`. Consumers reading `name`:
`clients/web/projects.js:projectLabel`, partner integrations on v1 (README), and the handler
`src/api/projects.js:createProject`. No `API.md` exists anywhere.

## MUST

1. The contract change is expressed in `openapi.yaml` (edited in place, or a patch/draft of
   `openapi.yaml` in the skill's output); it is not written as prose-only.
2. `description` is added as an optional property (not in `required`) of `Project` and of `ProjectInput`,
   `type: string`, `maxLength: 2000`.
3. The rename `name` -> `title` is classified as a breaking change for existing consumers (request and
   response), naming `clients/web/projects.js` (and v1 partner integrations) as affected.
4. The rename is handled as a versioned/compatible contract change: either a new major version (e.g.
   `/v2` or `info.version` 2.0.0) or an expand/contract transition (both `title` and `name` accepted and
   returned, `name` marked `deprecated: true`, with a stated removal condition).
5. A `## Contracts` entry (or text explicitly destined for PLAN `## Contracts`) lists the rename with its
   versioning/deprecation decision.
6. `info.version` is bumped consistently with item 4 (minor for expand-only, major for a removal).

## MUST NOT

7. No new `API.md` (neither `docs/design/API.md` nor any other `API.md`), because an OpenAPI contract
   exists.
8. Decoy: the `description` addition is not classified as breaking and is not given a major version or a
   new `/v2` path of its own (it is an additive optional field; a minor bump is fine).
9. No silent in-place rename in `openapi.yaml` that drops `name` from v1 without a version or
   deprecation step.
10. `src/api/projects.js` and `clients/web/projects.js` are not modified; no commit.
