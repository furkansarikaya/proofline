import { tempDir } from '../lib/tempdir.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/decisions.md holds one entry per decision number: an entry header is `- **A<n>. ...` at the start of a
// line. A fix round edits its entry; it never appends a longer revision under the same number, and a new
// decision takes the next free number. This guard fails when a header number appears twice.
const HEADER = /^- \*\*A(\d+)\./gm;

/** @param {string} text @returns {string[]} the numbers (as "A<n>") that head more than one entry */
export function duplicateNumbers(text) {
  const seen = new Map();
  for (const m of text.matchAll(HEADER)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return [...seen].filter(([, c]) => c > 1).map(([n]) => `A${n}`);
}

const REPO = new URL("../../", import.meta.url).pathname;

test("docs/decisions.md: no A<n>. entry header number appears twice", () => {
  const text = readFileSync(join(REPO, "docs/decisions.md"), "utf8");
  assert.ok([...text.matchAll(HEADER)].length > 200, "the entry headers are found");
  assert.deepEqual(duplicateNumbers(text), []);
});

test("guard, known-good content (a temp file): distinct numbers, a mention in running text is not a header", () => {
  const dir = tempDir("decisions-guard-");
  try {
    const f = join(dir, "decisions.md");
    writeFileSync(f, "- **A1. one (patch).** What: follows A2.\n- **A2. two.** See - **A1. in prose.\n\n- **A3. three.**\n");
    assert.deepEqual(duplicateNumbers(readFileSync(f, "utf8")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard, known-bad content (a temp file): a repeated header number is reported, once per number", () => {
  const dir = tempDir("decisions-guard-");
  try {
    const f = join(dir, "decisions.md");
    writeFileSync(f, "- **A219. first.**\n- **A220. a.**\n- **A220. a longer revision.**\n- **A220. and another.**\n- **A219. again.**\n- **A221. ok.**\n");
    assert.deepEqual(duplicateNumbers(readFileSync(f, "utf8")).sort(), ["A219", "A220"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
