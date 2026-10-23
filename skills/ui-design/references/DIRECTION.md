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

## 5. Candidates, deal, standard option

Derive 5-7 candidate directions from the product's world (never from a list of looks). Each decides: `composition` (page structure), `colour_strategy` (`restrained | committed | full-palette | drenched`), `type_voice`, `visual_mode` (what the imagery is made of), `signature_motion`, and `first_screen` (what the first screen shows). Names are unique and say something about the idea.

Then deal: `node <skill-dir>/scripts/deal.mjs --candidates design/ui.json` prints `{"seed": N, "dealt": [three names]}`. Same seed and same candidate names give the same three, so the validator re-deals and rejects hand-picked results. Record `deal: {seed, dealt, standard}`.

Next to the three dealt stands one calm, category-standard option (what a typical site of this category does, done well). It is the user's door: flag it `standard: true`, name it in `deal.standard`, and do not recommend it (no `recommended` field). `alternatives` is therefore the three dealt plus the standard (four entries); the user chooses (NEEDS_INPUT in a run, a question standalone) and `chosen` is one of them. Other modes keep 2-3 alternatives.

## 6. One live thing (persuade)

One interaction the visitor can do with real content (type a value and see the result, drag through a sample, filter real items). It works on a phone, has a no-script fallback (the static result is readable), and does not block reading (nothing waits for it). Record `craft.live_thing: {description, phone_ok, no_script_fallback, does_not_block_reading}`.

## 7. DESIGN.md first, final form after the build

For `persuade` and `experience` write `DESIGN.md` first as the direction contract (the chosen direction's tokens, type, colour roles, motion tokens, pattern justifications). After the build, the knowledge step updates it from the world as built: the document follows reality, rules are not defended against what shipped.
