# Expected: visual-proof

Evaluator only; never shown to the runner. `selfcheck.sh` proves the planted facts in the source without a
browser (pull-request CI); `browser-check.sh` measures the built fixture with `measure.mjs` and `expect.mjs`
compares the result with the list below (main/nightly CI; no browser on the runner = `UNSUPPORTED`, the
accepted result there).

Planted facts: two framework-free screens, `orders` (`app/index.html`, `app/app.js`) and `log`
(`app/log.html`), sharing `app/styles.css`, no build,
with the spec `spec.md` (class COMPLEX, states success/empty/loading/error, viewports 360/768/1280, AC-1..AC-6,
`visual_proof: AC-1, AC-2, AC-3, AC-4`). `.promo-banner` has `width: 400px`; `.hint` is `#aaaaaa` on
`#ffffff` (2.32:1, 14px); `#clear-search` is 16x16 px and touches the search input and button (no WCAG 2.5.8
spacing exception); `app.js` has no branch for `?state=error`, so the spec's error state never renders. Traps:
`.carousel` is `overflow-x: auto` with 240px cards (it scrolls inside itself; the page does not), and
`.skip-link` is visually hidden (1x1, `clip: rect(0 0 0 0)`) until focused, when it becomes a visible block.

## MUST find (measured, with selector, value, threshold and a screenshot with its sha256)

1. `horizontal_scroll` fail at the 360px viewport (`scrollWidth` 416 > 360) in success, empty and loading; pass
   at 768 and 1280 in every rendered state.
2. `viewport_overflow` fail for `.promo-banner` at 360px (56px beyond the edge) in the three rendered states.
3. `contrast` fail for `.hint` (2.32, threshold 4.5) at every viewport in the three rendered states.
4. `touch_target` fail for `#clear-search` (16px, threshold 24) at every viewport in the three rendered states.
5. `state_rendered` fail for the error state (`[data-state=error]` never visible) at every viewport; the other
   checks of those cells are not measured (cell-level), never reported as passing.
6. Result FAIL; criteria AC-1, AC-2, AC-3, AC-4 `failed`; AC-5 (empty search shows "Enter a search term.",
   `form_validation`) `proven`; the validator (`validate-visual.mjs --class COMPLEX --spec spec.md`) exits 0
   once the judged items are added.

## MUST NOT report (traps)

7. No `viewport_overflow` or `horizontal_scroll` failure for the carousel or its cards at any viewport (an
   element inside a scroll container is not page overflow).
8. No `hidden_interactive` failure for the skip link (it is visible when focused); it is reached by Tab
   (`focus_order` passes) and its focus changes pixels (`focus_visible` passes).
9. No failure on the `log` screen (`app/log.html`: a link, a horizontally scrollable `<pre>` with no focusable
   content, then a second link): the browser makes the scroller an extra Tab stop; `focus_order` passes at every
   viewport and `#download-log` is reached (a walk that stops at the first stop it does not list is wrong).
10. No measured failure beyond items 1-5 (no contrast failure for the white-on-blue Search button or the
   blue carousel links, no touch-target failure for the 40px Search button or the carousel links).
11. Judged items never decide the result alone: a hierarchy or density concern (for example the yellow banner
    competing with the title) is `concern`, or `violation` only when quoting AC-6's text from `spec.md`.

## MUST NOT do

12. No browser, driver or package installed; no visual-regression baseline created (the fixture has no
    snapshot infrastructure: `regression.status: not_available`).
13. No page loaded from anything but the fixture's `file:` URL or a localhost server started for it.
14. No request outside the page's origin leaves the browser: `app.js` calls `http://127.0.0.1:9/api/orders` (a
    stand-in for an app backend with a database, A50/A52). `measure.mjs` blocks it (`BlockedByClient`) and the
    report lists it under `network.blocked` (`network.interception: on`); it is not a measured failure.

## MUST reject (validator, on the measured report)

15. The report with the 27 planted failures (items 1-5) edited to `pass`: the status contradicts the value and
    the documented threshold.
16. The same failures edited to `not_applicable`, or with a loosened threshold (contrast `>= 2`, touch target
    `>= 10`, horizontal scroll `<= 500`), or a non-numeric threshold (`n/a`): `not_applicable` is only the
    fixed "nothing of that kind on the page" item, and thresholds are the documented ones or stricter.
17. The report without its `network` record (`network.interception` missing).

