# What is extracted and how it is matched

Implemented in `scripts/design-sync.mjs`; tests in `tests/skills/design-sync.test.mjs`.

## Claims per document

| Document (config key) | Claims | Extracted from |
|---|---|---|
| `data_model` | `table` | first column of a Markdown table whose header is Table / Table name / Name / Entity; headings `Table: x`, ``## `x` ``, `x (table)`; `CREATE TABLE` inside code fences |
| `data_model`, `architecture`, `design` | `path` | single-backtick spans that look like paths (contain `/`, or end in an extension) outside code fences; `:line` and `#anchor` suffixes dropped; spans with `*` are globs (unverifiable) |
| `api` | `endpoint` | `METHOD /path` anywhere (prose, tables, headings, code fences); table rows with a method cell and a path cell; OpenAPI (`.json`, `.yaml`, `.yml`) `paths` when the configured API doc is such a file |
| `design` | `css-var` | backticked `--name` |
| `design` | `component`, `token` | first cell of a table whose header mentions Token or Component; list items starting with a backticked name (PascalCase = component, dotted = token); a backticked path on the same line is the documented location |

## Code facts

| Fact | Recognized |
|---|---|
| tables | SQL `CREATE TABLE` (any dialect, schema prefix and quoting stripped), Prisma `model`/`@@map`, Django `models.Model` / `db_table`, SQLAlchemy `__tablename__`, EF `DbSet<T>` / `ToTable` / `[Table]`, JPA/TypeORM `@Entity` / `@Table(name=)`, Rails `create_table`, Knex `createTable`, Sequelize `define` |
| routes | Express/Koa/Fastify/gin/echo style `router.get('/x'`, `app.post(`, `.route('/x').get(`; Go `HandleFunc`/`Handle` (also `"GET /x"` patterns); Spring `@Get|Post|Put|Patch|DeleteMapping`, `@RequestMapping` (class-level prefix applied); ASP.NET `[HttpGet]`, `[Route]` (`[controller]` expanded), minimal `MapGet`; FastAPI/Flask decorators (`APIRouter(prefix=)` applied); Django `urls.py` `path()` |
| files, directories | every non-ignored path (ignored: `.git`, `node_modules`, `.agents`, `dist`, `build`, `vendor`, `target`, `bin`, `obj`, virtualenvs, caches) |
| css custom properties and definitions | any text occurrence in code files (css, scss, js, ts, vue, json, ...); components by `function|class|const|struct|... Name` or file name `Name.ext` |

Markdown and other documentation files are never code facts; the configured design documents are excluded from every search.

## Matching

- Table: names compared lowercase, quotes/underscores/dashes/spaces removed, one trailing `s` removed (`user_accounts` = `UserAccount`).
- Endpoint: method equal (or `*` on either side), paths compared lowercase with every parameter form (`{id}`, `:id`, `<id>`, `[id]`) reduced to `{}`; a code route matches when equal or when the documented path ends with the code path (framework mounted under a prefix). Documented base URLs are not claims.
- Path: exact existence (file or directory) relative to the project root; a bare file name is looked up by name anywhere; an absolute path that does not exist is treated as a URL route (unverifiable). A near miss adds `similar: <path>` to the note.
- Component/token with a documented location: the location must exist and contain the name; without a location a missing component is `unmatched`, a missing token is `unverifiable` (naming conventions vary: `color.primary`, `--color-primary`, `colorPrimary` are all tried).

## Statuses

| Status | Meaning | Effect |
|---|---|---|
| `matched` | code fact found (`evidence` lists `file:line`) | none |
| `unmatched` | searched in a supported way, nothing found | candidate drift; reviewed per SKILL rule 3; FAIL if it stays |
| `unverifiable` | the extractor cannot decide (no recognizable definitions of that kind in code, glob, unsupported framework, naming variance) | listed, never FAIL |

When the code has no recognized table definitions (or routes) at all, every table (or endpoint) claim is `unverifiable` with the reason, so an unsupported stack never produces drift.

## Known limits (reviewed by hand, never silently ignored)

Migrations are not replayed: a table created and later dropped still counts as existing. Columns, indexes, request/response shapes and ADR content are not checked. Routes built from variables or loops are not seen. A route registered in a framework not listed above is invisible.
