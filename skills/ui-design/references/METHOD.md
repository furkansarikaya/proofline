# ui-design method

## 1. Reverse-engineer DESIGN.md

Evidence sources, in order; cite each token/component with its path (and line or symbol):
1. Token definitions: CSS custom properties, theme files, Tailwind config, design-token JSON, SCSS/LESS variables, platform theme files (Android `themes.xml`, iOS asset catalogs, Flutter `ThemeData`), whatever the stack uses. Find with `grep` for `--`, `theme`, `tokens`, colour literals repeated across files.
2. Typography: font families, sizes, weights, line heights actually used, grouped into a scale; outliers noted.
3. Spacing and layout: the spacing scale, radii, elevation/shadows, grid/breakpoints.
4. Colour roles: map raw values to roles (surface, text, primary, danger, border, focus); report values used outside the tokens as drift.
5. Components: shared component directory; per component its path, props/variants, states it handles (hover, focus, disabled, loading, error).
6. Accessibility baseline: what the code already does (focus styles, aria usage, contrast of the main role pairs measured from the values, reduced-motion handling, minimum target size) and what is absent. State measured contrast ratios, never "looks fine".

Rules: `DESIGN.md` holds only the system (tokens, typography, spacing, colour roles, components, accessibility); page-specific decisions (a page's hero content, a specific diagram) belong in the task's UI spec. Describe what exists, no aspirational tokens. A role with no token is recorded under "Gaps". Section headings required by the validator: Tokens, Typography, Spacing, Colour roles, Components, Accessibility. Paths in backticks must exist.

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

A81 additions (optional keys, validated whenever present; all four mandatory in mode task when the class is COMPLEX or CRITICAL, taken from `--class` or the `## Suggested class` of `--task <TASK.md>`; without a class they stay optional, so a spec written before A81 still validates). `--class` without `--task` is a usage error (exit 2): a class implies a task. In a run the designer always validates with both, `--task .agents/runs/<ID>/TASK.md --class <run class>`, before submitting; the PLAN `## UI` text it returns is frozen from that validated spec.
- `design_system`: with `--root`, `exists: false` while `file` exists there is rejected (a spec cannot skip conformance by claiming there is no `DESIGN.md`).
- Mode `reverse` only describes the existing system: the four A81 keys and a non-empty `screens` are rejected there.
- `creative_direction`: `basis` `conform|redesign|new` plus non-empty `visual_character`, `typography`, `layout`, `hierarchy`, `rationale`. `new` is rejected when `design_system.exists` is true and needs a non-empty `avoided`. `new` and `redesign` need `alternatives` (2-3 items, each `name`, `summary`, `trade_off`; names unique) and `chosen` (one alternative's name); `conform` rejects both. A `redesign` with `design_system.exists` false (UI code, no `DESIGN.md`) needs a non-empty `redesign.inventory` and `avoided`, and its `user_approval` is optional (the user's request is the approval; validated when present). `redesign` needs:
  - `redesign.task_quote`: with `--task`, found verbatim in TASK.md (whitespace and case ignored), and asking for a visual change (redesign, restyle, re-theme, new look, visual overhaul, rework the look, ...; a word-list heuristic);
  - `redesign.user_approval`: a reference to a recorded answer, one of `questions/<NNN>.answer.md` (the run's answer file, `answered_by: user`), `Q<n>` with round wording ("Q2 of the NEEDS_INPUT round", "Q-2 answered by the user": the question number of the designer's NEEDS_INPUT round, standalone or in a run; a bare `Q4`, a quarter label or a meeting is not a reference) or `INTENT.md#<decision>` (an intent-grill decision the user made); it may not name the designer, a first-person approval ("I approve"), an assumption or an implication.
- `ux_patterns`: non-empty; each with `decision`, at least two distinct `options`, `chosen` one of them, `density`, `flow`, `rationale`.
- `self_critique`: `hierarchy`, `density`, `consistency`, `legibility` and a non-empty `anti_patterns` list (`check`, `result` `clear|fixed|accepted`, a `note` for fixed and accepted).
- Self-approval: verdict or first-person approval phrasing ("this design is approved", "signed off", "LGTM", "ready to ship", "production ready", "no issues remain", "meets all criteria", "I approve") in any free-text field of the four keys (direction, pattern density/flow/rationale, critique passes, checks and notes, criteria evidence) fails, and so does any top-level key naming an approval, sign-off or verdict. Domain words ("approval button", "not approved items") and "the user approved it in Q3" are not claims.
- `criteria`: non-empty; unique `id` `AC-<n>` (with `--task`, an acceptance criterion of the task), `screens` known screen ids, `visual_proof` `required|not_required`, `evidence` non-empty when required.

## 6. Criteria and visual proof

The designer marks every UI-facing acceptance criterion: `visual_proof: required` when the criterion can only be shown with visual evidence (layout, visibility, overflow, contrast, a rendered state), otherwise `not_required`. `evidence` names the screens, states and viewports and what the screenshot or measurement must show; it is a target for QA, not proof.

Interface for the proof skills (stable; consumers read it, they never import this script):
- **Run-frozen source:** the PLAN `## UI` text carries exactly one line `visual_proof: AC-1, AC-3` (comma-separated ids) or `visual_proof: none`. plan-contract's validator checks the ids against TASK.md and requires the line for COMPLEX/CRITICAL plans with a `## UI` section. verify-proof and visual-proof read this line from the frozen PLAN.md.
- **Design artifact:** `design/ui.json` `criteria[]` (per criterion: screens, evidence target). `node <skill-dir>/scripts/validate-ui.mjs design/ui.json --task TASK.md --list-visual-proof` validates and prints `{"schema":"ui-design.visual-proof/1","required":["AC-1","AC-3"]}` (exit 1 with errors when invalid). The ids are checked against the task only with `--task`; without it the list is the spec's own claim, so consumers pass `--task`. The PLAN line and this list must name the same ids.
- **Meaning for the gates:** a criterion marked required whose visual evidence is missing is unproven (A82 consumes this; nothing here changes verify-proof).
