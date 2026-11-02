// @ts-check
// ONE-TIME recording tools of the T2 port (temporary): a project snapshot with content-addressed blobs, shared by record.mjs and rec-call.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const agentsSrc = path.join(repo, 'control-plane', 'agents');
const GIT_ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** @param {Buffer} buf @param {number} mode */
const blobKey = (buf, mode) => createHash('sha1').update(String(mode)).update('\0').update(buf).digest('hex');
/** @param {string} root @param {string[]} args */
const git = (root, args) => spawnSync('git', ['-C', root, ...args], { env: GIT_ENV, maxBuffer: 1 << 28 });

/** @param {string} root @param {string} dir @param {string[]} out @param {string[]} [empty] */
function walk(root, dir, out, empty) {
  const names = readdirSync(path.join(root, dir));
  if (empty && dir && names.length === 0) empty.push(dir);
  for (const n of names) {
    const rel = dir ? `${dir}/${n}` : n;
    if (rel === '.git') continue;
    const st = lstatSync(path.join(root, rel));
    if (st.isDirectory()) walk(root, rel, out, empty); else if (st.isFile() || st.isSymbolicLink()) out.push(rel);
  }
}

/**
 * Snapshot a project into a blob store: the project files of the base commit (outside .agents), the working tree files (project files, .agents/runs,
 * .agents/local, the manifest and every .agents file that differs from the shipped control plane, except scripts), the recorded base commit.
 * @param {string} root @param {Record<string, { mode: number, text?: string, b64?: string }>} blobs
 * @returns {{ key: string, state: { base: Record<string, string>, files: Record<string, string>, baseSha: string } }}
 */
