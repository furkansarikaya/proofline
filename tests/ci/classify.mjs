// @ts-check
// Classifies a pull request's changed paths (one per line on stdin) for CI (A76).
// Prints `code=false` when every path is plain documentation, else `code=true`; an empty list is `code=true`.
// Plain documentation: the root README, CHANGELOG, CONTRIBUTING, SECURITY and LICENSE, and docs/** files ending
// in .md, .png or .svg, except the generated docs/reference/**; any other file under docs/ is code. Markdown under skills/, roles/, control-plane/ and adapters/ is code (agents read
// it as instructions), and so is every script wherever it lives.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CODE_EXT = /\.(sh|mjs|cjs|js|yml|yaml|json)$/;
const ROOT_DOCS = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']);

/** @param {string} f the path is plain documentation */
function isDoc(f) {
  if (CODE_EXT.test(f)) return false;
  if (f.startsWith('docs/reference/')) return false;
  if (ROOT_DOCS.has(f)) return true;
  return f.startsWith('docs/') && /\.(md|png|svg)$/.test(f);   // shell `docs/*.md` lets `*` cross `/`
}

/** @param {string[]} paths @returns {'code=true' | 'code=false'} */
export function classify(paths) {
  const list = paths.filter((p) => p !== '');
  if (list.length === 0) return 'code=true';
  return list.every(isDoc) ? 'code=false' : 'code=true';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(classify(readFileSync(0, 'utf8').split('\n')));
}
