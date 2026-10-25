# Native apps

visual-proof also covers native apps, with the tools the project **already has**. proofline installs nothing,
adds no test, no dependency and no config, and imposes no tool. `scripts/native.mjs` is Node only; `--detect` reads the repo and writes nothing, `--build` writes `report.json` to `--out`.

## 1. Target type

`node <skill-dir>/scripts/native.mjs --detect --repo <repo>` prints JSON (`schema: visual-proof.native-detect/1`),
exit 0 / 1 (UNSUPPORTED or a failed command) / 2 (usage). `target.type` is decided from files, the paths are in `target.evidence`:

| `type` | Evidence |
|---|---|
| `native-mobile`, platform `flutter` | `pubspec.yaml` with the flutter sdk |
| `native-mobile`, platform `react-native` | `package.json` depending on react-native |
| `native-mobile`, platform `android` | `AndroidManifest.xml`, or a gradle file with the android plugin |
| `native-mobile`, platform `ios` | an Xcode project for iOS, or `Package.swift` with an iOS platform |
| `native-mobile`, platform `maui` | a `.csproj`, `.fsproj`, `.vbproj` or `Directory.Build.props` with `<UseMaui>true</UseMaui>` (`UseMaui` set to false is not MAUI); the evidence names the targets of its `TargetFrameworks` (android, ios, maccatalyst, windows) |
| `desktop` | Xcode project for macOS, a WPF, WinForms, WinUI, Avalonia or Uno project, a Qt project, a Rust UI crate |
| `web` | everything else, and Electron or Tauri with a usable web entry (`index.html` or a dev/start script): `via: browser`, measured by `measure.mjs` |

Which files are markers, and what they must contain, is the `native_ui` section of the ecosystem definition
(`references/ecosystems.json`, a byte-identical copy of `control-plane/agents/ecosystems.json`, A173): adding a framework is
one entry there. The search has no depth limit and does not enter build output, dependency or tool folders (the definition's
`prune` lists), so a project three folders down is found like a root project. The first matching marker of a file decides.

**.NET MAUI.** It is detected like the others, as `native-mobile` with platform `maui`; the `AndroidManifest.xml` of its
`Platforms/Android` folder is one of its targets, not a second app. visual-proof runs no `dotnet` command (a build or run
would restore workloads and execute project code, which the allowlist below never permits), so a MAUI app is measured only
through a tool the project already has: a Maestro flow folder (`.maestro/`) run against a booted emulator or simulator that
holds the debug build, with `--os android|ios` saying which build the dump comes from. Without such a tool, or without a booted
device, the result is `UNSUPPORTED` with the reason and the one suggestion line (a Maestro flow that dumps the view
hierarchy); a MAUI project never falls back to the web measurement and is never a PASS.

A project with a native app and a separate web front end reports `also: ["web"]`; the changed paths decide which one the focus measures.
Electron or Tauri without a web entry is `desktop`.

## 2. Project tools and the command

Detected from config and dependency files (never from the machine): Flutter integration and golden tests,
Maestro flows, Detox, XCUITest targets, Espresso, Compose screenshot tests, Paparazzi, Roborazzi. For each, the run
command is taken from the project (package.json scripts, CI config, README, Makefile, Fastfile), else the
tool's standard command when the wrapper it needs exists, else `null`. A command is accepted only if it has no shell metacharacter
(`& | ; < > $ \` ( )`, quotes, newline, redirection), and matches an allowlist: `flutter test|drive`, `maestro test`, `detox test`,
`xcodebuild ... test`, `gradlew` with only `connected*AndroidTest`, `test*UnitTest`, `validate*ScreenshotTest`, `verifyPaparazzi*` or
`verifyRoborazzi*` tasks. Anything else is `command rejected` and the result is `UNSUPPORTED` with that reason; record, update,
install, clean, `pub get` and `npm i` are never allowed. For a package.json script the whole script value must pass, not just its name.

Without `--run` the command is only reported (`result: DISCOVERED`). With `--run` it prints the exact command to stderr, then runs it
once in the repo with no shell (argv), with a timeout (at least 30 s, `--timeout MS`). The lead shows that command to the user
(sandbox warning) before passing `--run`; a tool that needs a simulator, emulator or device checks for a booted one
first (`adb devices`, `xcrun simctl list devices booted`).

