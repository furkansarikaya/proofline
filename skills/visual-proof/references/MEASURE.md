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
  a page blocked for a bot is one `seo_robots` problem naming the bot. A bot token that is only a prefix of a group token
  (for example `googlebot-news`) is a different token and does not match.
- Canonical, hreflang, Open Graph and sitemap addresses are mapped to files under `base_url` by their path (the deployed origin is ignored);
  an address on another site is `not_measured`. A missing `sitemap.xml` or `robots.txt`, and a sitemap index, are `not_measured`.
- Out of scope, never measured, judged or reported: content SEO (keywords, text quality, readability, length).
- Limits: an initiator is known only when the browser reports it; a third-party request that matches no candidate is information
  even when it is a tracker the project never named (add its host to `seo.analytics.hosts`); only Googlebot and Bingbot are tested;
  reciprocity of a target outside the measured pages is read
  from its served HTML.

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
