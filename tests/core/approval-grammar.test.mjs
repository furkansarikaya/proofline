// @ts-check
// The approval grammar against the golden text recorded from the old engine (the shell functions of agent.sh; the inputs are tests/golden/approvals/cases.mjs), beside the extraction of
// approval_phrases in tests/e2e/reply-loop.test.mjs (which keeps testing the old code until stage 10).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APPROVAL_FILLERS, APPROVAL_PHRASES_DEFAULT, approvalNorm, approvalSentences, kindWords } from '../../control-plane/agents/scripts/core/approvals.mjs';
import { KINDS, REPLIES, RUNS } from '../golden/approvals/cases.mjs';

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'approvals', 'grammar.json'), 'utf8'));
const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');
const text = (/** @type {string} */ s) => Buffer.from(s, 'latin1').toString('utf8');

test('the default phrase allowlist and the fillers are the old engine\'s', () => {
  assert.equal(`${APPROVAL_PHRASES_DEFAULT}\n`, golden.phrases);
  assert.equal(`${APPROVAL_FILLERS}\n`, golden.fillers);
});

test('kind words, full sentences and the normal form are the old engine\'s', () => {
  for (const k of KINDS) assert.equal(`${text(kindWords(k))}\n`, golden.kindWords[k], k);
  for (const k of KINDS) for (const r of RUNS) {
    const lines = approvalSentences(k, r === '' ? '-' : r).map(approvalNorm);
    assert.equal(lines.length === 0 ? '' : `${text(lines.join('\n'))}\n`, golden.sentences[`${k}|${r}`], `${k} ${r}`);
  }
  REPLIES.forEach((t, i) => assert.equal(text(approvalNorm(`${bytes(t)}\n`)), golden.norm[i], JSON.stringify(t)));
});
