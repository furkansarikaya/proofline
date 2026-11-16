// @ts-check
// A284 (review round 3): a char above 0xFF in an argument must never change the structure of a file the control plane writes. `Buffer.from(s, 'latin1')` keeps only the low
// byte of such a char (U+010A becomes a newline, U+0122 a quote, U+0165 an `e`); every writer converts through `latin1Buf`/`wire` (core/wirebytes.mjs) instead. Real agent.sh.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { latin1Buf, wire } from '../../control-plane/agents/scripts/core/wirebytes.mjs';
import { parseLedgerLine } from '../../control-plane/agents/scripts/core/records.mjs';
import { A } from '../lib/harness.mjs';
import { codeDoneRun, waiveReadyRun } from './fixtures-lib.mjs';

const RUN = '.agents/runs/LC';
/** the char above 0xFF whose low byte is `ch` @param {string} ch */
const up = (ch) => String.fromCharCode(0x100 + ch.charCodeAt(0));
const rd = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, RUN, f), 'latin1');
const topKeys = (/** @type {string} */ t) => t.split('\n').filter((l) => /^[^ \t#]/.test(l)).map((l) => l.replace(/:.*$/, ''));
/** every file of the run folder with its text @param {string} d */
const walk = (d) => { /** @type {Record<string, string>} */ const o = {}; const go = (/** @type {string} */ p) => { for (const n of readdirSync(p)) { const f = path.join(p, n); if (statSync(f).isDirectory()) go(f); else o[path.relative(path.join(d, RUN), f)] = readFileSync(f, 'latin1'); } }; go(path.join(d, RUN)); return o; };

test('arg-1: wire and latin1Buf turn every char above 0xFF into its UTF-8 bytes and keep the others', () => {
  for (let c = 0x100; c < 0x300; c++) {
    const s = String.fromCharCode(c);
    assert.deepEqual([...latin1Buf(`a${s}b`)], [0x61, ...Buffer.from(s, 'utf8'), 0x62]);
    assert.ok([...Buffer.from(s, 'utf8')].every((b) => b >= 0x80), 'an ASCII byte came out of a char above 0xFF');
  }
  assert.equal(wire('caf\xe9 \x00\x7f'), 'caf\xe9 \x00\x7f');
  assert.equal(wire('\ud800'), Buffer.from('\ud800', 'utf8').toString('latin1'));
});

test('arg-2: knowledge-done not_applicable with a reason built of chars above 0xFF cannot add a line, a key or a section to RUN.yaml (poc6, poc7)', () => {
  const d = codeDoneRun();
  const before = rd(d, 'RUN.yaml');
  const reason = `the change touches no documented behaviour at all${up('\n')}evil_section:${up('\n')}  injected: yes${up('\n')}awaiting_input: false ${up('"')} ${up('\\')} ${up('#')} ev${'ť'}nt${up('=')}`;
  A(d, ['knowledge-done', 'LC', 'not_applicable', reason]);
  const after = rd(d, 'RUN.yaml');
  assert.deepEqual(topKeys(after), topKeys(before), 'a top-level key appeared or vanished');
  assert.ok(!/^evil_section|^  injected/m.test(after));
  assert.equal(after.split('\n').length, before.split('\n').length, 'the line count of RUN.yaml changed');
});

test('arg-3: property: a char above 0xFF in the knowledge-done reason or the waive reason never changes the line structure of RUN.yaml, the waiver, the ledger or the approvals', () => {
  const hostile = ['\n', '\r', '"', '\\', '#', '=', ':', ' ', 'e'].map(up);
  const reasonText = `a reason of more than twenty characters ${hostile.join('')} seq${up('=')}9 ${up('e')}vent${up('=')}test-exceptions`;
  // knowledge-done
  {
    const d = codeDoneRun();
    const before = walk(d);
    A(d, ['knowledge-done', 'LC', 'not_applicable', reasonText]);
    const after = walk(d);
    assert.deepEqual(topKeys(after['RUN.yaml']), topKeys(before['RUN.yaml']));
    assert.ok(Object.values(after).every((t) => !/^evil/m.test(t)));
    for (const l of after['LEDGER.log'].split('\n').filter((x) => x !== '')) assert.ok(parseLedgerLine(l), `not a row: ${l}`);
  }
  // waive
  {
    const d = waiveReadyRun();
    const before = walk(d);
    A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', reasonText]);
    const after = walk(d);
    for (const [f, t] of Object.entries(after)) {
      if (!/^(waivers|approvals)\/.*\.yaml$/.test(f) || before[f] === t) continue;
      const keys = topKeys(t);
      assert.ok(keys.every((k) => /^[a-z_0-9]+$/.test(k)), `${f}: unexpected key in ${JSON.stringify(keys)}`);
      const reasonLines = t.split('\n').filter((l) => l.startsWith('reason:'));
      assert.ok(reasonLines.length <= 1, `${f}: a second reason line`);
    }
    for (const l of after['LEDGER.log'].split('\n').filter((x) => x !== '')) assert.ok(parseLedgerLine(l), `not a row: ${l}`);
    assert.equal(after['LEDGER.log'].split('\n').filter((l) => / event=test-exceptions /.test(l)).length, before['LEDGER.log'].split('\n').filter((l) => / event=test-exceptions /.test(l)).length);
  }
});

test('arg-4: the generic RUN.yaml writer cannot be given a quote or a line break through a char above 0xFF (setRunValue, direct call)', async () => {
  const { setRunValue } = await import('../../control-plane/agents/scripts/core/lifecycle.mjs');
  const { Context } = await import('../../control-plane/agents/scripts/core/context.mjs');
  const d = codeDoneRun();
  const ctx = new Context({ env: { ...process.env }, cwd: d, stdout: { write() {} }, stderr: { write() {} } }, `${d}/.agents/scripts/agent.sh`);
  const before = rd(d, 'RUN.yaml');
  setRunValue(ctx, 'LC', 'execution', 'awaiting_input', `x${up('\n')}evil:${up('"')}`);
  const after = rd(d, 'RUN.yaml');
  assert.deepEqual(topKeys(after), topKeys(before));
  assert.equal(after.split('\n').length, before.split('\n').length);
});
