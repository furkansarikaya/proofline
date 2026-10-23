# Fullness and visuals

Load for persuade and experience surfaces, and whenever a draft removes ornaments or has no imagery.

## Fullness rule

Rebalancing 0.0.4: when an ornament goes, something goes in. Ornaments are replaced by larger type, colour fields, real imagery or complete content, never by emptiness.

Not accepted:

- an empty hero (no visual, or a heading floating on a blank ground);
- a vertical gap longer than half a screen between content blocks;
- a section without a heading or accessible name;
- a section squeezed to one side while the other side is blank.

The first screen is a thesis: it shows the product doing its job. Someone who looks for five seconds can say what it is and what to do. That means an h1 that names the thing, one plain sentence, one primary action named after what it does, and a visual that is real (below). The measured counterparts (`design_empty_hero`, `design_vacuum`, `design_untitled_section`) live in visual-proof.

## Visual plan

Write first what is actually real: the project's own photos, the real UI, an image-generation tool the user has, or none. Record `craft.visual_plan: {real: [...], images: [files], ledger: "docs/design/IMAGES.md"}`.

- Software shows its real UI rendered in HTML (real components with real sample content). No fake dashboards, no grey-bar charts standing in for a chart.
- Illustration: real, or none. Code-made geometry, diagrams, animated lines and typographic compositions are free and often best.
- External images only from licensed sources (open archives) with the credit recorded. Never an image of unknown origin.
- Image generation is allowed only when a tool exists in the user's setup; it is never mandatory, and "none" is a valid plan.
- Every image and every self-hosted font goes in the ledger: copy [IMAGES.template.md](../assets/IMAGES.template.md) to `docs/design/IMAGES.md`. A row is valid only with `file`, `license` and `credit` (images) or `source` (fonts) filled. visual-proof blocks a raster image on the page that has no ledger row.
