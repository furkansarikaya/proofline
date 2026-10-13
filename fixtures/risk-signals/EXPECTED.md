# Expected: risk-signals

Known answer of `agent.sh pipeline RS-1` for the project `setup.sh` builds (A78). `selfcheck.sh` compares the
lines below with the real output, line for line (order-insensitive); it is a script check, no model runs.

Planted facts: run RS-1 is COMPLEX, its baseline is the initial commit, and the working tree changes
`api/openapi.yaml`, `web/settings.html`, `package.json` and adds `db/migrations/002_settings_email.sql` and
`.env.example`, and adds `proto/v1/settings.proto`, which the plan's scope does not list. PLAN.md declares `## Data`, `## UI`, `concurrency: yes`, and `contract_change: no` although
its scope changes `api/openapi.yaml`.

## MUST hold

1. Every path signal of a scope path is found from both sources, the diff and the PLAN.md scope, with the glob that matched.
2. `contract_file` is a missing flag in the diff (a blocking finding of REVIEW_RULES focus `contract` once a
   reviewer records it; the check still runs) and in the scope (to be declared before FREEZE):
   `contract_change: no` does not declare a contract change. The nested `proto/v1/settings.proto` is a contract
   found by its path in the diff only.
3. `migration` (declared by `## Data`) and `ui_path` (declared by `## UI`) are not missing flags; the
   dependency and config signals have no flag.
4. The plan flags `concurrency` and `ui` add their focuses without a matching path: a flag set to `yes` always
   requires its check, whether or not the diff carries the signal.
5. The migration focus lands on REVIEW_DATA, the visual focus on QA, the dependency audit on SECURITY and
   contract, concurrency and config on REVIEW_RULES; no gate type is added.

## Traps (MUST NOT be a signal)

6. `src/contract.js` (named like a contract, code) and `src/openapi-client.js` (contains `openapi`, code).
7. `docs/migration-notes.md` (a guide named like a migration that also quotes `openapi: 3.0.0`) and `db/migrations/README.md` (documentation
   inside a migrations directory): plain documentation never carries a signal.

## Known answer

```
gates=SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY
focus.REVIEW_RULES.concurrency=missing
focus.REVIEW_RULES.config=missing
focus.REVIEW_RULES.contract=missing
focus.REVIEW_DATA.migration=missing
focus.SECURITY.dependencies=missing
focus.QA.visual=missing
signals=concurrency config_env contract_file dependency_manifest migration ui ui_path
signal.concurrency=source=plan:PLAN.md(## Risk concurrency: yes) check=REVIEW_RULES:concurrency flag=- design_role=-
signal.config_env=source=diff:.env.example(.env.*),scope:.env.example(.env.*) check=REVIEW_RULES:config flag=- design_role=-
signal.contract_file=source=diff:api/openapi.yaml(**/openapi*.yaml),diff:proto/v1/settings.proto(*.proto),scope:api/openapi.yaml(**/openapi*.yaml) check=REVIEW_RULES:contract flag=contract_change:no design_role=architect
signal.dependency_manifest=source=diff:package.json(package.json),scope:package.json(package.json) check=SECURITY:dependencies flag=- design_role=-
signal.migration=source=diff:db/migrations/002_settings_email.sql(**/migrations/**),scope:db/migrations/002_settings_email.sql(**/migrations/**) check=REVIEW_DATA:migration flag=data_change:yes design_role=data_architect
signal.ui=source=plan:PLAN.md(## UI section) check=QA:visual flag=- design_role=-
signal.ui_path=source=diff:web/settings.html(*.html),scope:web/settings.html(*.html) check=QA:visual flag=ui:yes design_role=designer
missing_flag.contract_file=diff:api/openapi.yaml needs PLAN.md contract_change: yes (a blocking finding of focus contract; the check still runs)
missing_flag.contract_file=diff:proto/v1/settings.proto needs PLAN.md contract_change: yes (a blocking finding of focus contract; the check still runs)
missing_flag.contract_file=scope:api/openapi.yaml needs PLAN.md contract_change: yes (declare it before FREEZE)
design_role.architect=contract_file
design_role.data_architect=migration
design_role.designer=ui_path
```
