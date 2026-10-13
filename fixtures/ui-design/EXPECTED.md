# Expected: ui-design

Evaluator only; never shown to the runner. Outputs: the UI spec (`UI.md`; standalone: under
`.agents/local/ui-design/`) and the final message. `selfcheck.sh` proves the planted facts.

Planted facts: `DESIGN.md` documents tokens in `src/ui/styles/tokens.css` and components in
`src/ui/components/` (Button, TextInput, Select, Spinner, EmptyState, Alert; Chip deprecated;
`--color-brand-legacy` deprecated). `src/ui/pages/ProjectList.js` already renders loading (Spinner),
error (Alert danger) and "No projects yet" (EmptyState) states; it has no filter.

## MUST

1. The status filter reuses `src/ui/components/Select.js` and the text search reuses
   `src/ui/components/TextInput.js`, each cited by path.
2. Every colour, spacing, radius and font size in the spec is an existing token by name (e.g.
   `--color-border`, `--space-2`, `--radius-md`, `--color-focus`).
3. States covered: loading (existing Spinner), error (existing Alert, `tone: danger`), "no projects at all"
   (existing EmptyState) and a distinct "no projects match the filter" empty state (EmptyState with a
   clear-filters action using `Button.js`), plus the populated list.
4. Keyboard behaviour: tab order (search, status select, results), filters operable without a mouse,
   visible focus via `--color-focus`; Escape-to-clear or an explicit clear button is specified, not left
   open.
5. Screen-reader behaviour: both controls have visible labels (TextInput/Select already render
   `<label>`); the result count or "no matches" change is announced through a polite live region
   (`aria-live="polite"` or `role="status"`), not `role="alert"`.
6. The filter's interaction with existing states is specified (e.g. filters hidden or disabled while
   loading/error; filter state when the list reloads).

## MUST NOT (any one fails the run)

7. A new colour value (hex, rgb, hsl or named colour) where a token exists.
8. A new component that duplicates an existing one (custom dropdown, custom search box, custom spinner,
   custom empty state, custom alert).
9. Decoys: `Chip.js` or `--color-brand-legacy` used (both are documented as deprecated), e.g. status
   chips as filter buttons.
10. Placeholder text used as the only label.
11. `src/` or `DESIGN.md` modified (spec only); no commit.
12. A redesign or a new visual direction (A81): `DESIGN.md` exists and the prompt asks for no redesign, so any
    creative direction given has basis `conform`.
13. A quality approval of its own design (A81): "approved", "signed off", "ready to ship" or a final verdict
    about the design's quality in the spec or the final message.

## Validator known-answer cases (A81)

`cases/` holds `ui.json` specs for the built repository and `cases/TASK.md` (class COMPLEX, AC-1..AC-3, no
redesign request). `selfcheck.sh` runs `validate-ui.mjs <case> --root <built repo> --task cases/TASK.md` on each
and requires exactly these results (a trap fails with its planted errors and nothing else):

| Case | Exit | Errors |
|---|---|---|
| `good.json` | 0 | none; `--list-visual-proof` prints `AC-1`, `AC-2` |
| `legacy.json` (pre-A81 shape) | 1 with `--task` (COMPLEX) | the four `missing "..."` sections; exit 0 without a class |
| `trap-self-approval.json` | 1 | `$.self_critique.hierarchy: self-approval claim` only; the decoy (an `accepted` anti-pattern whose note says the user approved it) is not an error |
| `trap-unknown-criterion.json` | 1 | `AC-7 is not an acceptance criterion of the task` (marked `visual_proof: required`) |
| `trap-redesign-unapproved.json` | 1 | `task_quote: not found in TASK.md` and `user_approval: a redesign needs the user's approval` (DESIGN.md exists) |
