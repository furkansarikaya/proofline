# Direction: mode, inventory, argument, idea, deal

Load for any task whose spec carries `creative_direction`, and always for `new` and `redesign`. This is the thinking that comes before any look. Output goes to `visitor_mode`, `argument` and `creative_direction` in `ui.json`.

## 1. Visitor mode (per surface)

The mode belongs to the surface, not to the product. A tool's landing page is `persuade`; the same tool's dashboard is `operate`.

| Mode | Surfaces | Boldness and polish |
|---|---|---|
| `persuade` | landing, marketing, pricing | full courage: real imagery, a motion layer, strong type, a thesis first screen |
| `experience` | portfolio, gallery, showcase | full courage; the surface itself is the product |
| `operate` | app, dashboard, settings | precision, scannability, restraint ([OPERATE.md](OPERATE.md)) |
| `read` | docs, article | measure, rhythm, restraint |

Write `visitor_mode: {mode, reason}` at spec level (a screen may carry its own to override). Required when `basis` is `new` or `redesign`; for `conform` it is optional but recommended. Under `conform` the existing system is unchanged whatever the mode; boldness there is limited to what the system already allows.

## 2. Topic inventory

Before any direction, list 8-12 concrete things that belong to this product and not to its nearest rival: its name and what the name means, its output, its object, a place, a ritual, printed matter in its world (tickets, labels, ledgers, forms), its numbers, its constraint. Read `docs/product` when it exists; otherwise the repo. Items are nouns with substance ("the 04:30 harbour tide table"), not adjectives ("fast", "simple"). Record as `creative_direction.topic_inventory`.

## 3. Argument (one line per section, claim plus proof)

Before design, each section of a page is one line: the claim it makes and the proof behind it. A section with no claim does not exist. Record as `argument` rows `{screen, section, claim, proof}`.

- `proof: {kind: "product-fact", file: "docs/product/<file>.md", ref: "<id or heading anchor in that file>"}`: the file exists and the reference is really in it.
- `proof: {kind: "code", path: "<repo path>"}`: a fact anyone can verify in the code (a limit, a supported format).

On a persuade surface every claim must be linkable. A claim you cannot link does not enter the page: cut it or ask the user (NEEDS_INPUT).

## 4. Idea sentence and rival test

Write one sentence: "On this page, [inventory item] becomes [tool the direction wants]." Example: "On this page, the tide table becomes the navigation." Then put the nearest rival's name where the inventory item stands and read it again. If the sentence is still true, the idea is generic: reject it and write another. "Clean and modern" is not an idea. Record `idea: {sentence, rival, rival_swap: "no_longer_true", note}`; the note says in one line why the rival cannot say it.

## 5. Brief, deal, standard option

Directions are not derived from habit: a model's own candidates fall into the same moulds. They are drawn by `scripts/deal.mjs` from the bundled library (composition, type, palette and motion decisions of real sites), and the steps around the deal (inventory, argument, idea, rival test) force the adaptation to this product.

1. Write the **brief** as JSON: `{mode, sector, tone?, imagery, sections, brand?, subject_colours?}`.
   - `mode`: the surface's visitor mode. `sector`: a library sector (restaurant, saas, dev-tool, culture, ...; an unknown one is dealt as `other` and says so). `tone`: optional (bold, editorial, luxury, playful, quiet, warm, technical).
   - `imagery` is only what **really exists**: `project-photos`, `product-photo`, `real-ui`, `illustration`, `video`, or `["none"]`. Library photos are not project imagery and never go here.
   - `sections`: the roles in the argument's order (intro, showcase, features, how-it-works, stats, testimonial, proof, pricing, faq, cta, footer, about, work, gallery, list, contact). Operate: the screen kinds (overview, list, detail, settings, ...); add `kind` when the sector does not name the app kind.
   - `brand`: constants that stay (`palette`: two or more hex colours, `font`: a family). `subject_colours`: the colours of the subject's own material (a brand, a place, a product).
