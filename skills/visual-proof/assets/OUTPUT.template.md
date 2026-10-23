# Visual proof: <target name>

**Result:** <PASS|FAIL|INCONCLUSIVE|UNSUPPORTED> | **Confidence:** <high|medium|low>

`SUMMARY: <the line printed by validate-visual.mjs>`

Tool: <kind: name version, how detected | none: what is missing>. Screenshots: `screenshots/` (sha256 in
`report.json`; deleted with the run).

## Measured failures

| id | check | screen/state/viewport | selector | value | threshold | screenshot |
|---|---|---|---|---|---|---|

## Technical SEO (only when the report has `seo`)

seo: <run: pages measured, skipped (robots), failed items | not applicable: no public HTML pages>

| id | check | page | selector | problems | note |
|---|---|---|---|---|---|

## Design audit (only when the report has `design`)

design: <run (mode): pages measured, failed items | not applicable: no HTML pages>; lint: <blocking findings | none | not run>

| id | check | screen/viewport | selector | value | threshold | screenshot |
|---|---|---|---|---|---|---|

Critique (COMPLEX/CRITICAL; ok or concern with a reason, never a score; does not close the gate):

- <critique id> (<ok|concern>), `<screenshot>`: <reason>

## Criteria

| criterion | required | status | measured items |
|---|---|---|---|

## Judged (does not close the gate; COMPLEX/CRITICAL)

- J-<n> <aspect> (<status>) <screen/state/viewport>, `<screenshot>`, against <spec_ref>: <observation>
  <violation: quotes "<criterion text>">

## Not measured

- <check> at <cell>: <reason> (cell-level entries make the result INCONCLUSIVE)

## Limits

- <the limits of MEASURE.md that apply; visual regression: run (command, exit) | not available (reason)>
