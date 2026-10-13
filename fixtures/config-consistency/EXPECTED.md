# Expected: config-consistency (proof-review `config` focus, A88)

Evaluator only. `selfcheck.sh` proves every planted fact with the skill's own scripts. A tiny service with
`.env.example`, `README.md`, `config/app.yaml` and `config/flags.yaml`; `main` is the base. The plan is
`.agents/runs/CC-1/PLAN-*.md`.

## Planted facts

Branch `feature/config-drift` (PLAN-drift.md names `SMTP_PORT` and `dark_mode`):

| Added or removed | Where | Planted fact |
|---|---|---|
| `process.env.SMTP_HOST` | `src/mailer.js:2` | read, defined in no example file or document |
| `const { MAIL_FROM = "...", NODE_ENV: mode2 } = process.env` | `src/mailer.js:7` | read through destructuring, defined nowhere (`NODE_ENV` in the same pattern is ambient) |
| `os.environ["QUEUE_URL"]` | `src/worker.py:3` | read, defined nowhere (a second language) |
| `api_key: "<24 characters>"` | `config/app.yaml:4` | plain-text secret in a config file |
| `new_checkout: true` | `config/flags.yaml:3` | a new flag defaulting to on that the plan does not name |
| `old_search` removed | `config/flags.yaml` | still referenced at `src/search.js:2` |
| `OLD_TIMEOUT=30` | `.env.example:5` | documented, read nowhere: note only |
| `"token": "<fake>"`, `proofline:allow-secret` | `test/fixtures/auth.json:1` | test-fixture fake secret, recognized by the project's allow marker: note |
| `dark_mode: true` | `config/flags.yaml:2` | default on, named by the plan: note |
| `beta_banner: false` | `config/flags.yaml:4` | default off: note |

Traps that must not be reported: `process.env.PORT` in `src/server.js` (pre-existing, not part of the change),
`process.env.NODE_ENV` (ambient), `process.env.SMTP_PORT` (defined in `.env.example`),
`process.env.QUEUE_WORKERS` (documented in `README.md` only), `password: "${DB_PASSWORD}"` (a reference, and
`DB_PASSWORD` is in `.env.example`).

Branch `feature/config-clean`: adds `SMTP_HOST` to `.env.example` and the mailer that reads it, plus
`beta_banner: false`.

## MUST find

1. `feature/config-drift` has exactly six blocking items: `env_undocumented` `SMTP_HOST`, `MAIL_FROM` and `QUEUE_URL`,
   `secret_plaintext` `api_key`, `flag_default_on` `new_checkout`, `flag_removed_referenced` `old_search`.
   Result FAIL.
2. The secret value appears nowhere in the report or the document: rule, key and length only.
3. The four notes are present: `env_documented_unused` `OLD_TIMEOUT`, `secret_allowlisted` `token`,
   `flag_default_on_planned` `dark_mode`, `flag_default_off` `beta_banner`.
4. Without a plan the unplanned flag is a note, never blocking, and confidence is `medium`.
5. `feature/config-clean`: no blocking item, result PASS.

## MUST NOT report (decoys)

6. No finding for `PORT`, `NODE_ENV`, `SMTP_PORT`, `QUEUE_WORKERS` or `DB_PASSWORD`.
7. The allow-listed test fixture secret is not a blocking item.
8. `LEGACY_MODE` (documented, never read, unchanged by this change) is not reported.
