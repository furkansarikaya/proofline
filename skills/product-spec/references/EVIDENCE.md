# Evidence model

Every claim in a product document is exactly one of `fact`, `assumption` or `decision`. The claim carries its kind as a marker at the end of its line. Validator: `scripts/validate-product-claims.mjs` (the PRD check runs it on `## Problem` and `## Assumptions`).

## 1. Markers

One marker per claim, on the same line as the claim, in square brackets. No `]` inside a marker.

| Kind | Marker | Required parts |
|---|---|---|
| fact, web | `[fact: web <URL> accessed <YYYY-MM-DD> "<quote>"]` | an `http(s)` URL, the access date, a verbatim quote from the page |
| fact, interview | `[fact: interview <interview-id> "<quote>"]` | the interview id (for example `INT-3`), a verbatim quote of the person |
| fact, data | ``[fact: data `<query or script>` sha256:<hash>]`` | the query or the script path that produced the result, the sha256 (64 hex) of its output |
| fact, ref | `[fact: ref <slug>#C-<n>]` | the slug of a product folder and the id of a claim in it; valid only when `<product.dir>/<slug>/*.md` has a line starting `- C-<n> ` whose own marker is a valid fact (a ref to a missing id or to an assumption is an error; checked when the validator knows the project root, `--root`) |
| assumption | `[assumption: <risk>]` | one risk type: `value`, `usability`, `viability`, `feasibility` |
| decision | `[decision: by <who> because <basis>]` | who decided (a role, never a private name), and on what basis |

Risk types of an assumption:

- `value`: users want it or will pay for it.
- `usability`: users can find it and use it.
- `viability`: the business can carry it (cost, legal, support, sales).
- `feasibility`: the team can build it with the time, skills and technology it has.

Examples:

```markdown
Finance copies 400 rows a month by hand. [fact: interview INT-1 "I copy around 400 rows every month"]
Most exports happen on the first working day. [fact: data `scripts/exports-by-day.sql` sha256:9f2c41d09f2c41d09f2c41d09f2c41d09f2c41d09f2c41d09f2c41d09f2c41d0]
The export page loads in 1.2 s at the 95th percentile. [fact: web https://status.example.org/report accessed 2026-10-21 "p95 1.2 s"]
Finance accepts CSV instead of a spreadsheet file. [assumption: usability]
CSV is the only format of the first release. [decision: by product owner because the accounting tool imports CSV]
```

## 2. Rules

1. **A fact names its source.** `[fact]`, `[fact: web]` without the URL, date or quote, an interview without its id or quote, and data without the hash are rejected (exit 1).
2. **One kind per claim.** Two markers on one line are rejected; split the line into two claims.
3. **An unknown is never a fact.** Write it as an assumption, or as an open question of the PRD. A metric baseline nobody measured says `baseline: unknown (Q-<n>)`.
4. **Unmarked claims are reported.** A list item or paragraph line of a claim section without a marker is listed as `unmarked`; it does not fail the check unless `--strict` is given. `- none` is no claim.
5. **Quotes are verbatim.** Shorten with `...`, never rephrase. A quote in another language stays in that language.

## 3. Using it from another skill

The validator is a plain ES module without dependencies. A caller in the same skill imports it:

```js
import { validateClaims, parseMarker, RISKS } from "./validate-product-claims.mjs";
const { valid, errors, unmarked, claims } = validateClaims(text, { sections: ["Problem", "Assumptions"] });
```

A skill installed on its own does not import files of another skill. It runs the script as a command instead:

```sh
node <product-spec-dir>/scripts/validate-product-claims.mjs <doc.md> --json --sections "Problem,Assumptions"
```

`--json` prints `{ valid, errors[{line, message, text}], unmarked[{line, text}], claims[{line, kind, ...}] }`.
