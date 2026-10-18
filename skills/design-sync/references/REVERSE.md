# Reverse engineering a design document from code

Entry point of `/proofline design system|data|api|ui --check`: the script lists code facts, the skill drafts the document, check mode proves the draft.

| Command | Facts | Target document (config key) |
|---|---|---|
| `design-sync.mjs --reverse system` | manifests found, directories to depth 2 with source file counts | `ARCHITECTURE.md` (`architecture`) |
| `--reverse data` | tables with `file:line` and the schema style that defined them | `DATA_MODEL.md` (`data_model`) |
| `--reverse api` | `METHOD path` with `file:line` | `API.md` (`api`) |
| `--reverse ui` | CSS custom properties with `file:line`, component files | `docs/design/DESIGN.md` (`design`) |

## Drafting rules

1. Every statement in the draft traces to a fact in the output or to a file you read (`path:symbol`). Nothing about intent, rationale or future plans is invented; the draft says `UNKNOWN: <what the owner must supply>` instead.
2. Use the layout the extractor reads, so the draft passes check mode:
   - `ARCHITECTURE.md`: one line per component, path in single backticks (``- `src/server/` - <what it contains per the code>``).
   - `DATA_MODEL.md`: a Markdown table with header `Table | Purpose | Defined in`, table name in backticks; purpose from the code (ORM class docs, comments) or `UNKNOWN`.
   - `API.md`: one line or table row per endpoint as `METHOD /path`, with the handler `path:symbol` and `UNKNOWN` for undocumented behaviour.
   - `docs/design/DESIGN.md`: tokens as `| Token | Value | Defined in |` rows with the location in backticks; components as `| Component | Location |` rows.
3. Group by what the code shows (module, resource), not by an invented taxonomy. Keep each document short; a document that is longer than the code facts justify is padded.
4. Do not overwrite an existing document: write the draft next to it (`<name>.draft.md` in `.agents/local/design-sync/<slug>/`, or the run's `design/` folder) and show the differences; the user or the knowledge step applies it.
5. Finish with check mode on the draft (`--api <draft>` etc. flags point the script at it): zero unmatched claims is required before presenting.
6. Ask the user (one round) for the `UNKNOWN` items that matter; the rest stay `UNKNOWN`.
