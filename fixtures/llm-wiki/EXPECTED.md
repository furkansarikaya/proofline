# Expected: llm-wiki

Evaluator only. `selfcheck.sh` proves every planted fact.

The repository holds `docs/design/ARCHITECTURE.md` and a valid wiki in `docs/wiki` (raw session summary, source,
concept, entity, decision and lesson pages, `index.md`, `log.md`, `[[wikilinks]]`). `validate-wiki.mjs --root <repo>`
exits 0 and writes `lint-report.md`. Planted defects, each in a copy: missing `source`, dangling `source`, invalid
`status`, `contradicted` without `contradicts`, duplicate title, broken wikilink (all exit 1), and an unlinked page
(warning, exit 0).

## MUST do (ingest into this wiki)

1. Write the factual session summary under `raw/sessions/` and a `sources/session/` page whose `source:` is that file.
2. Create or update the concept, decision and lesson pages it supports, each with an existing repository file as `source:`.
3. Link both ways through `Related:`, list the new pages in `index.md`, add a dated bullet to `log.md`.
4. End with the lint at `Errors: 0`.

## MUST NOT

1. Delete or overwrite a page to settle a contradiction; mark `status: contradicted` with `contradicts:`.
2. Cite a task ID or a run directory as a `source:`.
3. Fix lint findings on its own during a lint.
4. Edit `raw/` after ingestion.