2. Run `node <skill-dir>/scripts/deal.mjs --brief brief.json [--seed N]`. It prints the seed, the inputs, three directions and the standard option. Each direction carries a hero, one template per section role, a type system (with its font-licence status), a palette and a motion signature; operate directions carry an app style, a shell and a pattern per screen. A composition whose `needs` the imagery does not satisfy is never dealt, and a template that stands on photographs or real UI the brief does not have is replaced by another template of the same role. If no direction can satisfy the brief, the output says why (exit 3): change the brief honestly, never relax it.
3. A **single slot** is redrawn only with a reason: `--redraw <slot> --reason "<prefix>: <specifics>"`, prefix `brand-constraint` (conflicts with a brand constant), `missing-imagery` (asks for an image that does not exist) or `content-misfit` (the content does not fit the template: the template changes, it is not bent). Slots: `2` (a whole direction) or `2.hero`, `2.type`, `2.palette`, `2.motion`, `2.section:<role>` (operate: `2.shell`, `2.pattern:<screen>`). Reasons about comfort or taste are rejected. Redraws are recorded.
4. Palette conflicts: with `brand.palette` the brand's colours are used and only the library palette's ratios are kept; with `subject_colours` that clash with the dealt accent the ratios stay, the colours come from the subject, and the output's `palette.note` says so. A font that is a brand constant replaces the dealt faces; the dealt system supplies scale and settings only.
5. A type system flagged `needs-package-licence` is dealt only when no directory-verified system of that voice exists; before using it read the licence file of the package you self-host. A system whose licence cannot be verified is never dealt.

Record `deal: {inputs, seed, dealt, standard, redraws}` where `dealt` and `standard` are the `ids` objects of the output, and `redraws` are `{slot, reason}`. The validator replays the deal and rejects any mismatch, so nothing can be chosen by hand.

Next to the dealt directions stands one calm, category-standard option (flagged `standard: true` in the output, drawn from a direction that is not dealt). It is the user's door: do not recommend it. `alternatives` is the dealt directions (named by their direction id, operate: style id) plus the standard option (`standard-<id>`, `standard: true`, no `recommended` field); the user chooses (NEEDS_INPUT in a run, a question standalone) and `chosen` is one of them. Other modes keep 2-3 alternatives.

### Loading what the library names

- **Fonts (self-host).** The library's type systems name the faces, not a loading method. Download the font files (an open-licensed package or file), put them in the project, load with `@font-face`, `font-display` and a subset where it saves weight. No CDN link, no hot-linking. Verify the licence: `library:<family>` resolves in the bundled licence directory (open licences only), or point `license_ref` at the package's own licence file in the project. Record family, file, licence and source in the ledger `## Fonts` and in `craft.fonts` (`license_ref` required; a font without one is rejected).
- **Images (self-host).** Library photos are used only from sets marked usable for commercial use. Download the file, keep it in the project (no hot-linking), open the original address once to verify it still resolves, keep the credit on the page and in the ledger `## Images`. In `craft.visual_plan.images` write it as `{file, source: "library", credit}`; it is never counted as the project's own imagery, and a brief that claims `project-photos` still needs a `project` image listed.

## 6. One live thing (persuade)

One interaction the visitor can do with real content (type a value and see the result, drag through a sample, filter real items). It works on a phone, has a no-script fallback (the static result is readable), and does not block reading (nothing waits for it). Record `craft.live_thing: {description, phone_ok, no_script_fallback, does_not_block_reading}`.

## 7. Draft visual before coding (persuade)

When the runtime has an image-generation tool, a persuade surface gets a draft visual (a comp) of the chosen direction before any code: the first screen and one key section, rendered from the dealt hero, palette and type. The user sees it; the approved comp is the implementer's target and QA's reference. With no such tool the step is skipped and the skip is written in the spec ("comp: skipped, no image tool"). Every generated image enters the ledger as source `generated` with the tool and the prompt (`{file, source: "generated", tool, prompt}`).

## 8. DESIGN.md first, final form after the build

For `persuade` and `experience` write `DESIGN.md` first as the direction contract (the chosen direction's tokens, type, colour roles, motion tokens, pattern justifications). After the build, the knowledge step updates it from the world as built: the document follows reality, rules are not defended against what shipped.
