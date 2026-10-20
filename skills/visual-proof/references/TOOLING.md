# Tooling: detect, never install

`node <skill-dir>/scripts/measure.mjs --detect --repo <repo>` prints one JSON object:

| `kind` | Meaning | Next |
|---|---|---|
| `headless-browser` | a Chromium-family binary (`chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `chrome`, `microsoft-edge`, `msedge`, `brave-browser`) on `PATH`, or in the standard macOS application folders; `--browser <path>` names one explicitly | `measure.mjs --config` drives it over the DevTools protocol (Node >= 22: child process plus the global `WebSocket`; no package) |
| `project-tool` | no browser binary, but `package.json` declares and `node_modules` holds a browser-test tool (`@playwright/test`, `playwright`, `playwright-core`, `puppeteer`, `puppeteer-core`, `cypress`, `webdriverio`, `selenium-webdriver`) | the adapter path below, with the project's tool |
| `none` | neither | UNSUPPORTED with `reason`; the result is never a PASS |

`measure.mjs` gives the browser a fresh profile in a system temporary directory and removes it when the
browser exits (like a git worktree, it is the tool's state, not a scratch file); it never uses the user's
browser profile.

**Network guard (A50/A52).** Every request of the page is paused (`Fetch.enable` with pattern `*`, then
`Fetch.requestPaused`): the page's own origin (the `base_url` folder for `file:`, the `base_url` localhost origin
for http) and `data:`/`blob:` continue; any other origin, another localhost port included, fails with
`BlockedByClient` and is recorded in `report.json` `network` (`interception: on`, `blocked: [{url, type}]`).
Child targets (workers) are auto-attached paused (`Target.setAutoAttach`, `waitForDebuggerOnStart`) and get the
same guard before they run; WebSockets (`ws:`/`wss:`, same origin included) are blocked by
`Network.setBlockedURLs` and recorded from `Network.webSocketCreated`; `navigator.serviceWorker.register` is
refused in the page and recorded. Allowed requests with POST, PUT, PATCH or DELETE are listed in
`network.same_origin_writes` (`{method, url}`); without a `visual_writes:` line in the plan or spec they cap
the result at INCONCLUSIVE. A child target whose guard could not be applied is listed in `network.unguarded`
and caps the result too. The validator refuses a `headless-browser` report without `network.interception: on`.

An adapter (below) must apply the same allowlist with its own tool (request routing or interception: only
the page's own origin plus `data:`/`blob:`, no WebSocket, no service worker) and record `network` in the same
shape with `interception: on`. An adapter that cannot never gives PASS: it records
`network: {interception: none, blocked: []}` and the result is at most INCONCLUSIVE (`network interception
not applied`). In every case drive it only against `file:` pages or a test server with throwaway or
in-memory data, never a backend with a real database (development, shared, staging or production).

`project_tool` also reports a declared tool that is not installed (that alone is still `none`: installing it
is the user's decision). `a11y_scanner` is set when the project has `axe-core` in `node_modules`; `measure.mjs`
then injects that copy and records its violations as `a11y_scanner` items. Another scanner the project runs
(its own command) is recorded the same way by hand: check `a11y_scanner`, the rule id in `note`, the node
count as `value`, threshold `== 0`.

Never download a browser (no `npx playwright install`, no package manager call, no browser auto-download of
a test tool), never add a dependency, never change the project's config to make a tool work. A tool that is
present but fails to start (missing system libraries, a sandbox the kernel forbids) is reported with its
error: INCONCLUSIVE when some cells were measured, UNSUPPORTED when none could be. `--no-sandbox` is only for a
throwaway CI runner measuring this repository's own fixture; never pass it for a project's pages.

## Adapters

The measurements are one page probe plus a Tab walk; any tool that can set a viewport, load a URL, run a
script in the page, press Tab and take a screenshot can drive them:

1. `measure.mjs --print-probe` prints a self-contained expression that installs `window.__vp`.
2. Per cell (screen x state x viewport): set the viewport, load the state's URL, run its `setup`, wait until
   `__vp.visible(<ready selector>)`, save a full-page PNG under `screenshots/`, then evaluate the probe and
   `__vp.measure({ touchTargetMin })` (returns `{ items, not_measured }`). Focus: `__vp.tabbables()`, then press
   Tab and read `__vp.step()` until it returns `"end"` (focus back on the document or on a stop already
   visited; `-1` is a stop that is not a listed tabbable, such as a focusable scroller: keep going); compare a screenshot of `__vp.clipOf(i)` focused and
   unfocused for each stop (any pixel change is a visible indicator). Record `focus_order` and
   `focus_visible` items in the same shape as `measure.mjs` does ([MEASURE.md](MEASURE.md#checks)).
3. Write `raw.json` `{ "tool": { "kind": "project-tool" | "runtime-adapter", "name": ... }, "config": <visual.json>,
   "cells": [{ "screen", "state", "viewport", "screenshot", "rendered", "items", "not_measured" }],
   "interactions": [{ "name", "viewport", "screenshot", "item" }] }` and run `measure.mjs --assemble raw.json
   --out <output>`: it hashes the screenshots, numbers the items, tags criteria and computes the result.

4. Technical SEO (only when the config has a `seo` block whose `public_html` is not false): per seo page load the URL once in the first
   viewport with no interaction, wait about a second, and evaluate `__vp.seo(<analytics global names>)` (the names are `analyticsGlobals(opt)`,
   exported by `measure.mjs`: `dataLayer` plus `seo.analytics.globals`; `scripts` lists only script elements that can execute). Add `path`, `requests` (every request the page made before consent, as `{ "url", "third_party": true|false, "phase": "before_consent", "initiator": "<script URL, when the browser reports it>" }`; `measure.mjs` fills it from the request guard and `Network.requestWillBeSent`; a plain URL string is the old shape, read as third party when it is outside the site), `source` (the HTML as served) and `x_robots` (the
   `X-Robots-Tag` header value, if any) to that object. Put the page objects in `raw.seo.pages` and the site facts in `raw.seo.site`
   (`{ robots_txt, sitemap_xml, exists: { "<site path>": true|false }, alternates: { "<site path>": [{hreflang, href}] } }`;
   `seoLookups` lists the paths); `{ "not_applicable": true }` for a project without HTML. `--assemble` runs the checks (`seoEvaluate`).
   Without `raw.seo`, each seo page is `not_measured`.

A runtime's own browser tool (an agent browser integration) is such an adapter; use it only when it can do
every step above for the cells the class requires, and name it in `tool.name`. A cell it cannot measure is a
cell-level `not_measured` entry, not a pass.

## Snapshot infrastructure

Visual regression runs only when the project already has it: committed baseline images (for example a
`*-snapshots/` or `__image_snapshots__/` folder next to tests) together with a test command that compares
against them (`toHaveScreenshot`, `toMatchImageSnapshot`, a visual-test runner configured in the repo). Run
the project's command once, in the worktree, with a timeout; record `regression: { "status": "run", "command",
"exit", "baselines": "existing" }`. A missing baseline that the command would create is a stop: do not run
an update mode, record `not_available` with the reason. No infrastructure: `{ "status": "not_available",
"reason": "..." }`. visual-proof never creates or updates a baseline (`baselines_created` is always false).
