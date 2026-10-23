# Pattern registry (calibration)

Load before settling a direction and before the self-critique. Registry date: 2026-10-23

These are the looks that generated interfaces converge on. They are defaults, not bans: a default is what happens when nobody decided. Using one on purpose needs a written reason from this product; using one without a reason is the failure. The registry is dated because the converged looks move; ids are stable. `visual-proof` carries the detectors for the same ids (lint and rendered checks).

## How to justify a pattern

1. Name the id in `creative_direction.patterns_used: [{id, reason}]` (unknown ids are rejected, a reason is mandatory).
2. Write the same line in `DESIGN.md` under `## Pattern justifications`: `- <pattern-id>: <reason>`. A lint finding for an id drops from blocking to info only when that line exists with a non-empty reason.
3. A good reason cites the product (its users, content or brand material), not taste: "children's product, the emoji are the content" holds; "looks friendly" does not.
4. A pattern you considered and rejected goes in `avoided` (free text; it may name ids).

## The 15 patterns

| id | The default | What replaces it |
|---|---|---|
| `cream-serif-terracotta` | cream ground, contrasting serif display, terracotta accent | a palette from the topic inventory (its materials, its printed matter) |
| `dark-single-neon-glow` | near-black ground, one neon accent, glow around it | a colour strategy chosen on purpose; glow only where it means "live" |
| `hairline-newspaper` | 1px rules, thin boxes and column rules everywhere, a faux newspaper grid | colour fields, spacing and scale doing the separating |
| `uniform-saas-cards` | a row of identical rounded cards, icon on top, title, two lines | different sizes for different weights of content; one large, others small, or no cards |
| `eyebrow-label` | a small uppercase label above every heading | a stronger heading; a label only where it carries information |
| `mono-labels` | monospace text "to look technical" for labels and metadata | the product's real type voice; monospace only for actual code or aligned figures |
| `numbered-steps` | 01 / 02 / 03 numbering on sections or steps | order shown by layout; numbers only for a real sequence the visitor follows |
| `middot-meta` | meta lines joined with middots (a · b · c) | separate, labelled facts; or one sentence |
| `gradient-text` | headline filled with a gradient | solid colour; emphasis by size and weight |
| `decorative-glass` | frosted translucent panels with no job | real surfaces; blur only over content it needs to separate from |
| `side-stripe-card` | a card with a coloured stripe down one edge | a status icon plus text, or a tinted field |
| `hard-offset-shadow` | solid offset shadow behind boxes and buttons | elevation tokens, or none |
| `emoji-icons` | emoji standing in for icons or section markers | a consistent icon set, or labels alone |
| `sketch-svg` | hand-drawn-looking SVG blobs and squiggles as filler | real illustration, a real photo or diagram, or nothing |
| `grid-background` | grid-paper or dot-grid page background as atmosphere | a colour field, a photo, or a meaningful pattern from the topic inventory |

Notes: hairline boxes are detected under `hairline-newspaper`. A pattern is only a finding when it is a habit; one monospace price table is not `mono-labels`.

## Calibration questions

Squint at the draft and ask: which of the 15 is this? Which did I choose, and which just appeared? If the answer for a pattern is "appeared", either replace it or write the reason. If the page matches the first two (cream/serif/terracotta or dark/neon) at once with a SaaS card row, restart from the idea sentence ([DIRECTION.md](DIRECTION.md)).
