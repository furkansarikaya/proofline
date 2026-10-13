# Spec self-critique

Read after the screens are drafted and before validation. Output: `self_critique` in `ui.json` and the "Self-critique" section of `UI.md`. Required for COMPLEX and CRITICAL tasks; optional (validated when present) otherwise.

The self-critique finds and fixes weaknesses in your own spec. It is not an approval. **The designer never gives final quality approval of its own design**: whether the built UI is good is judged independently (QA's visual focus and the reviewers). Never write a verdict about your own design ("this design is approved", "signed off", "LGTM", "ready to ship", "production ready", "no issues remain", "meets all criteria") anywhere in the spec; the validator rejects it. Naming the product's own approval features, or that the user approved an `accepted` item in Q3, is fine.

## The four passes

Write one finding-oriented sentence or two per pass: what you checked, what you changed, what remains a risk.

1. **Hierarchy.** On each screen, is the primary action and the most important information found first? Exactly one primary action per view; headings follow the content order; nothing secondary competes visually with the primary.
2. **Density.** Is the amount of information per viewport right for the user and frequency of use stated in the UX pattern decision? Too dense: no grouping, no whitespace between groups, truncation without access to the full value. Too sparse: the main task needs scrolling or extra clicks for no gain.
3. **Consistency.** Same job, same pattern, same component, same wording across screens and with the existing product. Tokens only from `DESIGN.md` (or justified `new` items). Copy tone matches the product.
4. **Legibility.** Type sizes and line lengths fit the content; contrast of every new text/surface pair meets the `DESIGN.md` baseline (state the ratio); state is never shown by colour alone; numbers align and carry units.

## Anti-pattern checklist

Record each item in `self_critique.anti_patterns` as `clear` (not present), `fixed` (was present, changed; say how) or `accepted` (present on purpose; the note says why and who decided). Check at least these:

- a state shown by colour alone (error, selection, status);
- placeholder text used as the only label;
- an icon-only control without an accessible name;
- disabled controls with no reason shown;
- a modal on top of a modal, or a modal for content the user must compare with the page behind it;
- infinite scroll where the user needs a position, a total or the footer;
- truncated text with no way to read the full value;
- a destructive action as the visually primary button, or without confirmation or undo;
- layout shift when loading finishes or an error appears;
- focus lost or reset to the page top after an action;
- an error message that does not say what to do next;
- a hover-only affordance with no keyboard or touch equivalent;
- the same action labelled differently on different screens;
- a generic default from CREATIVE-DIRECTION.md section 3 that crept back in.

An item you mark `accepted` that conflicts with an acceptance criterion or with `DESIGN.md` is not acceptable: change the spec or ask the user.
