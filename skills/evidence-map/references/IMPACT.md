# Impact mode

`impact` answers one question for a change: **what else does it reach?** Input: changed symbols or files,
or a git base ref. Output: one JSON report (`version: 1`, schema [impact.schema.json](../schema/impact.schema.json)).
Read-only; never runs project code; installs nothing.

## Running it

```
node <skill-dir>/scripts/impact.mjs --repo <repo> --base <ref>                  # symbols whose lines the diff touches
node <skill-dir>/scripts/impact.mjs --repo <repo> --symbol name[@path] ...      # explicit symbols (Class.member allowed)
node <skill-dir>/scripts/impact.mjs --repo <repo> --file path ...               # every public symbol the file declares
    [--out <impact.json>] [--select symbols|files|modules|tests|contracts|references]
node <skill-dir>/scripts/validate-impact.mjs <impact.json> --repo <repo>        # exit 0 before the report is used
```

- Inputs combine. With `--base`, the diff is the working tree against `<ref>`: the symbols are the declarations whose span a changed line falls in, symbols that existed at `<ref>` and are gone now (`removed`, `deleted`), and new files. Changed lines outside every declaration set `file_level_change` on the file row.
- `--select` prints one path per line (shell consumers, `xargs`); the JSON is the contract.
- The report is deterministic: no timestamp, sorted lists. The same repository state and inputs give a byte-identical file, so a consumer may regenerate it instead of trusting a stored one.
- Where the Explorer writes it: standalone, `.agents/local/evidence-map/<slug>/impact.json` (nothing kept with `local_state: off`: use `--select` or stdout then); in a run, `--out .agents/runs/<ID>/scratch/impact.json`, the role's scratch folder (the result artifact stays the one `reports/NNN-explorer.md`). The result's claims rows cite the report's `affected`, `test` and `risk` rows as usual; the report itself is never pasted.

## What it reports

| Field | Content |
|---|---|
| `symbols[].references[]` | `path`, `line`, `text` (the trimmed line), `kind`, `role`, optional `via` (re-export chain), `local` (alias), `generated`, `note` |
| `symbols[].excluded_homonyms[]` | same-named identifiers bound to another definition (declared locally or imported from another file): shown so a reviewer sees what was NOT counted |
| `symbols[].files[]`, `modules[]` | affected non-test files (`defines`, `references-symbol`, `imports-defining-module`) and their directories |
| `symbols[].contracts[]`, top-level `contracts[]` | contract files (OpenAPI/AsyncAPI/JSON Schema/protobuf/GraphQL/Avro/Thrift) that mention the symbol, and contract files that are themselves changed (`changed: true`) |
| `symbols[].tests[]`, top-level `tests[]` | test files with `relation` `references-symbol`, `imports-defining-module`, or `covers-affected-file` |
| `changed_files[]` | per changed file: `change`, symbols, `dependents` (files importing it), `contract` format |
| `limits[]` | the stated limits of static analysis (always all of them) |
| `unknown[]` | what cannot be known: `cross-repo-consumers` always; `dynamic-sites` (path:line of eval, reflection, computed names) when present; `skipped_large` (`files`: readable files over 1 MiB that were not searched) when present |
| `analysis.tools` | language servers or analysis tools detected on the machine (`tsc`, `pyright`, `gopls`, `rust-analyzer`; project `node_modules/.bin` included); `used` is always `[]`: they are detected, never installed, never invoked and never required |

### Kind (how sure)

- **exact**: the occurrence is bound to the symbol's definition through the import graph (named, aliased, namespace, re-exported through any number of barrels, python `from x import`, go `pkg.Symbol` and same-package use) or sits in the defining file.
- **heuristic**: a code occurrence of the same identifier whose binding was not resolved (no import found, a bare specifier or path alias, member access on an unknown receiver, a language without resolution), or a file that only covers an affected file (`covers-affected-file`), or a contract naming it differently (`reserve_stock`, `ReserveStock`).
- **textual**: the identifier text in a comment, a string, prose, or a contract (exact spelling). Never evidence that code depends on it.

A `textual` role is `comment`, `string` or `doc`; the validator rejects an `exact` comment. `homonyms` are never references.

## What the validator proves

`validate-impact.mjs` proves the shape, the mandatory limits, and that each cited `path:line` exists with the recorded text. It does **not** prove the classification: that a `kind` is right, that a homonym really is another definition, or that nothing was missed. When classification matters (a gate, a plan scope), the consumer regenerates the report with `impact.mjs` (deterministic: the same inputs give a byte-identical file) and compares, or reads the cited lines itself.

## Limits (always in the report)

Dynamic dispatch, reflection, names built from strings, generated code that is not in the repository,
consumers in other repositories (`unknown`, never "none"), unresolved imports and aliases, languages
without import resolution (JavaScript/TypeScript, Python and Go have it), and the line-based comment/string scanner.
A consumer that needs completeness says so: "no references found" means "none found statically", never "safe to change".

## Consumption interface

Consumers read the report; they never edit it. Each runs `validate-impact.mjs` first and treats a non-zero exit as UNSUPPORTED for that input.

| Consumer | Reads | Use |
|---|---|---|
| Plan scope (plan-contract, lead) | `files_affected[].path`, `modules[].path`, `changed_files[].dependents` | candidate `scope` and `fix_scope` entries; a plan whose scope omits an `exact` affected file explains why |
| test-trust diff mode | `tests[]` (with `relation`, `kind`) | the tests that cover the changed symbols; `covers-affected-file` is a hint, not coverage |
| verify-proof | `symbols[].references[]` with `kind: exact` | per criterion, the call sites that must hold; a changed symbol with `unknown.dynamic-sites` is reported, not asserted |
| contract-proof (REVIEW `contract`) | `contracts[]`, `symbols[].contracts[]`, `changed_files[].contract` | which contract files change or mention the changed symbols, and the repo-side consumers (`references`, `files_affected`); consumers outside the repo are `unknown` |
