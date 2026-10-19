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
| `network` | `interception` (`on` for measure.mjs and a guarded adapter, else `none`: at most INCONCLUSIVE), `blocked[]` `{url, type}`: requests outside the page's origin, WebSockets and service-worker registrations that were failed, never sent; `same_origin_writes[]` `{method, url}` (POST/PUT/PATCH/DELETE to the page's own origin: at most INCONCLUSIVE without a `visual_writes:` line in the plan or spec); `unguarded[]` (child targets without the guard: at most INCONCLUSIVE) |
| `a11y_scanner` | `{status: run, tool}` or `{status: not_available}`; when run, it is a core check of every cell |
| `regression` | `{status: not_available, reason}` or `{status: run, command, exit, baselines: existing}`; `baselines_created` is never true |
| `seo` | optional (A158): `{status: run, pages[], items[]}` or `{status: not_applicable, note}` ([MEASURE.md](MEASURE.md#technical-seo)); `pages[]` `{path, status measured|not_applicable|not_measured, reason, analytics_detected[]}`; `items[]` `{id S-n, check, page, selector, value, threshold, status pass|fail|not_measured, evidence, note, reason}`; absent when `tool.kind` is `none` |
| `criteria[]` | `id`, `required`, `status` `proven|failed|unproven` (recomputed) |

Validator checks (`validate-visual.mjs`): every screenshot path is relative to the report folder, exists and
has the recorded sha256; every measured item has all its keys, a pass or fail item a numeric value and the
documented threshold of its check or a stricter one (contrast `>= 3` only for large text, recomputed from `font_size_px` and `font_weight`), and a
status consistent with value and threshold; `not_applicable` only as the fixed item measure.mjs writes when
the page has nothing of that kind (selector `body`, the reason as value, alone for its check in the cell),
counted apart from passes in `SUMMARY`; a `headless-browser` report carries `network.interception: on`; every cell the class requires exists and accounts for every core check; STANDARD has no
judged items and at least 2 viewports; COMPLEX/CRITICAL have 3 viewports, every state and a judged item per
aspect; with `seo`: a fixed note and no items when not applicable, every measured page accounts for the six per-page seo checks (a measured item or a `not_measured` item), `seo_hreflang` only where the page has alternates, `seo_analytics_consent` exactly when `analytics_detected` is non-empty, `seo_sitemap` and `seo_robots` once per site, a pass or fail item has an integer problem count whose status agrees with `== 0`; a judged violation quotes a criterion found in `--spec`/`--plan`; with `--plan`, every id on the
`visual_proof:` line is a required criterion.

## Result

1. `tool.kind: none` -> **UNSUPPORTED**.
2. Any measured `fail`, failed seo item, judged `violation` or failing regression run -> **FAIL**.
3. Otherwise any cell-level `not_measured` entry or required criterion `unproven` -> **INCONCLUSIVE**.
4. Otherwise **PASS**.

Criterion status: `failed` when a tagged measurement fails or a judged violation names it; `proven` when at
least one tagged measurement passes; otherwise `unproven`.

## REPORT.md and submission

Write `REPORT.md` from [OUTPUT.template.md](../assets/OUTPUT.template.md): the `SUMMARY` line, the failures with
selector, value, threshold and screenshot, the criteria table, the judged section, what was not measured and
the limits that apply. Team mode: `agent.sh submit --focus visual --artifact reviews/visual-proof/REPORT.md`
with the rows `validate-visual.mjs --rows` printed (`blocking|<screen path>:<selector>|...|measured; <png>
sha256:<12>`); INCONCLUSIVE is submitted as `--result UNSUPPORTED` with the reason the `SUBMIT:` line prints
(`visual INCONCLUSIVE: ...`); replace the location with the source `path:line` of the rule once you located it (it becomes
the fix scope). The `SUMMARY` line goes into the completion report's `## QA Result`.

## verify-proof interface

verify-proof treats each id on the frozen PLAN `visual_proof:` line as needing visual evidence: its AC row is
`PASS` only when the evidence cell cites `visual-proof: <AC-n> proven` from a valid report (validator exit 0);
otherwise the row is `MISSING` (unproven), whatever tests pass.
