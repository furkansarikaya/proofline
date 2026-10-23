# UI spec: <TASK-ID or target>

UI languages: <list> | Design system: <DESIGN.md path> | Target: <web (default) | ios | android | flutter | react-native>

## Visitor mode
Mode: <persuade|operate|read|experience> (per screen override: <screen: mode>) | Reason: <why this surface has this mode>

## Argument (persuade: every screen)
| Screen | Section | Claim | Proof (product-fact file#ref, or code path) |
|---|---|---|---|

## Creative direction
Topic inventory (new/redesign, persuade/experience, 8-12): <concrete things of this product, not its rival's>
Idea: On this page, <inventory item> becomes <tool>. | Rival: <name> | Rival swap: no_longer_true, <why the rival cannot say it>
Candidates (5-7): <name: composition, colour strategy, type voice, visual mode, signature motion, first screen>
Deal: seed <N>, dealt <3 names>, standard option <name> (never recommended)
Patterns used (id, reason): <registry ids with reasons, or none>
Basis: <conform|redesign (task quote; user approval: question id, or inventory when no DESIGN.md)|new>
Alternatives (new/redesign only): <2-3 directions, each name, summary, trade-off; persuade/experience: the 3 dealt + the standard option> | Chosen: <the user's pick>
Visual character / Typography / Layout / Content hierarchy: <each with its reason>
Rationale: <grounded in the users, the task and the existing system>
Avoided (required for new, and for redesign without DESIGN.md): <generic defaults rejected, and why>

## Craft (persuade)
Live thing: <what the visitor does with real content> | phone: <ok> | no-script fallback: <...> | does not block reading
Visual plan: real = <own photos, real UI, tool, none> | images: <files> | ledger: docs/design/IMAGES.md
Motion: thesis <focal moment, continuity, feedback, budget> | signature <...> | stagger <60-90 ms> | feedback on every control | moving visual <...> | reduced motion <...>
Fonts: <family, self-hosted file, licence>
First screen (per persuade/experience screen): headline <=48 chars (about 32) | subline | one primary action

## UX patterns
| Decision | Options | Chosen | Density | Flow | Rationale |
|---|---|---|---|---|---|

## Reused
| Kind | Name | Path |
|---|---|---|

## New (only where nothing existing fits)
| Kind | Name | Reason | Existing item rejected (and why) |
|---|---|---|---|

## Flows
1. <flow name>: <step> -> <step> (screens S1, S2)

## Screen S1: <name> (<route>)

| State | Copy | Behavior |
|---|---|---|
| empty | | |
| loading | | |
| error | | |
| success | | |
| partial | | |
| permission-denied | | |

Keyboard: <web: tab order, focus management, shortcuts. Native mobile target: optional (external keyboard / switch control only); hover and focus are not required>
Screen reader: <roles, labels, live regions, announcements; native: accessibilityLabel / contentDescription / semantics>
Responsive: <per breakpoint: reflow, hidden items, target size; native: touch target 44pt / 48dp, text scaling, dark theme, see references/NATIVE.md>

## Criteria and visual proof
visual_proof: <AC ids that need visual evidence, comma-separated, or none>

| Criterion | Screens | Visual proof | Evidence target (states, viewports, what must show) |
|---|---|---|---|

## Self-critique
Hierarchy / Density / Consistency / Legibility: <what was checked and changed>

| Anti-pattern | Result (clear/fixed/accepted) | Note |
|---|---|---|

Not a quality approval: the design is judged independently (QA visual focus, reviewers).

## Open questions
- <question> or "none"