export function snapshot(root, blobs) {
  /** @param {Buffer} buf @param {number} mode */
  const put = (buf, mode) => {
    const k = blobKey(buf, mode);
    if (!(k in blobs)) blobs[k] = !buf.includes(0) && Buffer.from(buf.toString('latin1'), 'latin1').equals(buf) ? { mode, text: buf.toString('latin1') } : { mode, b64: buf.toString('base64') };
    return k;
  };
  /** @param {string} target */
  const putLink = (target) => { const k = blobKey(Buffer.from(target, 'latin1'), 0o120000); if (!(k in blobs)) blobs[k] = { mode: 0o120000, link: target }; return k; };
  // the run whose base commit the snapshot keeps: LC, else the first run of the project
  const runsDir = path.join(root, '.agents/runs');
  const runId = existsSync(path.join(runsDir, 'LC/RUN.yaml')) ? 'LC' : (existsSync(runsDir) ? readdirSync(runsDir).find((n) => existsSync(path.join(runsDir, n, 'RUN.yaml'))) : undefined);
  const y = runId ? path.join(runsDir, runId, 'RUN.yaml') : '';
  const baseSha = y ? ((/^ {2}base_sha: "?([0-9a-f]{40})"?/m.exec(readFileSync(y, 'latin1')) ?? [])[1] ?? '') : '';
  const baseRef = baseSha || 'HEAD';
  /** @type {Record<string, string>} */ const base = {};
  const ls = git(root, ['ls-tree', '-r', '-z', baseRef]).stdout.toString('latin1').split('\0').filter(Boolean);
  for (const ent of ls) {
    const tab = ent.indexOf('\t'); const rel = ent.slice(tab + 1);
    if (rel.startsWith('.agents/')) {
      // a tracked .agents file that differs from the shipped control plane (a test stub, a scoped file) belongs to the base commit
      const rest = rel.slice(8);
      if (rel.startsWith('.agents/runs/') || rel.startsWith('.agents/local/') || rel.startsWith('.agents/scripts/')) continue;
      const cur = git(root, ['show', `${baseRef}:${rel}`]).stdout;
      if (existsSync(path.join(agentsSrc, rest)) && readFileSync(path.join(agentsSrc, rest)).equals(cur)) continue;
    }
    if (ent.startsWith('120000')) { base[rel] = putLink(git(root, ['show', `${baseRef}:${rel}`]).stdout.toString('latin1')); continue; }
    const mode = ent.startsWith('100755') ? 0o755 : 0o644;
    base[rel] = put(git(root, ['show', `${baseRef}:${rel}`]).stdout, mode);
  }
  /** @type {string[]} */ const all = [];
  /** @type {string[]} */ const dirs = [];
  walk(root, '', all, dirs);
  /** @type {Record<string, string>} */ const files = {};
  for (const rel of all) {
    if (rel.startsWith('.agents/')) {
      const rest = rel.slice(8);
      const keep = rel.startsWith('.agents/runs/') || rel.startsWith('.agents/local/') || rel === '.agents/.proofline-manifest'
        || (!rel.startsWith('.agents/scripts/') && (!existsSync(path.join(agentsSrc, rest)) || !readFileSync(path.join(root, rel)).equals(readFileSync(path.join(agentsSrc, rest)))));
      if (!keep) continue;
    }
    const st = lstatSync(path.join(root, rel));
    files[rel] = st.isSymbolicLink() ? putLink(readlinkSync(path.join(root, rel))) : put(readFileSync(path.join(root, rel)), st.mode & 0o777);
  }
  // the trees of the earlier gate fingerprints: selective repetition diffs them against the current tree, so their objects travel with the state
  /** @type {Set<string>} */ const trees = new Set();
  const gdir = path.join(root, '.agents/runs/LC/gates');
  if (existsSync(gdir)) for (const n of readdirSync(gdir)) if (n.endsWith('.yaml')) { const m = /^fingerprint: "?([0-9a-f]{40})"?$/m.exec(readFileSync(path.join(gdir, n), 'latin1')); if (m && git(root, ['cat-file', '-e', m[1]]).status === 0) trees.add(m[1]); }
  /** @type {string | undefined} */ let pack;
  if (trees.size) {
    const lst = spawnSync('git', ['-C', root, 'rev-list', '--objects', ...trees], { env: GIT_ENV, maxBuffer: 1 << 28 }).stdout;
    const names = lst.toString('latin1').split('\n').map((l) => l.split(' ')[0]).filter(Boolean).join('\n') + '\n';
    const pk = spawnSync('git', ['-C', root, 'pack-objects', '--stdout', '-q'], { env: GIT_ENV, input: names, maxBuffer: 1 << 28 }).stdout;
    pack = blobKey(pk, 0o100644); if (!(pack in blobs)) blobs[pack] = { mode: 0o644, b64: pk.toString('base64') };
  }
  // files of the shipped control plane that this project does not have (a scenario removed them)
  /** @type {string[]} */ const deleted = [];
  /** @param {string} dir */
  const missing = (dir) => { for (const n of readdirSync(path.join(agentsSrc, dir))) { const rel = dir ? `${dir}/${n}` : n; if (rel === 'scripts') continue; const st = lstatSync(path.join(agentsSrc, rel)); if (st.isDirectory()) { if (existsSync(path.join(root, '.agents', rel))) missing(rel); else deleted.push(`.agents/${rel}`); } else if (!existsSync(path.join(root, '.agents', rel))) deleted.push(`.agents/${rel}`); } };
  missing('');
  // the remotes (their urls decide the platform): .git/config is not part of the snapshot
  /** @type {Record<string, string>} */ const remotes = {};
  for (const l of git(root, ['config', '--get-regexp', '^remote\\..*\\.url$']).stdout.toString('latin1').split('\n')) { const m = /^remote\.(.+)\.url (.*)$/.exec(l); if (m) remotes[m[1]] = m[2]; }
  // shipped control-plane files that the working tree has but the base commit does not (a fixture adds them after its commit), and the project's own exclude lines
  /** @type {string[]} */ const late = [];
  /** @param {string} dir */
  const lateWalk = (dir) => { for (const n of readdirSync(path.join(agentsSrc, dir))) { const rel = dir ? `${dir}/${n}` : n; if (rel === 'scripts') continue; const st = lstatSync(path.join(agentsSrc, rel)); if (st.isDirectory()) lateWalk(rel); else if (existsSync(path.join(root, '.agents', rel)) && readFileSync(path.join(root, '.agents', rel)).equals(readFileSync(path.join(agentsSrc, rel))) && git(root, ['cat-file', '-e', `${baseRef}:.agents/${rel}`]).status !== 0) late.push(`.agents/${rel}`); } };
  lateWalk('');
  const exFile = path.join(root, '.git/info/exclude');
  const exclude = existsSync(exFile) ? readFileSync(exFile, 'latin1').split('\n').filter((l) => l && !l.startsWith('#')) : [];
  const headRef = git(root, ['symbolic-ref', '--short', 'HEAD']);
  const branch = headRef.status === 0 ? headRef.stdout.toString('latin1').trim() : '';
  const state = { base, files, baseSha, ...(branch && branch !== 'main' ? { branch } : {}), ...(late.length ? { late } : {}), ...(exclude.length ? { exclude } : {}), ...(Object.keys(remotes).length ? { remotes } : {}), ...(pack ? { pack } : {}), ...(deleted.length ? { deleted } : {}), ...(dirs.length ? { dirs } : {}) };
  return { key: createHash('sha1').update(JSON.stringify(state)).digest('hex'), state };
}
