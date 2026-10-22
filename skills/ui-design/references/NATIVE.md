# Native mobile accessibility and interaction

Read when the task's target is native mobile: iOS, Android, Flutter or React Native. Set `target` in `ui.json` (`ios|android|flutter|react-native`; absent means `web`). Web-only rules (hover states, keyboard focus order and visible focus ring, tab order) are NOT mandatory for a native mobile target: `keyboard` per screen becomes optional (use it only for external keyboard or switch control when the task asks). Everything else in the spec (six states, copy, reuse, criteria) still applies.

Use the platform's own conventions found in the repo (existing components, theme files); the rules below say what to specify per screen, not which library to use.

## Which rule set applies

| Target | Rule set |
|---|---|
| `web` (default) or absent | web rules: keyboard, focus, hover, 44x44 CSS px, reduced motion |
| `ios`, `android`, `flutter`, `react-native` | this file; `keyboard` optional |
| a task with both web and native screens | one `ui.json` per target, or screens split by target in the spec; never relax web rules for a web screen |

## Per platform

| Concern | iOS | Android | Flutter | React Native |
|---|---|---|---|---|
| Screen-reader label | `accessibilityLabel`, `accessibilityHint`, traits | `contentDescription`, state descriptions | `Semantics(label: ...)` | `accessibilityLabel`, `accessibilityRole`, `accessibilityState` |
| Minimum touch target | 44x44 pt | 48x48 dp | 48x48 logical px (Android) / 44 (iOS) | 44 pt on iOS, 48 dp on Android |
| Text scaling | Dynamic Type | font scale (sp) | text scale factor | font scaling on; no fixed-height text containers |
| Dark theme | system appearance | system night mode | platform brightness | system colour scheme |

## What each screen specifies

1. **Screen-reader**: a label for every control and image that carries meaning (decorative items hidden from the reader), the role/trait, the announced state change for each of the six states, and the reading order. A visual-only state change with no announcement is a defect.
2. **Touch targets**: every interactive element meets the platform minimum above, with spacing between neighbours; small visuals get a larger hit area.
3. **Text scaling**: layouts survive the largest system text size: text wraps or the container grows, nothing truncates a critical value, no fixed heights; state what reflows at the largest size.
4. **Dark theme**: colours come from theme roles, not literals; state contrast of the main text/surface pairs in dark as well as light; images and icons that assume a light background are named.
5. **Platform guidelines**: use each platform's own navigation and control conventions (system back behaviour, navigation bar or tab bar, sheets, dialogs, pickers, pull to refresh) instead of copying another platform's; where a cross-platform app deliberately unifies them, record the reason.
6. **Motion**: respect the system reduce-motion setting.
7. **Gestures**: every gesture-only action has a visible, single-tap alternative that a screen reader can reach.

Put these in the existing fields: `screen_reader` (1), `responsive` (2, 3 and 4 as per-size and per-theme rules), `states[*].behavior` and `flows` (5, 7).
