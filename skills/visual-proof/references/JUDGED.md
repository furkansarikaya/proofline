# Judged items (COMPLEX and CRITICAL only)

Judgement covers what no measurement settles: **hierarchy** (what the eye reads first, whether it is the
primary task), **density** (information per screen against the spec's stated density and the users' task),
**consistency** (the same element looks and behaves the same across screens, states and the existing design
system) and **typography** (scale, line length, weight contrast, legibility at each viewport).

Each item in `judged[]`:

```json
{ "id": "J-1", "aspect": "hierarchy", "screen": "orders", "state": "success", "viewport": "phone",
  "screenshot": { "path": "screenshots/orders-success-phone.png", "sha256": "<from the cell>" },
  "spec_ref": "design/UI.md#orders (or PLAN.md ## UI, or AC-6)",
  "observation": "The promo banner is the most prominent block; the orders table starts below the fold.",
  "status": "ok | concern | violation",
  "violates": { "ref": "AC-6", "quote": "the page title is the largest text on the screen" } }
```

Rules:

1. Cite a screenshot of a measured cell (same path and sha256) and the spec or plan section judged against.
   Look at the screenshot before writing; describe what is visible, not what the code suggests.
2. `ok` and `concern` never change the result; a concern is an `info` row.
3. `violation` only when a criterion written in the spec or plan says otherwise, quoted verbatim in
   `violates.quote` (the validator checks the quote against the `--spec` and `--plan` files). Taste, a
   generic best practice or a design-system preference that the spec does not state is a `concern`.
4. At least one item per aspect; more where a screen or viewport differs. No `value` or `threshold`:
   anything measurable belongs in `measured[]`.
5. Judged items never close the gate alone: a report with judged items and no measured coverage is invalid.
