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
   Tab and read `__vp.activeIndex()` until it repeats; compare a screenshot of `__vp.clipOf(i)` focused and
   unfocused for each stop (any pixel change is a visible indicator). Record `focus_order` and
   `focus_visible` items in the same shape as `measure.mjs` does ([MEASURE.md](MEASURE.md#checks)).
3. Write `raw.json` `{ "tool": { "kind": "project-tool" | "runtime-adapter", "name": ... }, "config": <visual.json>,
   "cells": [{ "screen", "state", "viewport", "screenshot", "rendered", "items", "not_measured" }],
   "interactions": [{ "name", "viewport", "screenshot", "item" }] }` and run `measure.mjs --assemble raw.json
   --out <output>`: it hashes the screenshots, numbers the items, tags criteria and computes the result.

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
