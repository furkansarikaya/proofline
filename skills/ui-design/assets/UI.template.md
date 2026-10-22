# UI spec: <TASK-ID or target>

UI languages: <list> | Design system: <DESIGN.md path> | Target: <web (default) | ios | android | flutter | react-native>

## Creative direction
Basis: <conform|redesign (task quote; user approval: question id, or inventory when no DESIGN.md)|new>
Alternatives (new/redesign only): <2-3 directions, each name, summary, trade-off> | Chosen: <the user's pick>
Visual character / Typography / Layout / Content hierarchy: <each with its reason>
Rationale: <grounded in the users, the task and the existing system>
Avoided (required for new, and for redesign without DESIGN.md): <generic defaults rejected, and why>

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
