// @ts-check
// Behaviour of identity-test.sh sc_id_identity (A172) as an absolute Node test (tests/legacy-port-map.tsv): finding ids (qa-n, QA-n, gate ids) and the
// QA-n / AC-n spellings are accepted by their checker and recorded as written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, project, read, verbs } from './legacy-lib.mjs';

test('identity: finding ids (qa-n, QA-n, gate ids) and QA-n/AC-n spellings are accepted by their checker and recorded as written', () => {
  const d = project(`scaffold orchestrated; ${IMPLEMENTED}`);
  const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  /** a hand-written task result with the given finding id spelling */
  const rec = (/** @type {string} */ spelling) => {
    const f = `${d}/.agents/local/rec.md`;
    writeFileSync(f, `ROLE: qa\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: ${A(d, ['fingerprint', 'LC']).out.trim()}\nARTIFACT: QA_PLAN.md ${sha(`${d}/.agents/runs/LC/QA_PLAN.md`)}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| ${spelling}-1 | info | impl.txt:1 | a note | seen |\n`);
    return A(d, ['record', 'LC', '--file', f], { role: 'qa' });
  };
  for (const sp of ['qa', 'QA', 'Qa']) accepted(rec(sp), `record refused finding id spelling ${sp}-1 for qa`);
  const all = ['results', 'reports'].flatMap((s) => { try { return readdirSync(`${d}/.agents/runs/LC/${s}`).map((n) => read(d, `.agents/runs/LC/${s}/${n}`)); } catch { return []; } });
  assert.ok(all.some((t) => t.includes('QA-1')), 'the recorded spelling QA-1 was not kept as written');
  // gate ids: submit writes <GATE>-<n>; record takes any case
  mkdirSync(`${d}/.agents/runs/LC/reviews/proof-review/small`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/reviews/proof-review/small/REPORT.md`, 'review of the tree\n');
  writeFileSync(`${d}/.agents/local/r.rows`, 'info|impl.txt:1|a note about the lookup|seen in the plan\n');
  accepted(A(d, ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--findings', `${d}/.agents/local/r.rows`, '--agent', 'g1'], { role: 'reviewer' }), 'gate id submit->record failed');
  const gates = `${d}/.agents/runs/LC/gates`;
  const small = () => readdirSync(gates).filter((n) => n.endsWith('-REVIEW_SMALL.yaml')).map((n) => readFileSync(`${gates}/${n}`, 'utf8')).join('\n');
  assert.match(small(), /^finding: REVIEW_SMALL-1\|/m, 'gate finding id is not <GATE>-<n> as produced');
  accepted(verbs(d, "f=$(result_for REVIEW_SMALL PASS high 'review_small-1|info|impl.txt:1|a note|seen'); AS reviewer record LC --file \"$f\" >/dev/null"), 'a lower-case gate finding id review_small-1 was refused');
  assert.match(small(), /^finding: review_small-1\|/m, 'the recorded gate id spelling changed');
  // QA-n scenarios and AC-n in QA_PLAN.md: lower case and zero padded spellings
  writeFileSync(`${d}/.agents/runs/LC/QA_PLAN.md`, '# QA plan\n\n- qa-01 (ac-1): lookup returns the stored value\n');
  accepted(verbs(d, 'qa_bind LC'), 'qa_bind');
  accepted(A(d, ['verify-qa-plan', 'LC']), 'verify_qa_plan_bound refused qa-01 (ac-1)');
});
