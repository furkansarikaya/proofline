// @ts-check
// Golden tests recorded from the OLD engine (the shell code of agent.sh), beside the extraction tests (issue #167):
//   risk_words_match (risk-test.sh sc_log_words_match and sc_log_pattern_wide)  tests/core/golden/risk-words-match.json
//   the order of `agent.sh next` along the lifecycle (proofline-lead.test.mjs: classify, branch, baseline)  tests/core/golden/next-order.txt
// Both engines must produce the recorded text. Until the Node engine has a risk_words_match the golden runs against the shell only; as soon as a
// core module exports `riskWordsMatch(re, words, stdinText)` (true when the shell function would exit 0) that function is held to the same file.
// `next` goes through agent.sh: the default engine is the Node core once `next` is a moved command and the shell before that, PROOFLINE_ENGINE=sh is the shell.
// Re-record with `node tests/core/golden/record.mjs` only for a reviewed change of the shell specification (stage 10 removes the shell leg).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { baseEnv } from '../equivalence/fixture.mjs';
import { stateFixture } from '../equivalence/cases/stage2-fixtures.mjs';
import { repo, scriptsDir } from './helpers.mjs';
import { NEXT_STATES, shellRiskWordsMatch } from './golden/record.mjs';

const golden = (/** @type {string} */ n) => path.join(import.meta.dirname, 'golden', n);

/** @returns {Promise<((re: string, words: string, text: string) => boolean)|null>} the Node implementation, once a core module exports it */
async function nodeRiskWordsMatch() {
  const dirs = [path.join(scriptsDir, 'core'), path.join(scriptsDir, 'core', 'commands')];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.mjs')).sort()) {
      const m = await import(pathToFileURL(path.join(d, f)).href);
      if (typeof m.riskWordsMatch === 'function') return m.riskWordsMatch;
    }
  }
  return null;
}

describe('risk_words_match golden', () => {
  /** @type {{ re: string, words: string, lines: string[], match: boolean }[]} */
  const cases = JSON.parse(readFileSync(golden('risk-words-match.json'), 'utf8'));

  test('the golden holds every case of risk-test.sh and both outcomes', () => {
    const t = readFileSync(path.join(scriptsDir, 'risk-test.sh'), 'utf8');
    for (const fn of ['sc_log_words_match', 'sc_log_pattern_wide']) {
      const body = t.slice(t.indexOf(`${fn}() {`)); const end = body.indexOf('\n}\n');
      const lists = [...body.slice(0, end).matchAll(/for lw in ([^\n]*(?:\\\n[^\n]*)*); do/g)];
      assert.ok(lists.length >= 2, `${fn}: no case lists found`);
      for (const l of lists) for (const q of l[1].matchAll(/'([^']*)'/g)) {
        assert.ok(cases.some((c) => c.lines.includes(q[1])), `${fn}: the case ${JSON.stringify(q[1])} is not in the golden`);
      }
    }
    assert.ok(cases.some((c) => c.match) && cases.some((c) => !c.match));
    assert.ok(cases.length >= 60);
  });

  test('the shell function gives the recorded answer for every case', () => {
    for (const c of cases) assert.equal(shellRiskWordsMatch(c.re, c.words, c.lines), c.match, `${JSON.stringify(c.lines)} against ${c.words} / ${c.re.slice(0, 30)}`);
  });

  test('the Node function (once a core module exports riskWordsMatch) gives the recorded answer for every case', async (t) => {
    const fn = await nodeRiskWordsMatch();
    if (!fn) { t.skip('no core module exports riskWordsMatch yet: the golden runs against the shell only'); return; }
    for (const c of cases) assert.equal(fn(c.re, c.words, c.lines.join('\n') + '\n'), c.match, `${JSON.stringify(c.lines)} against ${c.words} / ${c.re.slice(0, 30)}`);
  });
});

describe('next output order golden', () => {
  const text = readFileSync(golden('next-order.txt'), 'latin1');
  /** @type {Map<string, { cmd: string[], exit: number, out: string }>} */
  const sections = new Map();
  for (const m of text.matchAll(/^== (.+?) \(agent\.sh ([^)]*)\)\n# exit (\d+)\n((?:(?!== ).*\n)*)/gm)) sections.set(m[1], { cmd: m[2].split(' '), exit: Number(m[3]), out: m[4] });

  test('the golden holds the intake order classify, branch, baseline, then freeze, and every recorded state', () => {
    assert.equal(sections.size, NEXT_STATES.length + 1);
    const next = (/** @type {string} */ s) => sections.get(s)?.out.match(/^next=(.*)$/m)?.[1] ?? '';
    assert.match(next('intake-unclassified'), /^agent\.sh classify LC /);
    assert.equal(next('intake-classified'), 'agent.sh branch LC');
    assert.equal(next('intake-branched'), 'agent.sh baseline LC');
    assert.equal(next('intake-planned'), 'agent.sh freeze LC');
    const lead = readFileSync(path.join(repo, 'tests/skills/proofline-lead.test.mjs'), 'utf8');
    assert.match(lead, /intake follows the order agent\.sh next prints/);
  });

  for (const engine of ['sh', 'default']) {
    test(`agent.sh next prints the recorded text in every state (${engine} engine)`, () => {
      for (const [state, g] of sections) {
        const dir = (state === 'no run' ? stateFixture('empty') : stateFixture(state)).dir;
        const r = spawnSync('sh', ['./.agents/scripts/agent.sh', ...g.cmd], { cwd: dir, encoding: 'latin1', env: baseEnv(dir, engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}) });
        assert.equal(r.status, g.exit, `${state}: exit code`);
        assert.equal(r.stdout, g.out, `${state}: stdout`);
      }
    });
  }
});
