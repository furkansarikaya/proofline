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
  A response that is not HTML (`robots.txt`, JSON) is `not_measured`, never measured. Content a `setup`
  script injects (an iframe, a note) must be registered with `mark(el)`, a function the setup receives as its
  argument (it is not a page global; a `data-vp-probe` attribute written by the page counts for nothing): a marked
  element is hidden while measuring and has no Tab stop. The setup runs as `eval` text inside that function, so
  `var` and function declarations stay local (assign to `window.x` for a global). Limit: the setup runs in the
  page's own JS world, so page code that intercepts the setup could still obtain `mark`; the gate guards
  against accident and convenience, not a page built to evade it. Overflow inside a closed `<details>`, `[hidden]` or `[inert]` is ignored while the page has no
  horizontal scroll.
- `interactions`: `check` is `form_validation`, `modal_interaction`, `dropdown_interaction` or `long_content`;
  steps `click`, `fill` (`text`, or `repeat` + `times` for long content), `press` (`Tab`, `Enter`, `Escape`,
  `ArrowDown`, `ArrowUp`, `" "`); expectations `visible`, `hidden`, `focus_within`, `no_horizontal_scroll`,
  `text_contains: [selector, text]`; optional `viewports` (default all). Value = failed expectations, `== 0`.
- `seo` (optional, A158): `{ "public_html": true|false, "pages": ["index.html", "de/index.html"], "site_url": "https://example.org", "analytics": { "hosts": ["stats.example.net"], "globals": ["myTracker"] } }`.
  Absent: the group is not requested. `public_html: false`: the project produces no public HTML pages; the group does not run
  ([Technical SEO](#technical-seo)). `pages`: paths under `base_url` (default: the `path` of every screen). `site_url`: the deployed
  address the canonical links use (default: the origin the pages' canonical links or the sitemap name). `analytics` (optional): `hosts` (a substring of a script or request URL) and `globals` (`window` names) of the project's own analytics service, added to the built-in generic list.
- `design` (optional, 0.0.27, A170): `{ "visitor_mode": "persuade|operate|read|experience", "screens": ["index.html"], "languages": [{ "path": "tr/index.html", "lang": "tr", "allow_text": ["brand name"] }], "image_ledger": "docs/design/IMAGES.md", "scenes": [{ "id": "story", "path": "index.html", "selector": "#story", "viewports": ["desktop", "phone"] }], "motion_min": { "load": 3, "scroll": 3 } }`.
  Absent: the group is not requested ([Design audit](#design-audit)). `visitor_mode` is required. `screens`: paths or screen ids (default: every screen path). `languages`: pages of another language
  (`allow_text`: strings that stay English). `image_ledger`: a path relative to the repo root (`--repo`, default the working directory); absent: the ledger check is not requested.
- `criteria`: per criterion the checks that prove it (optionally `screens`, `states`); `required: true` for
  each id on the PLAN `visual_proof:` line. A measured item is tagged with every criterion whose checks,
  screens and states match.

## Checks

Every cell (screen x state x viewport) accounts for each core check: a measured item, or a cell-level
`not_measured` entry with the reason. The thresholds below are the documented ones: a report may use a
stricter value (a larger `touch_target_min`), never a weaker one, and `touch_target_min` below 24 is refused.
`not_applicable` is written only when the page has nothing of that kind (`no focusable element` for
`hidden_interactive`, `focus_order` and `focus_visible` together, `no visible interactive element`,
`no visible text`, `no non-exempt target`); every other gap is a `not_measured` entry. A failing check yields one item per offending element; a passing
check yields one item carrying the worst value found (so the pass is itself a measurement).

| Check | Measures | Value / threshold |
|---|---|---|
| `horizontal_scroll` | document `scrollWidth` against the viewport `clientWidth` (recorded as `client_width`: at most the viewport width, or 980 on a phone viewport whose page has no viewport meta tag) | `<= <clientWidth>` |
| `viewport_overflow` | outermost visible element extending past the left or right edge; elements inside a scroll or clip container other than `html`/`body` are exempt (an intended carousel), clipping by `body` is not (content cut off) | px beyond the edge, `<= 0` |
| `hidden_interactive` | a tab-reachable element that stays invisible when focused (zero size, clipped, transparent, off-page); a visually hidden element that appears on focus (a skip link) passes | visible px^2 when focused, `> 1` |
| `overlapping_interactive` | the element's centre, after scrolling it into view, hits another element | `1` covered, `== 0` |
| `contrast` | text colour against the composited ancestor background colours (WCAG 2.2 relative luminance, floored to 2 decimals); large text = 24px, or 18.66px bold | ratio, `>= 4.5`, or `>= 3` for large text; every contrast item carries `font_size_px` and `font_weight`, and the validator recomputes large text from them |
| `touch_target` | width and height of visible interactive elements, inline text links exempt; at the 24px minimum the WCAG 2.5.8 spacing exception is applied (a 24px circle on the target meets no other target) | smaller side px, `>= <touch_target_min>` |
| `state_rendered` | the state's `ready` selector visible within 5 s of load | `1`/`0`, `== 1` |
| `focus_order` | real Tab presses from the top: every tabbable element is reached; no positive `tabindex` | `1` per offender, `== 0` |
| `focus_visible` | pixels around each Tab stop (first 40) differ between focused and unfocused screenshots | `1` changed, `== 1` |
| `form_validation`, `modal_interaction`, `dropdown_interaction`, `long_content` | the configured steps and expectations | failed expectations, `== 0` |
| `a11y_scanner` | the project's installed scanner (`axe-core`), one item per rule violated | affected nodes, `== 0` |

## Technical SEO

Group `seo` (A158), outside the cells: measured once per page (first viewport, no interaction, so before any consent) and once per
site, written to `report.seo`. It runs only when the project produces public HTML pages and the page is not blocked by robots.

- No public HTML pages (library, CLI, API, backend only; config `seo.public_html: false`, or every page is a non-HTML response):
  `seo` is `{ "status": "not_applicable", "note": "seo not applicable: no public HTML pages" }`, the one fixed note the validator accepts. No item, no finding.
- A page that a `<meta name="robots">` noindex or an `X-Robots-Tag` noindex blocks is listed in `seo.pages`
  as `not_applicable` with reason `robots` and gets no item; it is not a published page for the site checks. A page that `robots.txt` blocks for EVERY tested bot is skipped the
  same way (`not_applicable`, reason `robots`, the detail names the bots). A page blocked for only some bots stays measured and
  `seo_robots` names the bot; a sitemap page blocked for a bot still fails `seo_robots` (A160).
- Each item has `id` `S-n`, `check`, `page` (the page path, or `site`), `selector`, `value` (the number of problems found), `threshold` `== 0`,
  `status` `pass`, `fail` or `not_measured`, `evidence` (the observed values; no screenshot) and, for a failure, a `note` naming each problem.
  A failure is a blocking row; `not_measured` (a fact that cannot be resolved or read) carries a `reason` and is an info row, never blocking.
  Items are not tied to criteria.

| Check | Page | Problem counted |
|---|---|---|
| `seo_title` | each | not exactly one non-empty `<title>` |
| `seo_description` | each | not exactly one non-empty `meta[name=description]` |
| `seo_canonical` | each | not exactly one `link[rel=canonical]`, or one that names neither the page itself nor an existing page of the site |
| `seo_hreflang` | only a page with `link[rel=alternate][hreflang]` | an invalid language tag, no self reference, no `x-default`, a target that does not exist or does not list the page back |
| `seo_h1` | each | not exactly one `<h1>` |
| `seo_open_graph` | each | `og:title` or `og:image` missing or empty, or an image that does not exist in the site |
| `seo_structured_data` | each | an `application/ld+json` block that is not valid JSON (no block is fine) |
| `seo_sitemap` | `site` | a published page not listed in `sitemap.xml`, or a listed page that does not exist |
| `seo_robots` | `site` | no `Sitemap:` line in `robots.txt`, or a published page or sitemap page that `robots.txt` disallows for Googlebot or Bingbot (the failure names the bot) |
| `seo_analytics_consent` | only a page with a measured analytics request before consent | a third-party request made before consent that belongs to an analytics candidate (its URL matches the generic words or `seo.analytics.hosts`, or its initiator does; the site's own deployed origin `seo.site_url` is first party, and a document URL is never an initiator) |

- Analytics (A160): "loaded" is behaviour, not a name. The page is loaded once, with no interaction (before any consent), and every
  request it makes is recorded (`{ url, third_party, phase: "before_consent", initiator }`; the guard that pauses requests marks the ones
  outside the page's own origin as third party, and a blocked third-party request is an attempted request). A candidate is a host or path
  word (`analytics`, `tracker`, `tracking`, `telemetry`, `metrics`, `stats`, `beacon`, `pixel`, `tag-manager`) in a script URL, a request
  URL or a `src` of the page source as served, the global `dataLayer`, or a host of the user list `seo.analytics` in `visual.json`; the
  report names the matched generic label, never a vendor. A candidate found only by name is listed in `analytics_detected` and shown as an
  info row, never blocking. `seo_analytics_consent` exists, and fails, only for a third-party request before consent that belongs to a
  candidate (its URL matches, or the URL of its initiator does); such URLs are in the page's `analytics_before_consent`. Any other
  third-party request is information (`third_party_requests`). A page that only defines `dataLayer`, a placeholder such as
  `<script type="text/plain" data-consent src=...>`, and a file such as `pixel-art.js` served from the page's own origin load nothing.
  The user may waive a failure that is a false positive; it is never an edit to hide.
- robots.txt (A160, RFC 9309): for each tested bot (`googlebot`, `bingbot`) the groups whose user-agent token equals the bot's token
  (case-insensitive) apply, several groups of that token combined; only when none matches does the `*` group apply. Consecutive
  `User-agent` lines share a group. Inside the applicable rules the longest matching path wins, `Allow` wins a tie, `*` and `$` are
  wildcards and an empty `Disallow` allows everything. `Sitemap:` lines are global. Every published page and every sitemap page is tested;
  a page blocked for a bot is one `seo_robots` problem naming the bot. Paths are compared in the percent-encoding normal form of RFC 9309
  (2.2.2): both the rule path and the page path are written as the UTF-8 octets of every non-ASCII or non-URI character in upper-case hex,
  a percent-encoded unreserved character (`%7E`, `%41`) is decoded, and a reserved character stays as written; so `Disallow: /caf%C3%A9/`
  blocks `café/index.html` and `/a%20b` blocks `a b`. A page file `dir/index.html` is tested under the URL form it is published under:
  the form its sitemap `<loc>` uses, else its canonical, else both (`/dir/` and `/dir/index.html`), and then it counts as blocked only
  when both forms are blocked, because a crawler can still reach it by the other. `Disallow: /dir/index.html` therefore does not fail a
  page published as `/dir/`. A bot token that is only a prefix of a group token
  (for example `googlebot-news`) is a different token and does not match.
- Canonical, hreflang, Open Graph and sitemap addresses are mapped to files under `base_url` by their path (the deployed origin is ignored);
  an address on another site is `not_measured`. A missing `sitemap.xml` or `robots.txt`, and a sitemap index, are `not_measured` (an info row, never blocking). This is a
  design decision (A161), not a gap: RFC 9309 defines a missing `robots.txt` as "everything may be crawled", so its absence is a valid
  state and not a defect; a sitemap is optional; and with a `file:` or localhost base the files of the deployed site cannot be proven
  absent (the folder measured is not the host), so a blocking finding would have no evidence. The report text for both says exactly that.
- Out of scope, never measured, judged or reported: content SEO (keywords, text quality, readability, length).
- Limits: an initiator is known only when the browser reports it (measured in Chrome: `fetch`, `sendBeacon` and a dynamically added
  `<script>` report the script that made them; an `<img>` load, such as `new Image().src = ...`, is reported with the document or nothing,
  so a pixel is attributed by its own URL only); a third-party request that matches no candidate is information
  even when it is a tracker the project never named (add its host to `seo.analytics.hosts`); only Googlebot and Bingbot are tested;
  reciprocity of a target outside the measured pages is read
  from its served HTML.

## Design audit

Group `design` (A170), outside the cells: measured per page at its own three viewports, **1440 (`wide`), 768 (`tablet`) and 390 (`phone390`)**
wide (independent of the class viewports), written to `report.design`. Before measuring, the page is scrolled once top to bottom (lazy and
scroll-revealed content exists) and photographed at each viewport; the hashed screenshots are listed in `design.screenshots` and attached to every
static item. `measure.mjs --print-design-probe` prints the in-page probe for a tool that drives the browser itself (`--assemble`, `raw.design`).

- Items: `id` `D-n`, `check`, `screen`, `viewport`, `selector`, `value`, `threshold`, `status` `pass|fail|not_applicable|not_measured`, `note` (a failure
  says what is wrong), `reason` (not_measured), `screenshot {path, sha256}`. A failing item is a blocking row; `not_measured` is an info row, never silent:
  every page accounts for each check below, as an item or a `design.not_measured[]` entry with a reason. `not_applicable` carries a fixed note
  (a mode that does not require the check, or an English page for `design_untranslated`). A report may use a stricter threshold, never a weaker one: every pass or fail item has a numeric `value` and a numeric `threshold` (`== 0`, `>= 3`, `45-75`) that the validator evaluates (motion count: `phase` load|scroll, `>=` at least `motion_min`; scene items: `scene`, `motion`, `>= 1` started or `== 0` hidden). A requested design check that is `not_measured` (item, `design.not_measured[]` or a page) makes the result INCONCLUSIVE, never PASS; the exceptions are a page with nothing of that kind to measure (no heading, no two-line paragraph, no surface) and a non-HTML page.
- `design.status` is `not_applicable` (fixed note `design not applicable: no HTML pages`) when every page is a non-HTML response. Pages: `design.pages[]`
  `{screen, path, static, language?, status measured|not_measured, reason?}`. A language-only page gets `design_untranslated` at `wide` only.

| Check | Measures | Value / threshold | Modes, viewports |
|---|---|---|---|
| `design_heading_lines` | rendered line count of every visible h1/h2 | worst count, `<= 2` | all; 3 viewports |
| `design_type_scale` | largest heading font size / body font size (sizes listed in `note`) | ratio, `>= 3` (persuade, experience), `>= 2` (read, operate) | all; 3 |
| `design_body_measure` | median characters per line of body paragraphs of 2 or more lines | `45-75`; on `phone390` `30-75` (a 390 px column cannot hold 45 characters at a readable size) | persuade, experience, read; 3 |
| `design_fonts_loaded` | the first family of every visible text element is loaded (`document.fonts`), installed, or generic; persuade and experience also need a loaded web font for the heading or body | problems, `== 0` | all (web-font rule: persuade, experience); `wide` |
| `design_edge_margins` | left and right outer margin of the main content (full-bleed elements ignored) | difference px, `<= 8` | all; 3 |
| `design_edge_text` | smallest distance of any visible text to the left or right viewport edge | px, `>= 12` | all; 3 |
| `design_vacuum` | largest empty vertical gap between consecutive visible content blocks | gap / viewport height, `<= 0.5` | all; 3 |
| `design_untitled_section` | `section`, `[role=region]` and `aside` taller than 200 px with no heading and no accessible name | count, `== 0` | all; 3 |
| `design_empty_hero` | the first viewport holds an h1, a primary action (outside `nav`) and a visual (img, svg, canvas, video, picture of at least 80 px, or a colour or image field covering 25% of the viewport) | missing parts, `== 0` | persuade, experience; 3 |
| `design_surfaces` | one item per surface present: `::selection` themed, scrollbar themed (`scrollbar-color` or `::-webkit-scrollbar`), `caret-color` of text fields, `text-underline-offset` of underlined links, tabular numerals in numeric table cells | unthemed count, `== 0` | all; `wide` |
| `design_ascii_turkish` (information, A172) | not a check and not in `expectedChecks`: on a `languages[]` page whose `lang` is Turkish, the visible text blocks are searched for words of `visual.ascii_turkish_words` (default list in `design-audit.mjs`, extended in `.agents/config.yaml`) minus `visual.ascii_turkish_allow`; hits go to `design.language_notes[]` `{screen, path, lang, kind: "ascii_turkish", words: [{word, count, selector}]}` and the validator prints one `info` row; it never changes the result | words, count | per `languages[]` entry; `wide` |
| `design_untranslated` | visible text blocks of 4 or more words, mostly English function words, on a page whose language is not English, minus `allow_text`, `code`, `pre` | blocks, `== 0` | per `languages[]` entry; `wide` |
| `design_motion_count`, `design_reduced_motion`, `design_no_script_visible`, `design_scene` | motion-audit.mjs: animated elements while loading and scrolling (`motion_min`), content visible and no animation under `prefers-reduced-motion: reduce`, text visible with script disabled, pinned or scroll-linked scenes photographed at 0, 50, 100 % (`scenes[]`, `design.scenes[]`) | per item | motion count: persuade, experience |
| `design_ux_alt_text` | visible `img` without an `alt` attribute (empty `alt` and `role=presentation` are decorative and pass) | count, `== 0` | all; 3 |
| `design_ux_form_labels` | visible form fields with no `label` (for or wrapping), `aria-label`, `aria-labelledby` or `title`; a placeholder is not a label | count, `== 0` | all; 3 |
| `design_ux_control_names` | visible buttons, links, summaries and image inputs with no text, `aria-label`, `aria-labelledby`, `title` or named image inside | count, `== 0` | all; 3 |
| `design_ux_viewport_meta` | `meta[name=viewport]` present with `width=device-width`, and no `user-scalable=no` or `maximum-scale` below 2 | problems, `== 0` | all; `wide` |
| `design_ux_body_font_size` | median font size of body paragraphs on a 390 px page | px, `>= 16` | all; `phone390` |
| `design_image_ledger` | every raster image and self-hosted font has a ledger row with licence and credit (ledger.mjs) | missing, `== 0` | when `image_ledger` is set |

The `design_ux_*` rows are the measurable high-severity UX rules; `ux-rules.json` maps every UX rule to a check here (touch target, contrast, focus visibility, focus order, reduced motion and horizontal scroll reuse the core or motion checks) or to `judged`. `design_contrast` is not a separate check: the core contrast check stays. Judged: `critique[]` (COMPLEX/CRITICAL when the design group runs; see JUDGED.md) never closes
the gate. `lint.json` beside `report.json` (lint-source.mjs): its blocking findings are FAIL reasons.

Limits: the first family of an element decides the font check (a later fallback is not inspected); `::selection` and scrollbar theming are read from same-origin style
sheets; a hero visual that is a CSS background on a small element is not counted; the vacuum check ignores `position: fixed` elements and elements taller than 1.5 viewports.

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
