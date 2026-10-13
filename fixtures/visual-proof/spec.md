# UI spec: Orders screen

Screen `orders` (`index.html`). Class COMPLEX. Viewports: 360x740 (phone), 768x1024 (tablet), 1280x800 (desktop).

## States

| State | How to reach it | Visible marker | Copy |
|---|---|---|---|
| success | `index.html` | `[data-state=success]` | "Recent orders" table and "Recommended" carousel |
| empty | `index.html?state=empty` | `[data-state=empty]` | "No orders yet. New orders appear here." |
| loading | `index.html?state=loading` | `[data-state=loading]` | "Loading orders…" (`role=status`) |
| error | `index.html?state=error` | `[data-state=error]` | "Orders could not be loaded. Try again." with a Retry button |
| partial | not applicable | - | one request loads the whole list |
| permission-denied | not applicable | - | the page is public |

## Layout

- The "Recommended" row is a horizontally scrollable carousel on every viewport; its cards keep 240px width.
- A "Skip to orders" link is the first focus stop; it is visually hidden until focused.

## Acceptance criteria

- AC-1: The orders page has no horizontal page scrolling at 360px, 768px and 1280px (the carousel scrolls inside itself).
- AC-2: All visible text meets WCAG 2.2 AA contrast: 4.5:1, or 3:1 for large text.
- AC-3: Every state listed above that applies (success, empty, loading, error) is rendered.
- AC-4: Every interactive target is at least 24x24 CSS px, or spaced as WCAG 2.5.8 allows.
- AC-5: Submitting an empty search shows the inline error "Enter a search term."
- AC-6: Headings establish a clear hierarchy: the page title is the largest text on the screen.

`visual_proof: AC-1, AC-2, AC-3, AC-4` (AC-5 and AC-6 are `not_required`).
