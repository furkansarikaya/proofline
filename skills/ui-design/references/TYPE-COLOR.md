# Type, colour and browser surfaces

Load when writing typography, colour roles or the browser-surface part of a spec.

## Typography

- Role scale: display, heading, body, label, numeric. The jump from body to the largest heading is at least 3x on persuade and experience, at least 2x on read and operate.
- Body measure 45-75 characters per line. Headings run at most 2 lines at every width, including the longest translation: reserve room for text that grows in localisation (German and Turkish often grow 20-35 %).
- Set a letter-spacing floor (no tight tracking on body; negative tracking only on large display sizes) and line heights per role.
- Persuade: a characterful self-hosted font. Read its licence from the font package (not from memory) and write family, file and licence in the image ledger `## Fonts` table and in `craft.fonts`. A system font cannot be the voice of a persuade surface; it is fine for body only when the display face carries the voice. Self-hosted means no third-party CDN and no hot-linking, with `font-display` set and a subset where it saves weight. The dealt type system names faces; its licence status comes from `scripts/deal.mjs` (directory-verified, or flagged needs-package-licence); give each font a `license_ref` (`library:<family>` or the package licence file) or it is rejected. A brand font is a constant and replaces the dealt faces.

## Colour

1. Strategy first, then colour: `restrained` (neutral plus one accent), `committed` (one colour carries the page), `full-palette` (several roles of equal weight), `drenched` (colour is the ground). Name it.
2. Roles: ground, surfaces, text, action, focus, selection, status colours (success, warning, danger, info). Every colour in the spec has a role.
3. New palettes in OKLCH: pick lightness and chroma deliberately, vary hue; state contrast ratios for text pairs (they are measured later).
4. Secondary text on a coloured surface is derived from that colour (same hue, adjusted lightness), never a neutral grey laid over it.
5. Light or dark is chosen by the scene of use (where, when, how long the visitor looks), not by the category's habit. Write the scene in one line.

## Browser surfaces (themed from the palette)

Text selection colours, caret colour on inputs, scrollbar colours, the focus ring, link underline offset and thickness, and tabular numerals in tables are all set from palette tokens, so the page does not show browser defaults at its edges. List them under the spec's accessibility baseline; visual-proof measures them (`design_surfaces`).
