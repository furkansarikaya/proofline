// @ts-check
// A329: the designer's planning-stage write of a design document (A326.2) is attested here, so the mutation-ownership check does not stop the
// run at IMPLEMENTING. `planning-attest` (runtime hook at the designer's SubagentStop, lead role, denied to every model by the bash guard) records, for
// the designer-owned project files of .agents/owns.conf that lie in the knowledge scope, the path and its content fingerprint while handoff is
// PLANNED. `ensurePlanningWindow` turns exactly the paths whose CURRENT content still has the attested fingerprint into the first attested window
// (role designer, before = the empty tree); a path modified afterwards, any other path and any other role stay outside it and need tree-accept.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { requireLead, requireOpenRun } from './approve.mjs';
import { fail } from './errors.mjs';
import { hashFile, pathFingerprint } from './fingerprint.mjs';
import { resolveTopology, taskOwnedPaths } from './gates.mjs';
import { trackedPaths, untrackedPaths } from './git.mjs';
import { sha256 } from './hash.mjs';
import { led } from './lifeutil.mjs';
import { gatesEnforced, sectionValue } from './records.mjs';
import { boundNames } from './ledger.mjs';
import { requireRun, runDir } from './runs.mjs';
import { inKnowledgeScope } from './scope.mjs';
import { latin1Buf } from './wirebytes.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const FILE = 'PLANNING-ATTEST.tsv';

/** The window records of a run. @param {string} ev */
function windowNames(ev) {
  try { return readdirSync(ev).filter((n) => /^WINDOW-[0-9]+\.yaml$/.test(n)); } catch { return []; }
}

/** The designer's exact project files of owns.conf (a token `/path` without a trailing slash). @param {Context} ctx */
function designerFiles(ctx) {
  let text = '';
  try { text = readFileSync(`${ctx.root}/.agents/owns.conf`, 'latin1'); } catch { return []; }
  for (const l of text.split('\n')) {
    const f = l.split(/[ \t]+/).filter((x) => x !== '');
    if (f[0] === 'designer') return f.slice(1).filter((t) => t.startsWith('/') && !t.endsWith('/') && t.length > 1).map((t) => t.slice(1));
  }
  return [];
}

/** The attested rows (path to fingerprint). @param {string} dir */
function readAttest(dir) {
  /** @type {Map<string, string>} */ const m = new Map();
  let text = '';
  try { text = readFileSync(`${dir}/worker-evidence/${FILE}`, 'latin1'); } catch { return m; }
  for (const l of text.split('\n')) {
    const t = l.indexOf('\t');
    if (t > 0 && /^[0-9a-f]{64}$/.test(l.slice(t + 1))) m.set(l.slice(0, t), l.slice(t + 1));
  }
  return m;
}

/** `planning-attest ID designer` @param {Context} ctx @param {string[]} args */
export function planningAttest(ctx, args) {
  requireLead(ctx);
  const id = args[0] ?? '';
  if (args[1] !== 'designer') fail('planning-attest is for the role designer');
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return 0;
  requireOpenRun(ctx, id);
  if (resolveTopology(ctx, dir) !== 'orchestrated') return 0;
  if (sectionValue(ctx, dir, 'handoff', 'state') !== 'PLANNED') fail('planning-attest is made only while handoff state is PLANNED');
  ctx.fpMode = 'no';
  const changed = new Set([...trackedPaths(ctx), ...untrackedPaths(ctx)]);
  const rows = readAttest(dir);
  /** @type {string[]} */ const paths = [];
  for (const p of designerFiles(ctx)) {
    if (!changed.has(p) || !inKnowledgeScope(ctx, p)) continue;
    let fp;
    try { fp = pathFingerprint(ctx, p); } catch { continue; }
    if (!/^[0-9a-f]{64}$/.test(fp)) continue;
    rows.set(p, fp); paths.push(p);
  }
  if (paths.length === 0) return 0;
  const ev = `${dir}/worker-evidence`;
  try {
    mkdirSync(ev, { recursive: true });
    writeFileSync(`${ev}/${FILE}`, latin1Buf([...rows].sort().map(([p, h]) => `${p}\t${h}\n`).join('')));
  } catch { fail('could not write the planning attestation'); }
  ctx.forget('file:');
  led(ctx, id, 'planning-attest', '-', '-', `worker-evidence/${FILE}@${hashFile(`${ev}/${FILE}`)} role=designer stage=PLANNING paths=${paths.join(',')}`);
  ctx.out(`planning write attested: ${paths.join(' ')}\n`);
  return 0;
}

/**
 * Before the first worker window of an orchestrated run: record the planning attestation as WINDOW-1 (role designer, before = the empty tree)
 * when at least one attested path still has exactly its attested content in the task-owned tree. Idempotent; a no-op once any window exists.
 * @param {Context} ctx @param {string} dir @param {string} id
 */
export function ensurePlanningWindow(ctx, dir, id) {
  if (!gatesEnforced(ctx, dir) || resolveTopology(ctx, dir) !== 'orchestrated') return;
  const ev = `${dir}/worker-evidence`;
  if (windowNames(ev).length > 0) return;
  // fail closed: the file must be the one the `planning-attest` ledger row names (path and hash), so a hand-written or edited file attests nothing
  if (boundNames(ctx, dir, 'worker-evidence', 'planning-attest$', [FILE]).length === 0) return;
  const rows = readAttest(dir);
  if (rows.size === 0) return;
  const own = new Set(designerFiles(ctx));
  const kept = taskOwnedPaths(ctx, dir).filter(([p, h]) => rows.get(p) === h && own.has(p) && inKnowledgeScope(ctx, p));
  if (kept.length === 0) return;
  const after = sha256(kept.map(([p, h]) => `${p} ${h}\n`).join(''));
  const w = `${ev}/WINDOW-1.yaml`;
  try {
    writeFileSync(w, latin1Buf(`task_id: "${id}"\nseq: 1\nrole: "designer"\ntopology: "orchestrated"\nbefore_sha256: "${sha256('')}"\nafter_sha256: "${after}"\nexit_status: "0"\nplanning_attest: "${FILE}@${hashFile(`${ev}/${FILE}`)}"\ntimestamp: "${now().iso}"\n`));
  } catch { fail('could not write the planning window record'); }
  ctx.forget('file:');
  led(ctx, id, 'planning-window', '-', '-', `worker-evidence/WINDOW-1.yaml@${hashFile(w)} paths=${kept.map(([p]) => p).join(',')}`);
}
