// @ts-check
// A329 (hook half): the designer's SubagentStop attests a design document it wrote during PLANNING (no window); no other role does, and a product file is never attested.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repo } from '../core/helpers.mjs';
import { fixture, subStart, subStop } from './lib.mjs';

const TSV = '.agents/runs/LC/worker-evidence/PLANNING-ATTEST.tsv';
/** A run before its freeze (handoff PLANNED) with the installed owns.conf. */
function planned() {
  const dir = fixture({ auto: 'supervised' });
  cpSync(join(repo, 'control-plane/agents/owns.conf'), join(dir, '.agents/owns.conf'));
  return dir;
}

test('SubagentStop of the designer attests the design document written at PLANNING, by path and content hash', () => {
  const dir = planned();
  subStart(dir, 'proofline-designer', 'd1');
  mkdirSync(join(dir, 'docs/design'), { recursive: true });
  writeFileSync(join(dir, 'docs/design/DESIGN.md'), '# Design\n');
  subStop(dir, 'proofline-designer', 'd1', true);
  assert.ok(existsSync(join(dir, TSV)), 'no planning attestation was recorded');
  assert.match(readFileSync(join(dir, TSV), 'utf8'), /^docs\/design\/DESIGN\.md\t[0-9a-f]{64}\n$/);
  assert.match(readFileSync(join(dir, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=planning-attest/);
});

test('another role stopping, or a product file only, records no attestation', () => {
  const dir = planned();
  mkdirSync(join(dir, 'docs/design'), { recursive: true });
  writeFileSync(join(dir, 'docs/design/DESIGN.md'), '# Design\n');
  subStart(dir, 'proofline-implementer', 'i1'); subStop(dir, 'proofline-implementer', 'i1', true);
  subStart(dir, 'proofline-architect', 'a1'); subStop(dir, 'proofline-architect', 'a1', true);
  assert.ok(!existsSync(join(dir, TSV)), 'a role other than the designer attested');
  const d2 = planned();
  writeFileSync(join(d2, 'impl.txt'), 'product\n');
  subStart(d2, 'proofline-designer', 'd1'); subStop(d2, 'proofline-designer', 'd1', true);
  assert.ok(!existsSync(join(d2, TSV)), 'a product file was attested');
});
