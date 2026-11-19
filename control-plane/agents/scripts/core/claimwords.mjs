// @ts-check
// DATA only (A341): the English vocabulary of a visual, browser, screenshot or UI check. The completion report may not contain ANY of these words or phrases
// outside the blocks the script generates (the Verification claims block, the Facts block, the generated Execution table and the `Look at:` lines copied
// from the QA record): whether such a check ran, and on which tree, is stated only by the generated block. There is no negation, code-span or fence
// exemption: the model's free text cannot say it, not even to deny it. Whole words, case-insensitive; a space also matches a line break, and in a
// hyphenated entry a hyphen or a space matches. Language rule: English only (the report is an English run file, A312). Extend the list here.
// An honest sentence that uses one of these words is refused too (accepted: the safe side); a paraphrase this list does not hold passes (a limit).
export const CLAIM_VOCABULARY = [
  'browser*', 'chrome', 'chromium', 'firefox', 'safari', 'webkit', 'playwright', 'puppeteer', 'cypress', 'selenium',
  'screenshot*', 'visual*', 'render*', 'eyeball*', 'looked at the page', 'opened the page', 'e2e', 'end-to-end', 'real device', 'dev server',
];
// A `*` at the end of an entry means any letters after the stem (render, renders, rendering, renderer).

/** Named HTML entities the audit decodes before it reads the text (numeric ones are always decoded). */
export const CLAIM_ENTITIES = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '', zerowidthspace: '', newline: ' ', tab: ' ', nonbreakingspace: ' ' });

/** Look-alike Cyrillic and Greek letters (both cases, listed one by one: the core maps case for ASCII only) read as the Latin letter they imitate. Other scripts and languages are not read (English-only rule: a documented limit). */
export const CLAIM_CONFUSABLES = /** @type {Record<string, string>} */ ({
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u0501': 'd', '\u04bb': 'h', '\u043a': 'k', '\u043c': 'm', '\u0442': 't', '\u043d': 'h', '\u0432': 'b', '\u0437': '3',
  '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03bd': 'v', '\u03b9': 'i', '\u03ba': 'k', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03b2': 'b', '\u03b7': 'n', '\u03c9': 'w',
  '\u0410': 'a', '\u0415': 'e', '\u041e': 'o', '\u0420': 'p', '\u0421': 'c', '\u0423': 'y', '\u0425': 'x', '\u0406': 'i', '\u0405': 's', '\u0408': 'j', '\u041a': 'k', '\u041c': 'm', '\u0422': 't', '\u041d': 'h', '\u0412': 'b',
  '\u039f': 'o', '\u0391': 'a', '\u0395': 'e', '\u039d': 'n', '\u0399': 'i', '\u039a': 'k', '\u03a1': 'p', '\u03a4': 't', '\u03a5': 'y', '\u03a7': 'x', '\u0392': 'b', '\u0397': 'h', '\u039c': 'm', '\u0396': 'z',
});

/** The HTML tag names the audit removes before it reads the text (a `<` followed by any other word is text). */
export const HTML_TAGS = ['a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'del', 'details', 'div', 'dd', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr'];
