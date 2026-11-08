// @ts-check
// The identity of a built fixture tree: one line per entry (path, kind, permission bits, sha256 of the content) plus the git state (HEAD, every ref,
// the local configuration, hooks). `.git` internals that differ per run (index, logs, packed objects) are NOT read: equal commit hashes already pin
// every file, mode and message of the history. The directory's own absolute path (and its realpath) is replaced by `<ROOT>` in file contents,
// normalisation: a builder that names its target in a file (visual-proof's visual.json) must still give one digest on any machine, and the
// wall-clock stamps and hash chains the real control plane writes (risk-signals, proofline-lead) are masked when the caller says `volatile`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

const sha = (/** @type {Buffer | string} */ b) => createHash('sha256').update(b).digest('hex');

/** The control plane as `proofline init` installs it into a project. */
const INSTALLED = /(^|\/)\.agents\/(scripts|modes|templates|githooks)\/|(^|\/)\.agents\/(config\.yaml|ecosystems\.tsv)$/;

/** Wall-clock and hash-chain values the real control plane writes into a run (proofline-lead, risk-signals): masked when `volatile` is set. */
const VOLATILE = [[/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)/g, '<TS>'], [/ts=\S+ epoch=\d+/g, 'ts=T epoch=E'], [/(prev|sha256)=[0-9a-f]{64}/g, '$1=<H>'], [/@[0-9a-f]{40,64}\b/g, '@<H>'], [/\b[0-9a-f]{40}\b/g, '<H>'], [/\b1[67]\d{8}(\d{3})?\b/g, '<EPOCH>']];

/** @param {string} dir @param {{ volatile?: boolean, version?: string }} [o] `version`: the repository's version, masked as <VERSION> (a fixture that writes it, e.g. insights, must not change its digest at every release) @returns {string[]} sorted manifest lines */
export function manifest(dir, o = {}) {
  const roots = [...new Set([dir, path.resolve(dir), realpathSync(dir)])].sort((a, b) => b.length - a.length);
  const norm = (/** @type {Buffer} */ buf) => {
    let s = buf.toString('latin1');
    for (const r of roots) s = s.split(r).join('<ROOT>');
    if (o.version) s = s.split(o.version).join('<VERSION>');
    if (o.volatile) for (const [rx, to] of VOLATILE) s = s.replace(rx, /** @type {string} */ (to));
    return Buffer.from(s, 'latin1');
  };
  /** @type {string[]} */ const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (name === '.git') { out.push(...gitState(path.join(dir, rel), o).map((l) => (rel ? `${rel}/${l}` : l))); continue; }
      const st = lstatSync(path.join(dir, r));
      const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) out.push(`${r}\tlink\t${mode}\t${readlinkSync(path.join(dir, r))}`);
      else if (st.isDirectory()) { out.push(`${r}\tdir\t${mode}\t-`); walk(r); }
      else out.push(`${r}\tfile\t${mode}\t${sha(norm(readFileSync(path.join(dir, r))))}`);
    }
  };
  walk('');
  if (!o.volatile) return out;
  // a fixture that installs the control plane into a project (risk-signals, proofline-lead): the installed copies and the git commits that contain them change with
  // every edit of the control plane, so their content hashes are masked (the paths and modes stay); the project's own files are still hashed
  return out.map((l) => {
    const [p, kind, mode, h] = l.split('\t');
    if (kind === 'file' && INSTALLED.test(p)) return `${p}\t${kind}\t${mode}\t<installed copy>`;
    return l.replace(/\b[0-9a-f]{40}\b/g, '<H>');
  });
}

/** @param {string} dir @param {{ volatile?: boolean, version?: string }} o @returns {string[]} */
function gitState(dir, o) {
  const g = (/** @type {string[]} */ a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    return r.status === 0 ? r.stdout.trim() : `error:${r.status}`;
  };
  const lines = [`.git\tHEAD\t${g(['symbolic-ref', '-q', 'HEAD'])}\t${g(['rev-parse', '-q', '--verify', 'HEAD'])}`];
  for (const l of g(['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean)) lines.push(`.git\tref\t${l}`);
  // only what a builder sets: git itself adds platform keys at init (core.ignorecase, precomposeunicode, filemode, symlinks, ...)
  lines.push(`.git\tconfig\t${sha(g(['config', '--local', '--list']).split('\n').filter((l) => !/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)=/.test(l)).join('\n'))}`);
  lines.push(`.git\tstatus\t${sha(g(['status', '--porcelain', '--ignored']))}`);
  try { lines.push(`.git/info/exclude\tfile\t${sha(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('\n'))}`); } catch { /* none */ }
  lines.push(`.git\tstash\t${sha(g(['stash', 'list']))}`);
  const hooks = path.join(dir, '.git', 'hooks');
  try { for (const h of readdirSync(hooks).sort()) if (!h.endsWith('.sample')) lines.push(`.git/hooks/${h}\tfile\t${sha(readFileSync(path.join(hooks, h)))}`); } catch { /* no hooks folder */ }
  return lines;
}

/** @param {string} dir @param {{ volatile?: boolean, version?: string }} [o] @returns {string} one sha256 for the whole tree */
export const digest = (dir, o = {}) => sha(manifest(dir, o).join('\n'));
