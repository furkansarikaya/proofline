# Creative direction

Read in task mode before drafting screens. Output: `creative_direction` in `ui.json` and the "Creative direction" section of `UI.md`. Required for COMPLEX and CRITICAL tasks; optional (validated when present) otherwise.

There is no style catalogue here on purpose. A direction is derived from the product, its users and the system that already exists, never picked from a list of looks.

## 1. Choose the basis first

| Situation | `basis` | What you may do |
|---|---|---|
| `DESIGN.md` exists | `conform` | Work inside it: its tokens, type scale, spacing, components and tone. The direction describes how this screen applies the system, not a new look. |
| `DESIGN.md` exists and the task explicitly asks for a redesign | `redesign` | Only with both: the task's own words asking for a visual change (`redesign.task_quote`, copied verbatim from TASK.md) and the user's approval (`redesign.user_approval`: a reference to the recorded answer, `questions/<NNN>.answer.md`, `Q<n>` or `INTENT.md#<decision>`). Without the approval, ask (NEEDS_INPUT) and design under `conform` meanwhile. |
| No `DESIGN.md`, but UI code exists | `conform` | Reverse-engineer `DESIGN.md` first (METHOD.md section 1), then conform to what the code already does. |
| No `DESIGN.md` and no UI yet (new project) | `new` | Set an original direction (below) and record the generic defaults you rejected in `avoided`. |

A redesign is never inferred from "make it nicer", from drift in the code, or from your own taste. Your judgement that the current system is weak is a finding (`designer-<n>`, severity `info`), not a licence.

## 2. The four decisions

Write each as a short statement plus the reason, grounded in evidence (TASK.md, INTENT.md, EVIDENCE.md, the existing UI, the product's users):

1. **Visual character**: what the interface should feel like to its users and why (for example: a tool used for hours a day by operators wants calm, dense, low-chroma surfaces; a once-a-year form for the public wants generous spacing and one action per screen). Name the users and the context of use the statement rests on.
2. **Typography**: the existing scale (conform) or the scale you set (new): roles (display, heading, body, label, numeric), sizes, weights, line heights, and why they fit the content (long-form reading, scanning tables, numeric comparison).
3. **Layout approach**: grid, alignment, density, how space is distributed, what is fixed and what scrolls, and why that suits the task's main flow.
4. **Content hierarchy**: what the user must see first, second and third on each screen; which single action is primary; what is secondary or deferred. Tie it to the acceptance criteria.

`rationale` connects the four to the evidence in one paragraph. A rationale that would fit any product ("clean and modern", "user-friendly") is not a rationale.

## 3. New projects: avoid the generic default

A new direction must be specific to this product. Before settling, list the defaults a generated interface tends to fall into, check each against your draft, and record the ones you rejected (with why) in `avoided`. Typical defaults to check:

- the same centred hero, three feature cards and gradient call-to-action on every product;
- purple-to-blue or neon gradients, glassmorphism and glow used as decoration rather than meaning;
- every surface a rounded card with a soft shadow, whatever the content;
- emoji or generic icons as section markers instead of labels;
- one neutral sans-serif at one weight for everything, so nothing has hierarchy;
- decorative motion with no state meaning;
- dashboards of large KPI numbers with no comparison, unit or time frame.

Rejecting a default needs a reason from this product (its users, content or brand material in the repo), not taste. Keep the direction small enough to express with tokens: colour roles, type scale, spacing scale, radii, elevation.

## 4. Conformance check

Before writing the direction, confirm against `DESIGN.md` (when it exists): every colour, size, spacing and radius you plan to use is a token there; every component is listed there or is a `new` item with `reuse_rejected`. A direction that needs values outside `DESIGN.md` is either a `new` token (justified) or a redesign (needs approval), never a silent addition.
