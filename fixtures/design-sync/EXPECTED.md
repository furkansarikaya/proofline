# Expected: design-sync

Evaluator only; never shown to the runner. Output: `SYNC.md` (standalone: under
`.agents/local/design-sync/`) and the final message. `selfcheck.sh` proves the planted facts.

Planted facts: default locations `docs/design/DESIGN.md`, `docs/design/ARCHITECTURE.md`, `docs/design/DATA_MODEL.md`,
`docs/design/API.md` all exist. The schema source is `migrations/*.sql` (001 creates `users`, `projects`;
002 creates `tasks` as `create table if not exists "tasks"`). Routes are in `src/api/routes.js` (`:id`
style). Tokens are in `src/styles/tokens.css` (lower-case hex). The mailer was moved from
`src/jobs/mailer.js` to `src/notify/mailer.js` in the last commit; the architecture document was not
updated.

## MUST find (exactly these four drift items)

1. `docs/design/DATA_MODEL.md`: table `audit_log` is documented but no migration creates it (evidence: the
   searched schema files).
2. `docs/design/ARCHITECTURE.md`: component Mailer cites `src/jobs/mailer.js`, which does not exist; the
   file is now at `src/notify/mailer.js` (naming the new location, e.g. from `git log --follow` or a
   search, is expected).
3. `docs/design/API.md`: `DELETE /projects/{id}` has no route in `src/api/routes.js`.
4. `docs/design/DESIGN.md`: token `--color-surface` is documented but not defined in `src/styles/tokens.css`.
5. Verdict FAIL (in team mode: `RESULT: FAIL`), with exactly the four drift items above as the reasons.

## MUST NOT report as drift (decoys)

6. `tasks`: created with lower-case keywords, `if not exists` and a quoted name in
   `migrations/002_tasks.sql`.
7. `users`, `projects`: present in `migrations/001_init.sql`.
8. `./src/store/` (leading `./`, trailing `/`), `src/api/routes.js`, `src/api/handlers.js`,
   `migrations/`: all exist.
9. `GET /projects/{id}` and `PATCH /projects/{id}`: present as `/projects/:id` (parameter syntax differs
   only). `GET /projects` and `POST /projects`: present.
10. `--color-primary` (`#1A73E8` vs `#1a73e8`) and `--color-danger` (`#D93025` vs `#d93025`): hex case
    differs only. `--space-2`, `--radius-md`: identical.

## MUST NOT do

11. The design documents and the code are not edited (design-sync reports drift; fixing it is a
    separate step). No commit.
