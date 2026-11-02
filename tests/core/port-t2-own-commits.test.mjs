// @ts-check
// T2 port of cifix-test.sh (sc_own_commits_fresh, sc_own_commits_foreign): a commit that holds only the run's own bookkeeping (its task file moved to done/,
// the knowledge documents the knowledge step wrote) leaves the plan fresh and is ledgered once; a product file or a foreign docs page in the range stales it.
// (sc_delivery_commit_fresh needs the real delivery commit chain of deliver-step: it stays with the deliver commands.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { helpers, node, stateOf } from './port-t2-lib.mjs';

/** @param {string} r @param {string} want */
function stale(r, want = 'stale plan') { const x = node(r, ['freshness', 'LC']); assert.notEqual(x.code, 0, x.out + x.err); assert.ok((x.out + x.err).includes(want), `no "${want}" in ${x.out}${x.err}`); return x.out + x.err; }
const ledger = (/** @type {string} */ r) => readFileSync(path.join(r, '.agents/runs/LC/LEDGER.log'), 'latin1');
const baseNow = (/** @type {string} */ r) => (/^ {2}base_sha: "?([0-9a-f]{40})/m.exec(readFileSync(path.join(r, '.agents/runs/LC/RUN.yaml'), 'latin1')) ?? [])[1];

describe('cifix-test: freshness over the run\'s own commits', () => {
  test('sc_own_commits_fresh: the task file move and the knowledge documents leave the plan fresh (ledgered once); a product file in the range still stales it and is named', () => {
    const r = stateOf('own-done'); const h = helpers(r);
    h.git(['add', 'docs', 'tasks']); h.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'docs: knowledge and task file']);
    const x = node(r, ['freshness', 'LC']); assert.equal(x.code, 0, x.out + x.err);
    assert.ok((x.out + x.err).includes("this run's task file and knowledge documents"));
    assert.notEqual(baseNow(r), h.git(['rev-parse', 'HEAD']).trim());   // an own-bookkeeping commit does not move base_sha
    assert.equal(node(r, ['freshness', 'LC']).code, 0);
    assert.equal(ledger(r).split("this run's task file and knowledge documents").length - 1, 1);
    h.write('product.txt', 'x\n'); h.git(['add', 'product.txt']); h.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: someone else']);
    stale(r); assert.ok(stale(r).includes('product.txt'));
  });
  test('sc_own_commits_foreign: a foreign docs page in the range, and an edited run page, stay a stale plan that names the page', () => {
    const r = stateOf('own-done-nots'); const h = helpers(r);
    h.write('docs/wiki/other.md', '# Other\n\nsomeone else wrote this page\n'); h.git(['add', 'docs/wiki/other.md']); h.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'docs: another page']);
    stale(r); assert.ok(stale(r).includes('docs/wiki/other.md'));
    h.git(['reset', '-q', '--hard', 'HEAD^']);
    h.append('docs/wiki/lookup.md', 'edited by someone after the knowledge step\n'); h.git(['add', 'docs/wiki/lookup.md']); h.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'docs: edit the run page']);
    stale(r);
  });
});
