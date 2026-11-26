// @ts-check
// U7 (A368): the Facts block of a completion report counts the human checks of the visual report (language pages), from the run's own report.json.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { A, project, warmDefaultTemplate } from '../lib/harness.mjs';

before(() => { warmDefaultTemplate(); });

const hc = (/** @type {string} */ path, /** @type {string} */ lang, kind = 'language_naturalness') => ({ screen: path, path, lang, kind, blocks: 3, chars: 200, text: 'x' });
const put = (/** @type {string} */ d, /** @type {any} */ rep) => {
  mkdirSync(`${d}/.agents/runs/LC/reviews/visual-proof`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/reviews/visual-proof/report.json`, JSON.stringify(rep));
};

test('report-facts: a visual report with language pages prints the count and one line per page; no report, no line', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'COMPLEX', autonomy: 'manual' });
  assert.doesNotMatch(A(d, ['report-facts', 'LC']).out, /Human checks/, 'no visual report: no line');
  put(d, { design: { human_checks: [hc('tr.html', 'tr'), hc('de/index.html', 'de'), hc('tr.html', 'tr'), hc('en.html', 'en'), hc('../etc', 'fr'), hc('x.html', 'tr', 'other')] } });
  const out = A(d, ['report-facts', 'LC']).out;
  assert.match(out, /^- Human checks \(not evaluated by QA\): 2$/m);
  assert.match(out, /^ {2}- Human check: language naturalness, tone and brand voice of tr\.html \(tr\); QA cannot judge them/m);
  assert.match(out, /of de\/index\.html \(de\)/);
  assert.doesNotMatch(out, /of en\.html|\.\.\/etc|of x\.html/);
  put(d, { design: { items: [] } });
  assert.match(A(d, ['report-facts', 'LC']).out, /^- Human checks \(not evaluated by QA\): 0$/m, 'a visual report with no language page says 0');
});
