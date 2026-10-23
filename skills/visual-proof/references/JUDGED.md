# Judged items (COMPLEX and CRITICAL only)

Judgement covers what no measurement settles: **hierarchy** (what the eye reads first, whether it is the
primary task), **density** (information per screen against the spec's stated density and the users' task),
**consistency** (the same element looks and behaves the same across screens, states and the existing design
system) and **typography** (scale, line length, weight contrast, legibility at each viewport). A fifth aspect, **character**, asks whether the rendered UI reflects the visual
character written in DESIGN.md and whether patterns listed in `creative_direction.avoided` have leaked back in.
It is required only for COMPLEX and CRITICAL tasks whose `creative_direction.basis` is `new` or `redesign`
(the validator reads it from `--ui <ui.json>`); otherwise it is accepted but optional. It follows the same rules below.

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
4. At least one item per required aspect; more where a screen or viewport differs. No `value` or `threshold`:
   anything measurable belongs in `measured[]`.
5. Judged items never close the gate alone: a report with judged items and no measured coverage is invalid.

## Critique (14 points)

When the `design` group runs for a COMPLEX or CRITICAL task, `report.json` also carries `critique[]`: the 14 questions below, each answered `ok` or
`concern` with a reason, looking at a screenshot of the rendered page. There is no score and a numeric field (`score`, `rating`, `points`) is rejected; a
`concern` is an `info` row, and the critique never closes the gate. The measured design items and `lint.json` are where a failure can come from; the critique
says what the numbers cannot. Look at the screenshot first, then write what is visible.

```json
{ "id": "squint", "status": "concern", "reason": "At half size the hero and the pricing block weigh the same; the eye has no first stop.",
  "screenshot": { "path": "screenshots/index-wide.png", "sha256": "<from the cell>" } }
```

| id | Question |
|---|---|
| `glance_1s_5s` | After one second, can you say what kind of thing this is; after five, what it does and what to do next? |
| `squint` | Blurred or at small size, is there one clear first stop, then a second? |
| `logo_off` | With the logo and name covered, is this still recognisably this product and not any product of its category? |
| `edge_alignment` | Do blocks share a few left edges and one outer margin, or does everything drift? |
| `space_and_frames` | Does space, not a frame around everything, separate and group content; is the rhythm of gaps deliberate? |
| `type_jumps` | Are the steps between heading, subheading and body clear, with a voice that fits the product? |
| `color_ratios` | Is one colour dominant, support colours rarer, the accent scarce enough to mean something? |
| `visual_count_and_motion` | Is there enough real imagery or moving content for the surface, and does motion help the story? |
| `section_monotony` | Do consecutive sections differ in composition, or is it one block repeated? |
| `phone_composition` | At 390 wide, is the page composed for the phone, not a shrunken desktop (order, crops, tap size)? |
| `screen_fullness` | Does each screen feel complete: no void, no section squeezed to one side, no placeholder? |
| `content_completeness` | Is every promised piece present with real content, in the page's language, with no internal names or leftover labels? |
| `overlaps` | Does anything collide, clip or cover something it should not, at any of the three widths? |
| `one_live_thing` | Is there one real thing the visitor can do on the page; does it work and not block reading? (persuade and experience only; otherwise `not_applicable` with a reason) |

Rules: every id appears once; `reason` is never empty; a `concern` names what is wrong and where, in a sentence a fixer can act on. Where a critique concern
repeats a failed measured item, the measured item is the finding. Taste that the spec does not state stays a `concern`, as above.

## UX review (`ux_review[]`)

`ux-rules.json` lists every UX rule with its severity and `measure`: a check id, or `judged`. For COMPLEX or CRITICAL with the `design` group, `report.json` carries
`ux_review[]`: one item `{rule, status ok|concern|not_applicable, reason, screenshot {path, sha256}}` for **every rule that is `judged` and `high`**
(the validator names the missing ones). Medium and low judged rules are optional: add an item when the screenshots show a problem. A rule measured by a check has no item
here; its failure is the measured item. `not_applicable` (a rule about a surface the product does not have, such as a gesture on a desktop-only page) needs a reason.
A surface with a chart may add the extra id `chart_type` (see [CHARTS.md](CHARTS.md)). Same rules as the critique: a non-empty `reason`, a `concern` says what is wrong and where,
no numeric score, never closes the gate (`concern` is an `info` row). The rule id reads as `<group>-<topic>`; judge the rule by what its name asks on the rendered page.
