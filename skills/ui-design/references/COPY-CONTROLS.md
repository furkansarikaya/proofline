# Copy, controls and language

Load when specifying copy, or any language or theme control.

## Copy

- Everything is in the user's language and in the product's voice. The system's internal names never reach the interface: file paths, role ids (`designer-1`), run ids and internal terms are not UI text. A visitor who wants proof or a source gets a small link or a disclosure with a human label ("How we measured this"), never a raw path. The validator rejects copy that looks like a path or an internal id.
- All page copy is written before coding (in the spec, with i18n keys when the project has them). Code never invents copy.
- First screen: a headline of about 32 characters (never above 48), one plain sentence under it saying what the thing is, and one primary button named after its action ("Start a free trial", not "Submit" or "Learn more" when it is not what happens). Record it per persuade or experience screen as `first_screen: {headline, subline, primary_actions}`; there is exactly one primary action.
- No performative labels: no "Our amazing features", no "Why choose us?", no "Welcome to the future of X". A label says what is below it.
- Claims on persuade surfaces are only those linked in `argument` ([DIRECTION.md](DIRECTION.md)).

## Controls and language

- Language and theme controls are compact and modern: an icon button or a single small menu, not a pair of text links or a native select at the top of the page. They show the current choice, are keyboard reachable, and have accessible names in the page's own language.
- Every string of a language version is in that language: headings, buttons, alt text, metadata, error states, and the controls' own labels. Brand names and code may stay. Text that should stay in another language is declared (allow-list) in the visual-proof design block; anything else English on a non-English page is a finding (`design_untranslated`).
- Theme control: respects the system setting by default; a stored choice wins after the first use; both themes are designed, not inverted.
