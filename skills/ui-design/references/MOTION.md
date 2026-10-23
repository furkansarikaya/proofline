# Motion

Load for persuade and experience surfaces, and for any spec that adds animation.

## Motion thesis first

Write four lines before any tokens: the focal moment (the one motion a visitor remembers), continuity (what moves between states so the eye can follow), feedback (what answers a touch or hover), and the budget (what is allowed to move at once, and what never moves).

## Tokens

Duration and easing per interaction kind: hover, press, scroll entrance, list stagger, page transition, loading. Keep them as tokens in `DESIGN.md` (for example fast 120 ms, base 220 ms, slow 600 ms; one ease-out curve for entrances, one ease-in-out for moves). Do not scatter literal durations.

## Recipes (CSS, Web Animations API, view transitions)

- load sequence: about 1.2 s in total, headline then subline then action then visual, each starting before the last ends;
- masked line reveal: a heading line slides up from a clipped box;
- once-only scroll entrance: an element enters once and stays; it never replays on scroll up;
- press and hover feedback on every control: a small change in scale, offset or colour that is visible;
- pinned story: one section stays while its content advances with scroll;
- view transitions between pages or states where the platform supports them;
- scroll-linked progress: a bar, line or counter tied to scroll position.

## Persuade requires a motion layer

One signature motion, in-section staggers of 60-90 ms, feedback on every control, and at least one moving visual. Record `craft.motion: {thesis, signature, stagger_ms, feedback_all_controls, moving_visual, reduced_motion}`.

## Rules that always hold

- Content is visible by default. Nothing disappears without script: the hidden starting state is applied by script, never by the base stylesheet.
- Every motion has a `prefers-reduced-motion` counterpart (a static end state, or a fade of at most 150 ms). Essential feedback stays; decoration stops.
- No animation library the project does not already have. Use CSS, the Web Animations API and view transitions; the new-dependency rule applies unchanged.
- Animate transform and opacity; avoid animating layout properties.
- Operate surfaces: motion explains state (a row inserted, a panel opened) in 120-200 ms, nothing else.
