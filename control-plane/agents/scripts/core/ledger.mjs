// @ts-check
// The lifecycle ledger (LEDGER.log): the chain seal, the lifecycle digest, and the "bound" test of records the ledger names
// (`bound_names`). `verifySeal` checks the whole chain in one pass in this process: no child process at any length.
import { fail } from './errors.mjs';
import { sha256 } from './hash.mjs';
import { hashFile } from './fingerprint.mjs';
import { ledgerLines, runYaml, sectionValue, gatesEnforced } from './records.mjs';
import { readdirSync, statSync } from 'node:fs';

export { ledgerAppend } from './lock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `lifecycle_digest ID` over the RUN.yaml of a run directory. @param {Context} ctx @param {string} dir */
export function lifecycleDigest(ctx, dir) {
  const y = runYaml(ctx, dir);
  /** @param {string} s @param {string} k */
  const lv = (s, k) => `${s}.${k}=${y.value(s, k)}\n`;
  let t = lv('execution', 'state') + lv('execution', 'knowledge_state') + lv('execution', 'awaiting_input') + lv('execution', 'autonomy')
    + lv('handoff', 'state') + lv('handoff', 'implemented_patch_sha256') + lv('handoff', 'code_done_patch_sha256')
    + lv('pipeline', 'classification') + lv('pipeline', 'review') + lv('pipeline', 'tier')
    + lv('completion_report', 'published') + lv('completion_report', 'adapter') + lv('completion_report', 'receipt');
  if (y.value('task_source', 'type') === 'local_markdown') t += lv('task_source', 'path') + lv('task_source', 'revision');
  return sha256(t);
}

/** The ledger is a non-empty file (`[ -s FILE ]`). @param {string} file */
function nonEmpty(file) { try { return statSync(file).size > 0; } catch { return false; } }

/**
 * `verify_seal ID`: the ledger chain (every line carries its number and the digest of the line before) and the last digest against the
 * lifecycle fields of RUN.yaml. A run without lifecycle_gates is not sealed. One pass, no child process.
 * @param {Context} ctx @param {string} id @param {string} dir
 */
export function verifySeal(ctx, id, dir) {
  if (!gatesEnforced(ctx, dir)) return;
  const file = `${dir}/LEDGER.log`;
  if (!nonEmpty(file)) {
    const hs = sectionValue(ctx, dir, 'handoff', 'state');
    if (hs !== 'PLANNED' && hs !== '') fail(`lifecycle ledger missing but handoff.state=${hs}: manual lifecycle-state edit detected for ${id}`);
    if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail(`lifecycle ledger missing but execution.state=CODE_DONE: manual lifecycle-state edit detected for ${id}`);
    if (sectionValue(ctx, dir, 'completion_report', 'published') === 'true') fail(`lifecycle ledger missing but a completion report is marked published: manual lifecycle-state edit detected for ${id}`);
    return;
  }
  let prev = 'genesis';
  let n = 0;
  let lastDigest = '';
  for (const line of ledgerLines(ctx, dir)) {
    n++;
    if (!line.startsWith(`seq=${n} prev=${prev} event=`)) fail(`lifecycle ledger chain broken at entry ${n} for ${id}: ledger was edited`);
    const at = line.indexOf(' digest=');
    const rest = at < 0 ? line : line.slice(at + ' digest='.length);
    const sp = rest.indexOf(' ');
    lastDigest = sp < 0 ? rest : rest.slice(0, sp);
    prev = sha256(line);
  }
  if (lastDigest !== lifecycleDigest(ctx, dir)) {
    fail(`lifecycle state of ${id} does not match its last recorded control-plane transition: RUN.yaml lifecycle fields were edited by hand. A completed run is reopened only with 'agent.sh amend'`);
  }
}

/**
 * `bound_names RUNDIR SUBDIR EVENT-ERE NAME...`: the names whose token "<SUBDIR>/<NAME>@<sha256>" appears in a ledger entry whose event
 * matches EVENT-ERE (anchored at the event value). Order of NAMES kept.
 * @param {Context} ctx @param {string} dir @param {string} sub @param {string} eventEre @param {string[]} names
 */
export function boundNames(ctx, dir, sub, eventEre, names) {
  if (names.length === 0 || !nonEmpty(`${dir}/LEDGER.log`)) return [];
  const re = new RegExp(`^event=${eventEre}`);
  const text = ctx.once(`ledger-bound:${dir}:${eventEre}`, () => {
    let all = '';
    for (const l of ledgerLines(ctx, dir)) {
      const f = l.split(/[ \t\n]+/).filter((x) => x !== '');
      if (f[2] !== undefined && re.test(f[2])) all += ` ${l.replace(' detail=', ' detail= ')} `;
    }
    return all;
  });
  return names.filter((n) => text.includes(` ${sub}/${n}@${hashFile(`${dir}/${sub}/${n}`)} `));
}

/** The names of a record folder (`ls -1`, byte order) that match a pattern. @param {string} folder @param {RegExp} re */
export function listNames(folder, re) {
  try { return readdirSync(folder).filter((n) => re.test(n)).sort(); } catch { return []; }
}
