# Focused fix modes

Load when the assignment says `fix_mode: <mode>, target: <target>` (command `/proofline design ui <mode> <target>`). It is a normal TRIVIAL or STANDARD run: the designer writes a short `## UI` section, the implementer changes the code, QA and the gates run as for any UI task. The modes are ten: `bolder`, `quieter`, `polish`, `animate`, `typeset`, `colorize`, `layout`, `delight`, `harden`, `adapt`.

## Common rules

1. **Only the target.** The target is one page, section or component. List its files (and, for a section inside a shared file, its line range) in the PLAN `## UI` section as `target_paths:`. Nothing else is edited, renamed, reformatted or re-ordered.
2. **Keep the existing system.** Read `DESIGN.md` and the tokens first and use them. A mode changes how the target uses the system, not the system.
3. **Nothing new unless asked.** No new colour, font, spacing step, component or dependency. When the user's request names one, it is allowed and written into the spec. A mode that needs one to work is a question for the user, not a guess.
4. **Content stays.** Copy, structure and behaviour stay as they are, except where the mode says otherwise (`harden` adds states and handles long text; `delight` adds one small moment).
5. **Verify nothing outside changed.** Before delivery run `node <skill-dir>/scripts/scope-check.mjs --root <repo> --base <run base ref> --allow <target paths> [--ranges file:from-to,...]`. It prints `{ok, outside}` and exits 1 when a changed path (or a hunk outside a listed range) is not part of the target; fix that, never widen `--allow` to make it pass. For a persuade or experience target, also keep the pattern and fullness rules of the surface.

## Modes

**bolder** touches size, weight, contrast, scale jumps and colour use already in the system so the target has a clear focal point. Must not add a new colour or font, decoration, or more elements; it removes timidity, not restraint on operate surfaces (there: sharper hierarchy only).

**quieter** touches density, weight, saturation, contrast of secondary elements and the amount of competing emphasis. Must not remove content, lower text contrast under the accessibility baseline, or turn into a different layout.

**polish** touches alignment, spacing consistency, radii, states (hover, focus, active, disabled), small inconsistencies against the tokens. Must not change layout, content or hierarchy; it is the last pass, never a redesign.

**animate** touches transitions, entrances and feedback of the target, using the motion tokens of the project (create tokens only when none exist and say so). Must not hide content without script, animate layout properties that cost frames, or skip the `prefers-reduced-motion` counterpart; no animation library the project lacks.

**typeset** touches type roles of the target: scale, measure, line height, weight use, heading line count, number formatting. Must not introduce another font family or load a new font file unless asked; it picks from the faces the project already has.

**colorize** touches how the target applies the existing palette: roles (ground, surface, text, action, status), accents, tints derived from existing colours. Must not add a hue that is not in the palette, break contrast, or rely on colour alone to carry meaning.

**layout** touches structure and spacing inside the target: grouping, order of reading, alignment, grid use, rhythm, empty gaps. Must not change copy, tokens or the system's spacing scale, and not move things out of the target.

**delight** touches one small moment of the target (a micro-interaction, a considered empty state, a well-timed transition) made from existing tokens and assets. Must not add more than that moment, anything that blocks the task, or a decoration that the surface's mode (operate, read) would not carry.

**harden** touches the target's failure and stress cases: every error, empty, loading and partial state, long and short content, very long words, localisation growth, right-to-left text where the product supports it, missing images. Must not change the happy path look; new copy is written in the product's own UI language(s).

**adapt** touches the target's behaviour across screen sizes: breakpoints, touch targets, reflow, readable measure, images and tables on a narrow screen. Must not change the desktop design except where it breaks, and not add a separate mobile-only copy of the content.
