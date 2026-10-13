# Measured checks

## Config

`visual.json` (written by QA from the spec and the frozen plan; `measure.mjs` refuses an invalid one):

```json
{
  "schema": "visual-proof.config/1",
  "class": "COMPLEX",
  "base_url": "file:///abs/path/app/  |  http://127.0.0.1:5173/",
  "viewports": [{ "name": "phone", "width": 360, "height": 740 }, { "name": "tablet", "width": 768, "height": 1024 }, { "name": "desktop", "width": 1280, "height": 800 }],
  "touch_target_min": 24,
  "screens": [{ "id": "orders", "path": "index.html", "states": [
    { "name": "success", "path": "index.html", "ready": "[data-state=success]" },
    { "name": "error", "path": "index.html?state=error", "ready": "[data-state=error]", "setup": "optional page script run before waiting" }
  ] }],
  "interactions": [{ "name": "empty-search", "check": "form_validation", "screen": "orders", "state": "success",
    "steps": [{ "fill": "#q", "text": "" }, { "click": "#search-btn" }],
    "expect": [{ "visible": "#search-error" }, { "text_contains": ["#search-error", "Enter a search term."] }] }],
  "criteria": [{ "id": "AC-1", "required": true, "checks": ["horizontal_scroll", "viewport_overflow"] }]
}
```

- `path` (screen and state): resolved against `base_url`; a `file:` page must stay under the `base_url`
  folder and an http(s) page on the `base_url` localhost origin (`measure.mjs` refuses anything else).
- `states`: one entry per spec state that applies, the default state first (STANDARD measures only it, plus
  states a criterion names in `criteria[].states`). `ready` is a selector visible only in that state; a
  state without one cannot be proven. A state the app reaches only through data (an API error) needs a
  `setup` script or a project fixture route that produces it; none available -> the cell is `not_measured`.
- `interactions`: `check` is `form_validation`, `modal_interaction`, `dropdown_interaction` or `long_content`;
  steps `click`, `fill` (`text`, or `repeat` + `times` for long content), `press` (`Tab`, `Enter`, `Escape`,
  `ArrowDown`, `ArrowUp`, `" "`); expectations `visible`, `hidden`, `focus_within`, `no_horizontal_scroll`,
  `text_contains: [selector, text]`; optional `viewports` (default all). Value = failed expectations, `== 0`.
- `criteria`: per criterion the checks that prove it (optionally `screens`, `states`); `required: true` for
  each id on the PLAN `visual_proof:` line. A measured item is tagged with every criterion whose checks,
  screens and states match.

## Checks

Every cell (screen x state x viewport) accounts for each core check: a measured item, or a cell-level
`not_measured` entry with the reason. A failing check yields one item per offending element; a passing
check yields one item carrying the worst value found (so the pass is itself a measurement).

| Check | Measures | Value / threshold |
|---|---|---|
| `horizontal_scroll` | document `scrollWidth` against the viewport `clientWidth` | `<= <clientWidth>` |
| `viewport_overflow` | outermost visible element extending past the left or right edge; elements inside a scroll or clip container other than `html`/`body` are exempt (an intended carousel), clipping by `body` is not (content cut off) | px beyond the edge, `<= 0` |
| `hidden_interactive` | a tab-reachable element that stays invisible when focused (zero size, clipped, transparent, off-page); a visually hidden element that appears on focus (a skip link) passes | visible px^2 when focused, `> 1` |
| `overlapping_interactive` | the element's centre, after scrolling it into view, hits another element | `1` covered, `== 0` |
| `contrast` | text colour against the composited ancestor background colours (WCAG 2.2 relative luminance, floored to 2 decimals); large text = 24px, or 18.66px bold | ratio, `>= 4.5` or `>= 3` |
| `touch_target` | width and height of visible interactive elements, inline text links exempt; at the 24px minimum the WCAG 2.5.8 spacing exception is applied (a 24px circle on the target meets no other target) | smaller side px, `>= <touch_target_min>` |
| `state_rendered` | the state's `ready` selector visible within 5 s of load | `1`/`0`, `== 1` |
| `focus_order` | real Tab presses from the top: every tabbable element is reached; no positive `tabindex` | `1` per offender, `== 0` |
| `focus_visible` | pixels around each Tab stop (first 40) differ between focused and unfocused screenshots | `1` changed, `== 1` |
| `form_validation`, `modal_interaction`, `dropdown_interaction`, `long_content` | the configured steps and expectations | failed expectations, `== 0` |
| `a11y_scanner` | the project's installed scanner (`axe-core`), one item per rule violated | affected nodes, `== 0` |

## Limits (record the ones that apply in REPORT.md)

- Contrast reads background colours only: text over a background image, a gradient, a non-ancestor
  positioned element or an unparsed colour (`color()`, `oklch()`) is an element-level `not_measured` entry;
  ancestor `opacity` is not composited. Placeholder and form-field value text are not measured.
- `focus_visible` counts any pixel change (a caret, a hover style that happens to apply); `focus_order`
  proves reachability and the absence of positive `tabindex`, not that the order matches the visual
  reading order (that is judged).
- Overlap is checked at the element's centre only; elements clipped by a scroll container are listed as
  element-level `not_measured`.
- Only same-document content is measured (no iframes, no shadow roots).
