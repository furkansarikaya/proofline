# ui-design method

## 1. Reverse-engineer DESIGN.md

Evidence sources, in order; cite each token/component with its path (and line or symbol):
1. Token definitions: CSS custom properties, theme files, Tailwind config, design-token JSON, SCSS/LESS variables, platform theme files (Android `themes.xml`, iOS asset catalogs, Flutter `ThemeData`), whatever the stack uses. Find with `grep` for `--`, `theme`, `tokens`, colour literals repeated across files.
2. Typography: font families, sizes, weights, line heights actually used, grouped into a scale; outliers noted.
3. Spacing and layout: the spacing scale, radii, elevation/shadows, grid/breakpoints.
4. Colour roles: map raw values to roles (surface, text, primary, danger, border, focus); report values used outside the tokens as drift.
5. Components: shared component directory; per component its path, props/variants, states it handles (hover, focus, disabled, loading, error).
6. Accessibility baseline: what the code already does (focus styles, aria usage, contrast of the main role pairs measured from the values, reduced-motion handling, minimum target size) and what is absent. State measured contrast ratios, never "looks fine".

Rules: describe what exists, no aspirational tokens. A role with no token is recorded under "Gaps". Section headings required by the validator: Tokens, Typography, Spacing, Colour roles, Components, Accessibility. Paths in backticks must exist.

## 2. Inventory for a task

For each UI element the task needs (form field, table, dialog, toast, empty state, loading skeleton, navigation), search the component directory and usages. Record `reused` (kind `token|component`, name, path) when it fits without modification, `new` (with `reason` and `reuse_rejected`) when it does not. Extending an existing component with a variant is `new` of kind `variant`; it records the base component's path in `base` (must exist) and still needs `reason` and `reuse_rejected` (why the existing variants do not fit).

## 3. Screens, flows, states

Per screen: `id` (S1...), `name`, `route` (verified path or planned route), and all six states:

| State | Specify |
|---|---|
| `empty` | what shows with zero data; the call to action |
| `loading` | skeleton/spinner, what stays interactive, timeout behaviour |
| `error` | each failure class the code can produce (network, validation, server), message, recovery action, retry rules |
| `success` | confirmation, where focus goes, what updates |
| `partial` | some data loaded/failed, truncated lists, optimistic updates pending |
| `permission-denied` | what a user without rights sees (hidden, disabled with reason, or blocked page) and where they can go |

Each state object: `copy` (every visible string), `behavior` (what the user can do, what changes), or `not_applicable` (reason). Flows: `id`, `name`, ordered `steps` (strings), `screens` (ids).

## 4. Accessibility and responsive

Per screen: `keyboard` (tab order; every pointer action has a keyboard equivalent; focus moved on open/close/error/success; escape/enter behaviour), `screen_reader` (roles and labels for each control, live region for async results, announcement text for each state change), `responsive` (per breakpoint of the existing system: layout change, hidden/collapsed items, minimum target 44x44 CSS px or the platform minimum). Motion: respects reduced-motion. Contrast: text pairs meet the baseline in `DESIGN.md` (state ratio when a new colour pair appears).

## 5. Validation rules

The validator enforces: `schema_version` 1; `mode` `task|reverse`; `design_system.file` non-empty and, with `--root`, existing when `exists: true`; `reused[]` entries have kind, name, and existing path (with `--root`); `new[]` entries have kind, name, `reason`, `reuse_rejected`, and a name not equal to any reused name; mode task has at least one screen; screen ids unique; each screen has all six states, each with (`copy` and `behavior` non-empty, no placeholder text) or `not_applicable`; `keyboard`, `screen_reader`, `responsive` non-empty arrays of non-empty strings; flows reference known screens; `ui_languages` non-empty. With `--design-md`: the six required headings exist and have content, no placeholder text, and every backticked repo-looking path exists under `--root`.
