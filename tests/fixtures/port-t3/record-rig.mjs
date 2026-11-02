// @ts-check
// ONE-TIME recorder of the golden port of the equivalence-rig cases (temporary, with tests/equivalence which it imports and which is to be deleted).
// usage: node tests/fixtures/port-t3/record-rig.mjs <group> [only-substring]     group: stage2-0 .. stage2-7, stage1
// Every case of the group is run on the SHELL engine (PROOFLINE_ENGINE=sh) from the state of its fixture, twice; the two results must agree (else the case
// is reported as unstable and left out), and the normalised result is stored with the state in tests/fixtures/port-t3/<group>.json.gz.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { SH_SIDE, runSide } from '../../equivalence/rig.mjs';
import { BUCKETS, stage2Cases } from '../../equivalence/cases/stage2-commands.mjs';
import { movedCommandCases } from '../../equivalence/cases/moved-commands.mjs';
import { snapTree, gitInfo, summarise } from '../../core/port-t3-core.mjs';
import { snapshot } from '../port-t2/snap.mjs';

const [group, only] = process.argv.slice(2);
/** @returns {import('../../equivalence/rig.mjs').Case[]} */
function casesOf(/** @type {string} */ g) {
  const m = /^stage2-(\d)$/.exec(g);
  if (m) return stage2Cases(BUCKETS[Number(m[1])]);
  if (g === 'stage1') return movedCommandCases();
  throw new Error(`unknown group ${g}`);
}
const GIT_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const headOf = (/** @type {string} */ d) => (spawnSync('git', ['-C', d, 'rev-parse', 'HEAD'], { env: GIT_ENV, encoding: 'latin1' }).stdout ?? '').trim();

/** @type {Record<string, any>} */ const blobs = {}; /** @type {Record<string, any>} */ const states = {}; /** @type {Map<string, string>} */ const stateOfDir = new Map();
const out = []; const unstable = [];
for (const c of casesOf(group)) {
  if (only && !c.name.includes(only)) continue;
  const fx = c.fixture;
  if (!stateOfDir.has(fx.dir)) { const s = snapshot(fx.dir, blobs); states[s.key] = s.state; stateOfDir.set(fx.dir, s.key); }
  const steps = c.steps.map((s) => {
    const { engine, ...rest } = s; // eslint-disable-line no-unused-vars
    return s.write ? { ...rest, write: { ...s.write, content: typeof s.write.content === 'function' ? s.write.content() : s.write.content } } : rest;
  });
  const resolved = { ...c, steps };
  const initial = snapTree(fx.dir); const start = headOf(fx.dir); const gitBefore = gitInfo(fx.dir, start);
  const baseSha = states[stateOfDir.get(fx.dir) ?? ''].baseSha;
  /** @returns {ReturnType<typeof summarise>} */
  const once = () => {
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'rec-rig-')));
    try {
      const side = runSide(/** @type {any} */ (resolved), SH_SIDE, { work });
      const root = path.join(work, 'fx');
      return summarise({ outputs: side.outputs, files: side.files, initial, window: side.window, tmpdir: side.tmpdir ?? path.join(work, 'tmp'), root, baseSha, gitBefore, gitAfter: gitInfo(root, start) });
    } finally { rmSync(work, { recursive: true, force: true }); }
  };
  let a = once(); let b = once();
  for (let i = 0; i < 2 && (JSON.stringify(a) !== JSON.stringify(b) || a.problems.length); i++) { a = b; b = once(); }
  if (JSON.stringify(a) !== JSON.stringify(b) || b.problems.length) { unstable.push(c.name); console.error(`UNSTABLE ${c.name}: ${b.problems.join(' | ').slice(0, 300)}`); continue; }
  const { problems, ...expect } = b; // eslint-disable-line no-unused-vars
  out.push({ name: c.name, state: stateOfDir.get(fx.dir), builtAt: fx.builtAt, steps, expect });
}
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), `${group}${only ? '.part' : ''}.json.gz`);
mkdirSync(path.dirname(dest), { recursive: true });
writeFileSync(dest, gzipSync(JSON.stringify({ blobs, states, cases: out })));
console.log(`${group}: ${out.length} cases recorded, ${unstable.length} unstable, ${Object.keys(states).length} states`);
