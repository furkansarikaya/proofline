# UX pattern comparison

Read when a screen or flow has more than one reasonable interaction pattern. Output: `ux_patterns` in `ui.json` and the "UX patterns" section of `UI.md`. Required (at least one decision) for COMPLEX and CRITICAL tasks; optional (validated when present) otherwise.

## When a comparison is needed

Compare whenever the task introduces or changes one of these, and the existing system does not already settle it:

- collection display: table, list, cards, grid, tree;
- navigation: sidebar, top bar, tabs, breadcrumbs, command search;
- editing: inline edit, modal dialog, side panel, dedicated page, wizard;
- filtering and search: always-visible filters, filter panel, query field, saved views;
- feedback: inline message, toast, banner, status region, page-level error;
- long or multi-step input: single page, sections with anchors, stepper;
- destructive actions: confirm dialog, undo window, typed confirmation.

When the existing system already uses one pattern for the same job, the comparison is short: name the existing pattern and its path, and choose it unless the task's evidence says it fails here.

## What each decision records

| Field | Content |
|---|---|
| `decision` | the question, e.g. "how the order list is displayed" |
| `options` | at least two real alternatives that fit the content (not a straw man) |
| `chosen` | exactly one of `options` |
| `density` | information density of the chosen pattern: rows or items per viewport, what is shown per item, what is deferred to detail |
| `flow` | the user's path through the pattern for the main task (steps and keyboard path), and how it joins the existing flows |
| `rationale` | why the chosen option wins here: the content shape (columns compared across rows favour a table; heterogeneous items with media favour cards), the frequency and expertise of use, the existing system's pattern for the same job (path), and the cost of the rejected options |

## How to weigh the options

1. **Content shape first.** What the user does with the data (compare, scan, read, act on one item) decides more than looks.
2. **Consistency with the existing system.** The same job uses the same pattern across the product. Breaking consistency needs a reason from the task.
3. **Density versus clarity.** Frequent expert use tolerates high density; occasional or first-time use needs fewer items and clearer labels. State the target user.
4. **Keyboard and screen-reader cost.** A pattern that is hard to operate without a pointer (drag-only reordering, hover-only actions) loses unless an equivalent is specified.
5. **Responsive behaviour.** Say what the chosen pattern becomes at the narrowest breakpoint (a table that reflows to stacked rows, a sidebar that becomes a menu button).

The comparison informs the spec; it never changes requirements. A choice that changes behaviour the task does not settle is a NEEDS_INPUT question, not a decision.
