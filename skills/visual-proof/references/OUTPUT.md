# Output

## report.json (`schema: visual-proof/1`)

| Key | Content |
|---|---|
| `class` | `STANDARD`, `COMPLEX` or `CRITICAL` (TRIVIAL is rejected: it has no visual focus) |
| `result` | `PASS`, `FAIL`, `INCONCLUSIVE` or `UNSUPPORTED`; recomputed by the validator, a disagreeing value is rejected |
| `tool` | `kind` (`headless-browser`, `project-tool`, `runtime-adapter`, `none`), `name`, `version`, `detected_by` |
| `unsupported_reason` | only with `tool.kind: none`; then `measured`, `judged`, `cells` are empty |
| `viewports`, `screens`, `interactions` | from the config (`screens[].states` in spec order, default first) |
| `cells[]` | `screen`, `state`, `viewport`, `screenshot {path, sha256}`: one per rendered cell |
| `measured[]` | `id` `M-n`, `check`, `screen`, `state`, `viewport`, `selector`, `value`, `threshold`, `status` `pass|fail|not_applicable`, `evidence {path, sha256}`, optional `criteria`, `note`, `interaction` |
| `not_measured[]` | `scope` `cell` (a required check of a cell: makes the result INCONCLUSIVE) or `element` (one element a check could not read: a limit, no effect), `check`, the cell keys, `selector` (element), `reason` |
| `judged[]` | [JUDGED.md](JUDGED.md) |
| `a11y_scanner` | `{status: run, tool}` or `{status: not_available}`; when run, it is a core check of every cell |
| `regression` | `{status: not_available, reason}` or `{status: run, command, exit, baselines: existing}`; `baselines_created` is never true |
| `criteria[]` | `id`, `required`, `status` `proven|failed|unproven` (recomputed) |

Validator checks (`validate-visual.mjs`): every screenshot path is relative to the report folder, exists and
has the recorded sha256; every measured item has all its keys and a status consistent with its numeric value
and threshold; every cell the class requires exists and accounts for every core check; STANDARD has no
judged items and at least 2 viewports; COMPLEX/CRITICAL have 3 viewports, every state and a judged item per
aspect; a judged violation quotes a criterion found in `--spec`/`--plan`; with `--plan`, every id on the
`visual_proof:` line is a required criterion.

## Result

1. `tool.kind: none` -> **UNSUPPORTED**.
2. Any measured `fail`, judged `violation` or failing regression run -> **FAIL**.
3. Otherwise any cell-level `not_measured` entry or required criterion `unproven` -> **INCONCLUSIVE**.
4. Otherwise **PASS**.

Criterion status: `failed` when a tagged measurement fails or a judged violation names it; `proven` when at
least one tagged measurement passes; otherwise `unproven`.

## REPORT.md and submission

Write `REPORT.md` from [OUTPUT.template.md](../assets/OUTPUT.template.md): the `SUMMARY` line, the failures with
selector, value, threshold and screenshot, the criteria table, the judged section, what was not measured and
the limits that apply. Team mode: `agent.sh submit --focus visual --artifact reviews/visual-proof/REPORT.md`
with the rows `validate-visual.mjs --rows` printed (`blocking|<screen path>:<selector>|...|measured; <png>
sha256:<12>`); replace the location with the source `path:line` of the rule once you located it (it becomes
the fix scope). The `SUMMARY` line goes into the completion report's `## QA Result`.

## verify-proof interface

verify-proof treats each id on the frozen PLAN `visual_proof:` line as needing visual evidence: its AC row is
`PASS` only when the evidence cell cites `visual-proof: <AC-n> proven` from a valid report (validator exit 0);
otherwise the row is `MISSING` (unproven), whatever tests pass.
