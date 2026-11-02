// @ts-check
// ONE-TIME recording tools of the T2 port (temporary): a project snapshot with content-addressed blobs, shared by record.mjs and rec-call.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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

/** @param {string} root @param {string} dir @param {string[]} out */
function walk(root, dir, out) {
  for (const n of readdirSync(path.join(root, dir))) {
    const rel = dir ? `${dir}/${n}` : n;
    if (rel === '.git') continue;
    const st = lstatSync(path.join(root, rel));
    if (st.isDirectory()) walk(root, rel, out); else if (st.isFile()) out.push(rel);
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
  const y = path.join(root, '.agents/runs/LC/RUN.yaml');
  const baseSha = existsSync(y) ? ((/^ {2}base_sha: "?([0-9a-f]{40})"?/m.exec(readFileSync(y, 'latin1')) ?? [])[1] ?? '') : '';
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
    const mode = ent.startsWith('100755') ? 0o755 : 0o644;
    base[rel] = put(git(root, ['show', `${baseRef}:${rel}`]).stdout, mode);
  }
  /** @type {string[]} */ const all = [];
  walk(root, '', all);
  /** @type {Record<string, string>} */ const files = {};
  for (const rel of all) {
    if (rel.startsWith('.agents/')) {
      const rest = rel.slice(8);
      const keep = rel.startsWith('.agents/runs/') || rel.startsWith('.agents/local/') || rel === '.agents/.proofline-manifest'
        || (!rel.startsWith('.agents/scripts/') && (!existsSync(path.join(agentsSrc, rest)) || !readFileSync(path.join(root, rel)).equals(readFileSync(path.join(agentsSrc, rest)))));
      if (!keep) continue;
    }
    files[rel] = put(readFileSync(path.join(root, rel)), lstatSync(path.join(root, rel)).mode & 0o777);
  }
  const state = { base, files, baseSha };
  return { key: createHash('sha1').update(JSON.stringify(state)).digest('hex'), state };
}