| `result` | Meaning |
|---|---|
| `NOT_NATIVE` | the target is web: use `measure.mjs --detect` |
| `DISCOVERED` | tool and command found, not run |
| `PROVEN` | the project's command ran once and exited 0 |
| `UNSUPPORTED` | no tool, no discoverable command, no runnable device, or the command failed: `reason`, and **one** `suggestion` line naming which tool addition would help (a suggestion; it is never added). Never a PASS |

## 3. Measured: normalized measurements

Only structured tool output is measured. Formats read by `--normalize`, `--check` and `--build`: an Android
uiautomator XML dump (`<node bounds content-desc text clickable ...>`) and the generic JSON below.
A uiautomator dump has pixel bounds: pass `--density` (dpi / 160) so sizes become dp; without it the touch target is `not_measured`.

```json
{ "schema": "visual-proof.native/1", "platform": "android|ios|flutter|react-native|desktop", "os": "android|ios",
  "device": { "name": "pixel", "width": 360, "height": 800, "unit": "dp", "font_scale": 1.0, "theme": "light|dark" },
  "elements": [ { "id": "app:id/pay", "role": "Button", "label": "Pay", "interactive": true,
                  "bounds": { "x": 0, "y": 0, "width": 48, "height": 48 }, "unit": "dp|pt|px",
                  "text_clipped": false, "contrast": 7.1 } ] }
```

`label` is the accessibilityLabel, contentDescription or semantics label (uiautomator: `content-desc`, else `text`, else a descendant's).
`text_clipped` and `contrast` are optional per element.

| Check | Value / threshold | Measured when |
|---|---|---|
| `native_state_present` | 1 / `== 1`: a screenshot exists for the spec state (empty, loading, error, ...) | always, per required cell (missing = fail) |
| `native_labels` | interactive elements without a label / `== 0` | the output has an interactive element |
| `native_touch_target` | smallest side of an interactive element / `>= 44` (ios, pt) or `>= 48` (android, dp) | bounds are in dp or pt and the os is known |
| `native_large_text` | elements with `text_clipped` / `== 0` | the capture has `font_scale >= 1.3` and the flag |
| `native_dark_theme` | text elements with `contrast < 4.5` / `== 0` | the capture is `theme: dark` and carries `contrast` |

Whatever the output cannot give is listed `not_measured` with the reason: per cell (`native_labels`, `native_touch_target`; makes the result
INCONCLUSIVE) or in `target.not_measured` (`native_large_text`, `native_dark_theme`: a limit). It is never reported as measured.

`node native.mjs --check dump.xml --density 2.625 --os android` prints the items for one file (exit 1 on a failure).

## 4. Report

`node native.mjs --build native.json --out <output>` writes `report.json` (`schema: visual-proof/1`) that `validate-visual.mjs` checks.
`native.json`: `class`, `tool {name, version?}` (or `{kind: "none", reason}` plus a top-level one-line `suggestion`, defaulted from the target), `target {type, platform, evidence[]}`,
`devices [{name, width, height, os}]` (they take the place of viewports, at least one), `screens [{id, path, states[]}]`,
`captures [{screen, state, device, screenshot, output, density?, font_scale?, theme?}]` (paths relative to the file),
`criteria [{id, required, checks[]}]`.
The report has `tool.kind: native-tool`, a `target` block, `measured[]` with the tool output file as evidence (path and sha256),
no web network record and `a11y_scanner: not_available`. The validator recomputes the result as for the web:
UNSUPPORTED (`tool.kind: none`, needs `suggestion`) / FAIL / INCONCLUSIVE / PASS, and a native report with no measured cell
(no label, touch-target, large-text or dark-theme item that passed) cannot PASS. Web reports are unchanged.

## 5. Judged

The judged aspects ([JUDGED.md](JUDGED.md): hierarchy, density, consistency, typography, character) apply to native screenshots,
in the same list, citing a screenshot and the spec; they never close the gate alone.

## Limits

Structured output only: a screenshot alone is judged, not measured. The tool must have been run by the project (this skill
does not drive a simulator); uiautomator dumps carry neither font scale nor contrast, so large text and dark theme are measured only from
tools whose output has them. A device-free tool (golden, screenshot tests) proves the screenshots, not the layout.
