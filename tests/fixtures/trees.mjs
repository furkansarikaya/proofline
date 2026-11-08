// @ts-check
// The permanent guard of the fixture builders (issue #176, package B): every builder is run with every argument variant its callers use, and the
// built tree (every path, permission bits, sha256 of the content, git HEAD/refs/config, see tests/lib/tree.mjs) is compared with the digest recorded
// in fixtures/TREES.sha256. A change to a builder (or to a file it copies) therefore shows up as a diff of that file in the pull request.
//   node tests/fixtures/trees.mjs            verify (exit 1 on any difference, naming the variant)
//   node tests/fixtures/trees.mjs --update   rebuild every variant and rewrite fixtures/TREES.sha256 (do this on purpose, and read the diff)
// Offline and deterministic; builds in a temporary directory. The recorded digests are those of the SHELL builders' trees on main (0.0.70), taken with this same digest
// function; migration-validation's is that of the shell script patched to `sed -E` and the fixed date 2026-01-01T10:00:00Z (A237, deviation 1).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../lib/tree.mjs';
import { runGroup } from '../lib/proc.mjs';

/** A commit a builder makes without its own date (insights) gets this one, so its hash is the same on every run. */
export const FIXED_DATE = { GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' };
export const root = path.resolve(import.meta.dirname, '../..');
/** The repository version (`.claude-plugin/plugin.json`), masked in every digest. @param {string} r */
export const repoVersion = (r) => JSON.parse(readFileSync(path.join(r, '.claude-plugin', 'plugin.json'), 'utf8')).version;
export const recorded = path.join(root, 'fixtures', 'TREES.sha256');

/** One builder run: label, script (relative to fixtures/), arguments with `@T` for the target directory; `volatile`: the builder drives the real control plane, whose clock and hash chain are masked in the digest. @typedef {{ label: string, script: string, args: string[], volatile?: boolean }} Variant */
/** @type {Variant[]} */
export const variants = [
  ...['go', 'ts'].flatMap((l) => [
    { label: `proof-review/${l}`, script: `proof-review/${l}/setup.mjs`, args: ['@T'] },
    { label: `proof-review/${l} --working-tree`, script: `proof-review/${l}/setup.mjs`, args: ['@T', '--working-tree'] },
    { label: `proof-review/${l} plan`, script: 'proof-review/plan-setup.mjs', args: [l, '@T'] },
    ...['fail', 'pass'].map((sc) => ({ label: `test-trust/${l} diff ${sc}`, script: 'test-trust/diff-setup.mjs', args: [l, '@T', sc] })),
  ]),
  { label: 'migration-validation no-harness', script: 'migration-validation/setup.mjs', args: ['@T', 'no-harness'] },
  ...['review-rules-fail', 'needs-input', 'destructive-approval', 'security-pass-low', 'fix-rounds-exhausted']
    .map((st) => ({ label: `proofline-lead ${st}`, script: 'proofline-lead/setup.mjs', args: ['@T', st], volatile: true })),
];

/** The listed variants plus every fixtures/<name>/setup.mjs built with only the target directory (proofline-lead: all states). */
export async function allVariants() {
  const { readdirSync, existsSync } = await import('node:fs');
  const extra = readdirSync(path.join(root, 'fixtures')).sort().filter((n) => existsSync(path.join(root, 'fixtures', n, 'setup.mjs')))
    .map((n) => ({ label: n, script: `${n}/setup.mjs`, args: ['@T'], volatile: n === 'risk-signals' || n === 'proofline-lead' }));
  return [...variants, ...extra].sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** Build one variant in a fresh temporary directory and return its digest. @param {Variant} v @param {string} work */
export async function build(v, work) {
  const dir = mkdtempSync(path.join(work, 'v-')); const target = path.join(dir, 'tree');
  const r = await runGroup(process.execPath, [path.join(root, 'fixtures', v.script), ...v.args.map((a) => (a === '@T' ? target : a))], { timeoutMs: 600000, env: { ...process.env, ...FIXED_DATE } });
  if (r.status !== 0) throw new Error(`${v.label}: builder failed (${r.status})\n${r.text}`);
  return digest(target, { volatile: v.volatile, version: repoVersion(root) });
}

/** Build all variants, `jobs` at a time. @param {number} [jobs] @returns {Promise<Map<string, string>>} */
export async function buildAll(jobs = 4) {
  const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'proofline-trees-'));
  try {
    const list = await allVariants(); const out = new Map(); let next = 0;
    await Promise.all(Array.from({ length: jobs }, async () => { while (next < list.length) { const v = list[next++]; out.set(v.label, await build(v, work)); } }));
    return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export const format = (/** @type {Map<string, string>} */ m) => `${[...m].map(([k, d]) => `${d}  ${k}`).join('\n')}\n`;
export const parse = (/** @type {string} */ t) => new Map(t.split('\n').filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)]));

/** @returns {Promise<string[]>} the differences (empty when the recorded file matches) */
export async function verify() {
  const want = parse(readFileSync(recorded, 'utf8')); const got = await buildAll();
  const bad = [];
  for (const [k, d] of got) if (want.get(k) !== d) bad.push(`${k}: ${want.has(k) ? 'tree changed' : 'not recorded'}`);
  for (const k of want.keys()) if (!got.has(k)) bad.push(`${k}: recorded but no builder`);
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--update') { const m = await buildAll(); writeFileSync(recorded, format(m)); console.log(`wrote ${m.size} digests to fixtures/TREES.sha256`); }
  else { const bad = await verify(); if (bad.length) { console.error(`fixture trees differ from fixtures/TREES.sha256:\n${bad.join('\n')}\n(a deliberate change: node tests/fixtures/trees.mjs --update, and read the diff)`); process.exitCode = 1; } else console.log('fixture trees match fixtures/TREES.sha256'); }
}
