# Operate surfaces

Load when the visitor mode is `operate` (app, dashboard, settings). On these surfaces boldness is measured as precision and restraint: the screen is a tool someone uses repeatedly, so speed of reading and certainty of action are the craft.

## Decisions to write

1. **The screen's single question.** The one thing the person came to answer or do ("which orders are late?"). The first screen answers it without scrolling.
2. **Shell archetype.** Sidebar plus content, top bar plus content, master-detail, single-column task flow, or command surface. Chosen for the main flow and written with the reason; the shell is reused from the existing system under `conform`.
3. **Data density.** Compact, comfortable or spacious per region, with row height and the reason (hours-long use wants compact; occasional use wants comfortable). Numbers are right-aligned with tabular numerals and carry unit and time frame.
4. **All states.** The six states of the skill's rule 3 for every region that loads separately, plus first-run empty (what the person does next) and the not-yet-configured state.

## Craft that still applies

- Type scale jump of at least 2x from body to the page title; clear weight roles for label, value and action.
- Colour by role; status colours carry meaning and always pair with text or an icon.
- Motion only to explain a change (120-200 ms); reduced-motion respected.
- Pattern registry ([PATTERNS.md](PATTERNS.md)) applies: dashboards of identical KPI cards and eyebrow labels over every block are defaults needing a reason.
- Native targets keep the platform rules in [NATIVE.md](NATIVE.md) (touch targets, text scaling, dark theme, platform conventions).
