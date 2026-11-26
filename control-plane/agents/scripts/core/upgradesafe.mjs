// @ts-check
// The safe upgrade path (A371, issue 338 item U6): what `proofline upgrade` checks, saves and records around the file replacement of install.mjs, so that an upgrade
// can run while runs, a batch and worktrees are in flight. Four parts, none of which installs a tool, reads the network or keeps hidden state:
//   * the BUSY check: a specialist that runs (`.agents/local/submissions/*.started`), a write window that is open (`.agents/local/windows/*`) or a command that holds the
//     project lock (`.agents/local/locks/shared.lock`, the lock every locking command of the core takes first) refuse the upgrade and name what to wait for. Every tree is
//     looked at: the main tree and each batch worktree (`.agents/local/worktrees/<ID>`).
//   * the STATE FORMAT: a small integer, `STATE_FORMAT`, for the shape of everything proofline keeps in a project (run folders, ledgers, the files under `.agents/local`,
//     the config keys). The installed one is the manifest's `# state_format:` (absent: 1 for an install from 0.0.173 on, which is where the table starts). A format newer than
//     this version reads is refused (a downgrade); an older one is read unchanged when every step to this one is ADDITIVE (the table below says so); a step that is not
//     additive needs a migration, and none exists yet, so it is refused. Every change since 0.0.173 is additive (docs/concepts/upgrading.md lists them).
//   * the BACKUP of what an upgrade replaces, under `.agents/local/upgrade-backup/<old>-to-<new>/` (the last 2 are kept), and `--rollback`, which restores it.
//   * the LEDGER row `event=upgrade` per run that has a lifecycle ledger, so the run shows that it crossed an upgrade.
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { cfgMergeSafe } from './cfgcli.mjs';
import { configLines } from './config.mjs';
import { sha256, sha256File } from './hash.mjs';
import { ledgerAppend } from './lock.mjs';
import { runSections } from './records.mjs';
import { asciiLower } from './shellglob.mjs';

/** The state format of this version (a small integer, see the header). */
export const STATE_FORMAT = 1;
/** The first version the state format table covers: every installed version from here on has format 1 unless its manifest says otherwise. */
export const FORMAT_TABLE_START = '0.0.173';
/** The state format table: how a project that holds format N is read by a core that holds a higher one. `additive`: only files and keys were added, an absent one means its default, so the state is read unchanged. A step without `additive: true` needs a migration (none exists yet: the upgrade refuses it). */
export const STATE_FORMATS = Object.freeze({ 1: { since: FORMAT_TABLE_START, additive: true } });

export const BACKUP_DIR = '.agents/local/upgrade-backup';
const KEEP_BACKUPS = 2;
/** Files an upgrade may rewrite as a whole, saved when they exist (the plan names the others). */
const ALWAYS = ['.agents/config.yaml', '.agents/.proofline-manifest', '.claude/settings.json', '.codex/hooks.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore'];

/** @param {string} p */
const text = (p) => { try { return readFileSync(p, 'latin1'); } catch { return ''; } };
/** @param {string} p */
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** @param {string} p */
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
/** @param {string} p @returns {string[]} */
const names = (p) => { try { return readdirSync(p).sort(); } catch { return []; } };
/** @param {string} pid */
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'; } };

/** @param {string} a @param {string} b the dotted version compare: negative when A is older */
export function cmpVersion(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

// ---- the state format ---------------------------------------------------------------------------------------------------

/**
 * The state format an install holds: the manifest's `state_format`, else 1 for a version of the table's range, else 0 (before the table, or unknown).
 * @param {string | undefined} format the manifest's `# state_format:` @param {string} version the installed version, '' when unknown
 */
export function installedFormat(format, version) {
  if (format !== undefined && /^[0-9]+$/.test(format)) return Number(format);
  return version !== '' && cmpVersion(version, FORMAT_TABLE_START) >= 0 ? 1 : 0;
}

/**
 * Can this version read state of the installed format? `same`, `additive` (read unchanged), `newer` (a downgrade: refused), `unknown` (no verified path: refused while state is open).
 * @param {number} installed @param {number} [current]
 * @returns {{ verdict: 'same' | 'additive' | 'newer' | 'unknown', text: string }}
 */
export function compat(installed, current = STATE_FORMAT) {
  if (installed > current) return { verdict: 'newer', text: `state format ${installed} is newer than the ${current} this version reads: this would be a downgrade` };
  if (installed === current) return { verdict: 'same', text: 'compatible' };
  /** @type {Record<number, { since: string, additive?: boolean }>} */ const table = STATE_FORMATS;
  if (installed < 1 || !table[installed]) return { verdict: 'unknown', text: `the installed version is from before the state format table starts (${FORMAT_TABLE_START}); no verified path reads its state` };
  for (let n = installed + 1; n <= current; n++) if (table[n]?.additive !== true) return { verdict: 'unknown', text: `the step to state format ${n} needs a migration, and this version ships none` };
  return { verdict: 'additive', text: 'compatible: additive' };
}

// ---- what is in flight --------------------------------------------------------------------------------------------------

/** @typedef {{ tree: string, name: string, id: string, dir: string, state: string, handoff: string, gates: number, ledger: boolean, frozen: boolean, open: boolean }} RunInfo */
/** @typedef {{ runs: RunInfo[], worktrees: string[], batch: boolean, busy: string[] }} Scan */

/** The trees that hold state: the project root and each batch worktree. @param {string} root @returns {{ dir: string, name: string }[]} */
function trees(root) {
  const wt = `${root}/.agents/local/worktrees`;
  return [{ dir: root, name: 'main' }, ...names(wt).filter((n) => isDir(`${wt}/${n}`)).map((n) => ({ dir: `${wt}/${n}`, name: n }))];
}

/** A lock folder's holder: `held` (a live pid, or a folder without a pid file yet), `stale` (a dead pid). @param {string} lock */
export function lockHolder(lock) {
  if (!isDir(lock)) return { held: false, stale: false, pid: '' };
  const pid = text(`${lock}/pid`).replace(/\n+$/, '');
  if (!/^[0-9]+$/.test(pid)) return { held: true, stale: false, pid: '' };
  return alive(pid) ? { held: true, stale: false, pid } : { held: false, stale: true, pid };
}

/**
 * Everything in flight under ROOT, read only: the runs of every tree, the batch, the worktrees and what makes an upgrade unsafe right now (a running specialist, an open write
 * window, a live lock other than the project lock the upgrade takes itself).
 * @param {string} root @returns {Scan}
 */
export function scan(root) {
  /** @type {RunInfo[]} */ const runs = []; /** @type {string[]} */ const busy = [];
  const all = trees(root);
  for (const t of all) {
    for (const id of names(`${t.dir}/.agents/runs`)) {
      const dir = `${t.dir}/.agents/runs/${id}`;
      if (id.startsWith('.') || !isFile(`${dir}/RUN.yaml`)) continue;
      const rows = runSections(text(`${dir}/RUN.yaml`));
      /** @param {string} k */ const v = (k) => rows.find((r) => r.startsWith(`${k}=`))?.slice(k.length + 1) ?? '';
      const state = v('execution.state');
      runs.push({ tree: t.dir, name: t.name, id, dir, state, handoff: v('handoff.state'), gates: names(`${dir}/gates`).filter((n) => n.endsWith('.yaml')).length,
        ledger: rows.some((r) => r.startsWith('lifecycle_gates.required=')) && text(`${dir}/LEDGER.log`) !== '', frozen: !['', 'PENDING'].includes(v('freeze.plan_sha256')),
        open: state !== 'FAILED' && state !== 'BLOCKED' });
    }
    const sub = `${t.dir}/.agents/local/submissions`;
    for (const n of names(sub).filter((x) => x.endsWith('.started'))) {
      const token = n.slice(0, -'.started'.length);
      const m = /^([A-Za-z0-9_-]+) ([a-z_]+)\n?$/.exec(text(`${sub}/${token}.run`));
      busy.push(`specialist running: ${m ? `${m[2]} of run ${m[1]}` : 'a specialist'} (${token}); wait for its result`);
    }
    const win = `${t.dir}/.agents/local/windows`;
    for (const token of names(win).filter((n) => isFile(`${win}/${n}`))) {
      const m = /^([A-Za-z0-9_-]+) ([a-z_]+)\n?$/.exec(text(`${t.dir}/.agents/local/submissions/${token}.run`));
      busy.push(`write window open: ${token}${m ? ` (run ${m[1]})` : ''}; it closes when the specialist stops, wait for it`);
    }
    const locks = [`${t.dir}/.agents/local/locks/tree.lock`, ...(t.dir === root ? [`${root}/.agents/local/.lock`] : [])];
    for (const l of locks) { const h = lockHolder(l); if (h.held) busy.push(`a control-plane command holds the lock (pid ${h.pid || 'unknown'}): ${path.relative(root, l)}; wait for it to finish`); }
    for (const id of names(`${t.dir}/.agents/runs`)) {
      const h = lockHolder(`${t.dir}/.agents/runs/${id}/.lock`);
      if (h.held) busy.push(`a control-plane command holds the lock (pid ${h.pid || 'unknown'}): ${path.relative(root, `${t.dir}/.agents/runs/${id}/.lock`)}; wait for it to finish`);
    }
  }
  return { runs, worktrees: all.slice(1).map((t) => t.name), batch: isFile(`${root}/.agents/local/batch/SUMMARY.md`) || isFile(`${root}/.agents/local/batch/order.tsv`), busy };
}

/** The project lock, the one every locking command takes first. Held while the upgrade writes, so a command that starts meanwhile waits. @param {string} root @returns {{ release: () => void } | { busy: string }} */
export function takeLock(root) {
  const lock = `${root}/.agents/local/locks/shared.lock`;
  try { mkdirSync(`${root}/.agents/local/locks`, { recursive: true }); } catch { return { busy: `cannot create .agents/local/locks (not writable)` }; }
  for (let i = 0; i < 2; i++) {
    try { mkdirSync(lock); } catch {
      const h = lockHolder(lock);
      if (h.stale) { rmSync(`${lock}/pid`, { force: true }); try { rmdirSync(lock); } catch { /* taken by another */ } continue; }
      return { busy: `a control-plane command holds the lock (pid ${h.pid || 'unknown'}): .agents/local/locks/shared.lock; wait for it to finish` };
    }
    writeFileSync(`${lock}/pid`, `${process.pid}\n`);
    return { release: () => { rmSync(`${lock}/pid`, { force: true }); try { rmdirSync(lock); } catch { /* not empty */ } } };
  }
  return { busy: 'a control-plane command holds the lock: .agents/local/locks/shared.lock; wait for it to finish' };
}

/** Why the upgrade must not run now (empty: it may). @param {Scan} s @param {{ from: string, to: string, formatText: string | undefined }} v @returns {string[]} */
export function refusals(s, v) {
  /** @type {string[]} */ const out = [...s.busy];
  const f = compat(installedFormat(v.formatText, v.from));
  const open = s.runs.filter((r) => r.open);
  if (f.verdict === 'newer') out.push(f.text);
  else if (f.verdict === 'unknown' && (open.length > 0 || s.batch)) out.push(f.text);
  if (v.from !== '' && cmpVersion(v.from, v.to) > 0 && (open.length > 0 || s.batch)) out.push(`the installed version ${v.from} is newer than ${v.to} and runs are open: a downgrade can leave them in a state the older core does not read (proofline upgrade --rollback undoes the last upgrade)`);
  return out;
}

// ---- config keys ----------------------------------------------------------------------------------------------------------

/** @param {string[]} lines */
const keysOf = (lines) => new Set(lines.map((l) => l.slice(0, l.indexOf('='))));

/** The config keys the merge would add, and the keys of the shipped default it does not merge (the built-in default applies). @param {string} cur @param {string} def @returns {{ added: string[], notMerged: string[] }} */
export function configDelta(cur, def) {
  const have = keysOf(configLines(cur));
  const merged = keysOf(configLines(cfgMergeSafe(cur, def).text));
  const want = [...keysOf(configLines(def))];
  return { added: [...merged].filter((k) => !have.has(k) && k !== 'proofline_version'), notMerged: want.filter((k) => !merged.has(k)) };
}

/** Do the changes alter what a frozen run's hashes read (the risk, performance, security and contract config lines; the modes and ecosystems files)? @param {string[]} added @param {string[]} files @returns {string} '' when not */
export function freezeImpact(added, files) {
  const keys = added.filter((k) => /^(risk|performance|security|contract)\./.test(k) && !/^risk\.(log_sensitive|ecosystems)(\.|$)/.test(k));
  const f = files.filter((p) => /^\.agents\/(modes\/|ecosystems\.)/.test(p));
  return keys.length + f.length === 0 ? '' : `the freeze of a frozen run binds ${[...keys.length > 0 ? [`the risk configuration (new keys: ${keys.slice(0, 4).join(', ')})`] : [], ...f.length > 0 ? [`the files ${f.slice(0, 3).join(', ')}`] : []].join(' and ')}; the upgrade would change it`;
}

// ---- the report of --check ------------------------------------------------------------------------------------------------

/** @param {string[]} l @param {number} n */
const some = (l, n) => `${l.slice(0, n).join(', ')}${l.length > n ? `, and ${l.length - n} more` : ''}`;

/**
 * The lines `upgrade --check` prints before the plan.
 * @param {Scan} s @param {{ from: string, to: string, formatText: string | undefined, delta: { added: string[], notMerged: string[] }, refuse: string[] }} v
 */
export function checkLines(s, v) {
  const fmt = installedFormat(v.formatText, v.from);
  const f = compat(fmt);
  const open = s.runs.filter((r) => r.open);
  /** @type {string[]} */ const out = [];
  out.push(`upgrade --check: ${v.from || 'unknown'} -> ${v.to}`);
  out.push(`  state format: installed ${fmt}, this version ${STATE_FORMAT} (${f.verdict === 'newer' || f.verdict === 'unknown' ? f.text : f.text})`);
  out.push(`  open runs: ${open.length === 0 ? 'none' : some(open.map((r) => `${r.id} (${r.state || '?'}${r.name !== 'main' ? `, worktree ${r.name}` : ''})`), 8)}`);
  out.push(`  batch: ${s.batch ? 'active' : 'none'}; worktrees: ${s.worktrees.length === 0 ? 'none' : some(s.worktrees, 8)}`);
  const withGates = open.filter((r) => r.gates > 0).map((r) => r.id);
  if (withGates.length > 0) out.push(`  gate results recorded by the installed core: ${some(withGates, 8)} (informational: nothing is re-run; gates stay bound to the plan hash and the tree)`);
  if (v.delta.added.length > 0) out.push(`  config keys that would be added: ${v.delta.added.length}: ${some(v.delta.added, 12)} (your values are never changed)`);
  if (v.delta.notMerged.length > 0) out.push(`  config keys the merge does not add (the built-in default applies; add them by hand to change them): ${some(v.delta.notMerged, 12)}`);
  if (v.refuse.length === 0) out.push('  nothing is running: the upgrade would go ahead');
  else { out.push('  the upgrade would be refused:'); for (const r of v.refuse) out.push(`    - ${r}`); }
  return out;
}

// ---- backup ---------------------------------------------------------------------------------------------------------------

/** @param {string} dir @returns {string[]} the files under DIR as paths relative to it */
function walkRel(dir) {
  /** @type {string[]} */ const out = [];
  /** @param {string} d @param {string} pre */
  const rec = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) rec(`${d}/${e.name}`, `${pre}${e.name}/`); else if (e.isFile()) out.push(`${pre}${e.name}`); } };
  try { rec(dir, ''); } catch { /* none */ }
  return out;
}

/** The sha256 of a regular file that is not a link, else null. @param {string} f */
function shaOf(f) { try { return lstatSync(f).isFile() ? sha256File(f) : null; } catch { return null; } }

/** The paths an upgrade plan names (files that exist, or will). @param {Array<[string, string]>} plan */
function plannedPaths(plan) {
  /** @type {Set<string>} */ const s = new Set(ALWAYS);
  for (const [act, t] of plan) {
    if (!['update', 'removed', 'new', 'merged', 'conflict'].includes(act)) continue;
    const p = t.split(' ')[0];
    if (p !== '' && !p.includes('..') && !path.isAbsolute(p) && p !== 'git') { s.add(p); if (act === 'conflict') s.add(`${p}.proofline-new`); }
  }
  return [...s];
}

/** @typedef {{ dir: string, before: Map<string, string | null>, cands: Set<string> }} Backup */

/**
 * Save every file the upgrade may replace, before it writes: copies under `<dir>/files/` and a first `UPGRADE.tsv` (marked incomplete until `finishBackup`).
 * @param {string} root @param {{ from: string, to: string, formatText: string | undefined, plan: Array<[string, string]>, runs: RunInfo[] }} v @returns {Backup}
 */
export function startBackup(root, v) {
  mkdirSync(`${root}/${BACKUP_DIR}`, { recursive: true });
  let dir = `${root}/${BACKUP_DIR}/${v.from || 'unknown'}-to-${v.to}`;
  for (let i = 2; existsSync(dir); i++) dir = `${root}/${BACKUP_DIR}/${v.from || 'unknown'}-to-${v.to}.${i}`;
  const cands = new Set(plannedPaths(v.plan));
  for (const r of walkRel(`${root}/.agents/hooks`)) cands.add(`.agents/hooks/${r}`);
  /** @type {Map<string, string | null>} */ const before = new Map();
  for (const rel of cands) {
    const sha = shaOf(`${root}/${rel}`);
    before.set(rel, sha);
    if (sha !== null) { mkdirSync(path.dirname(`${dir}/files/${rel}`), { recursive: true }); copyFileSync(`${root}/${rel}`, `${dir}/files/${rel}`); }
  }
  const seq = 1 + Math.max(0, ...names(`${root}/${BACKUP_DIR}`).map((n) => Number(/^seq=([0-9]+)$/m.exec(text(`${root}/${BACKUP_DIR}/${n}/UPGRADE.tsv`))?.[1] ?? 0)));
  writeFileSync(`${dir}/UPGRADE.tsv`, header(v, seq, true));
  return { dir, before, cands };
}

/** @param {{ from: string, to: string, runs: RunInfo[] }} v @param {number} seq @param {boolean} incomplete */
function header(v, seq, incomplete) {
  const ids = v.runs.map((r) => `${r.name}:${r.id}`).join(',');
  return `# proofline upgrade backup (proofline upgrade --rollback restores it)\nold=${v.from}\nnew=${v.to}\nseq=${seq}\nruns=${ids}\n${incomplete ? 'incomplete=yes\n' : ''}`;
}

/** After the upgrade wrote: the rows (`replaced`, `removed`, `new` with the sha256 of the file now), the copies of unchanged files dropped, older backups pruned. @param {string} root @param {Backup} b @param {{ from: string, to: string, runs: RunInfo[] }} v @returns {number} files kept in the backup */
export function finishBackup(root, b, v) {
  const cands = new Set(b.cands);
  for (const r of walkRel(`${root}/.agents/hooks`)) cands.add(`.agents/hooks/${r}`);
  /** @type {string[]} */ const rows = [];
  let kept = 0;
  for (const rel of [...cands].sort()) {
    const was = b.before.get(rel) ?? null; const now = shaOf(`${root}/${rel}`);
    if (was === now) { rmSync(`${b.dir}/files/${rel}`, { force: true }); continue; }
    if (was === null) rows.push(`new\t${rel}\t${now}\t-`);
    else { rows.push(`${now === null ? 'removed' : 'replaced'}\t${rel}\t${now ?? '-'}\t${was}`); kept++; }
  }
  const seq = Number(/^seq=([0-9]+)$/m.exec(text(`${b.dir}/UPGRADE.tsv`))?.[1] ?? 1);
  writeFileSync(`${b.dir}/UPGRADE.tsv`, `${header(v, seq, false)}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`);
  const all = names(`${root}/${BACKUP_DIR}`).map((n) => ({ n, seq: Number(/^seq=([0-9]+)$/m.exec(text(`${root}/${BACKUP_DIR}/${n}/UPGRADE.tsv`))?.[1] ?? 0) })).sort((x, y) => y.seq - x.seq);
  for (const old of all.slice(KEEP_BACKUPS)) rmSync(`${root}/${BACKUP_DIR}/${old.n}`, { recursive: true, force: true });
  return kept;
}

// ---- the ledger -------------------------------------------------------------------------------------------------------------

/** One `upgrade` row in the ledger of every run that has one (the lifecycle ledger of a run with lifecycle_gates). @param {RunInfo[]} runs @param {string} detail @returns {string[]} the ids written */
export function ledgerRows(runs, detail) {
  /** @type {string[]} */ const done = [];
  for (const r of runs) {
    if (!r.open || !r.ledger) continue;
    try { ledgerAppend(r.dir, 'user', 'upgrade', '-', '-', detail); done.push(r.id); } catch { /* a run that cannot take a row: the upgrade itself is not undone for it */ }
  }
  return done;
}

// ---- rollback ---------------------------------------------------------------------------------------------------------------

/** @typedef {{ name: string, seq: number, dir: string, old: string, now: string, runs: string[], done: boolean, rows: Array<[string, string, string, string]> }} BackupInfo */

/** @param {string} root @returns {BackupInfo | null} the newest backup */
export function newestBackup(root) {
  /** @type {BackupInfo | null} */ let best = null;
  for (const n of names(`${root}/${BACKUP_DIR}`)) {
    const dir = `${root}/${BACKUP_DIR}/${n}`; const t = text(`${dir}/UPGRADE.tsv`);
    if (t === '') continue;
    /** @param {string} k */ const g = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(t)?.[1] ?? '';
    const seq = Number(g('seq')) || 0;
    if (best !== null && best.seq >= seq) continue;
    best = { name: n, seq, dir, old: g('old'), now: g('new'), runs: g('runs').split(',').filter((x) => x !== ''), done: /^rolled_back=yes$/m.test(t),
      rows: t.split('\n').filter((l) => /^(replaced|removed|new)\t/.test(l)).map((l) => /** @type {[string, string, string, string]} */ (l.split('\t'))) };
  }
  return best;
}

const HEX = /^[0-9a-f]{64}$/;
/** Test seam: a function run once after the rows are validated and before the first write (a test swaps a backup copy there). */
export const seams = { /** @type {(() => void) | null} */ afterValidate: null };
/** Paths an upgrade never writes and a restore never touches: the runs (their ledgers are sealed evidence), the local state and git's own folder. */
const NEVER = /^(\.git|\.agents\/runs|\.agents\/local)(\/|$)/;
/** NEVER on every spelling that one file can have on a case-insensitive or normalising file system: ASCII lower case, Unicode NFC and NFD. @param {string} rel */
const never = (rel) => [rel, rel.normalize('NFC'), rel.normalize('NFD')].some((x) => NEVER.test(asciiLower(x)));

/** A plain relative path: no empty, `.` or `..` component, no backslash, no NUL, not absolute. @param {string} rel */
function relPlain(rel) { return rel !== '' && !path.isAbsolute(rel) && !rel.includes('\\') && !rel.includes('\0') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..'); }

/** Is REL, or any folder above it under BASE, a symbolic link? (A component that does not exist is fine.) @param {string} base @param {string} rel */
function viaLink(base, rel) {
  let cur = base;
  for (const part of rel.split('/')) {
    cur = `${cur}/${part}`;
    try { if (lstatSync(cur).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

/** Does ROOT/REL, resolved through the file system (the real case of each name), lie outside the project or in a folder a restore never touches? Anything that cannot be resolved counts as yes. @param {string} root @param {string} rel */
function resolvesIntoNever(root, rel) {
  try {
    const rr = realpathSync.native(root);
    let cur = `${root}/${rel}`; let rest = '';
    while (!existsSync(cur)) { rest = `/${path.basename(cur)}${rest}`; const up = path.dirname(cur); if (up === cur) break; cur = up; }
    const inside = path.relative(rr, realpathSync.native(cur) + rest).split(path.sep).join('/');
    return inside.startsWith('..') || path.isAbsolute(inside) || never(inside);
  } catch { return true; }
}

/** The paths of a manifest file (`<sha256>  <path>` rows). @param {string} file */
function manifestPaths(file) {
  /** @type {string[]} */ const out = [];
  for (const l of text(file).split('\n')) { if (l.startsWith('#')) continue; const m = /^\S+[ \t]+(.*)$/.exec(l); if (m) out.push(m[1]); }
  return out;
}

/** The hook files this version ships, as installed paths (`.agents/hooks/<file>`): the hook tree is written as a whole and is not in the manifest, so the plugin's own tree is the list. @param {string} plHome */
function shippedHooks(plHome) {
  /** @type {Set<string>} */ const s = new Set();
  const base = `${plHome}/adapters/claude/hooks`;
  /** @param {string} d @param {string} pre */
  const rec = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) rec(`${d}/${e.name}`, `${pre}${e.name}/`); else if (e.isFile()) s.add(`.agents/hooks/${pre}${e.name}`); } };
  try { for (const f of ['proofline-hook.mjs', 'command-scan.mjs']) if (isFile(`${base}/${f}`)) s.add(`.agents/hooks/${f}`); for (const d of ['events', 'guards', 'lib']) rec(`${base}/${d}`, `${d}/`); } catch { /* none */ }
  return s;
}

/**
 * The paths a rollback may touch, from sources a change to the backup folder cannot reach: the fixed list of files an upgrade rewrites as a whole, the paths of the CURRENT installed manifest (the
 * one the upgrade wrote) and their `.proofline-new` copies, and the hook files this plugin ships. The manifest copy inside the backup is never read to authorise anything.
 * @param {string} root @param {string} plHome
 */
function installSet(root, plHome) {
  const s = new Set([...ALWAYS, ...manifestPaths(`${root}/.agents/.proofline-manifest`)]);
  const hooks = shippedHooks(plHome);
  return { allowed: (/** @type {string} */ rel) => s.has(rel) || (rel.endsWith('.proofline-new') && s.has(rel.slice(0, -'.proofline-new'.length))) || hooks.has(rel) };
}

/**
 * Restore the newest backup. Every row is validated first and one bad row refuses the whole rollback (nothing is written): the path is a plain relative path of the install set (the fixed list, the
 * current manifest, the shipped hook files; never under .agents/runs, .agents/local or .git in any spelling or after resolving it), neither it nor the backup copy sits on a symbolic link, the destination
 * is a regular file or absent, and the backup copy still has the sha256 recorded when it was made (that protects against accidental damage and a file changed since, not against someone who can edit the
 * whole backup folder: the install set is the anchor). Then a file is replaced or deleted only while it still holds what the upgrade wrote; one changed since is kept and listed. A failure half way leaves a
 * `rollback_failed` line in UPGRADE.tsv and is reported. Refuses (returns the reason) when it was restored, when the installed version is not the one it upgraded to, or when a run was started since.
 * @param {string} root @param {string} installed the installed version @param {Scan} s @param {string} plHome
 * @returns {{ refuse: string } | { b: BackupInfo, restored: string[], removed: string[], kept: string[], unrestored: string[] }}
 */
export function rollback(root, installed, s, plHome) {
  const b = newestBackup(root);
  if (b === null) return { refuse: `no upgrade backup under ${BACKUP_DIR}; nothing to restore` };
  if (b.done) return { refuse: `the newest backup (${b.name}) is already restored; nothing to restore` };
  if (installed !== b.now) return { refuse: `the installed version is ${installed || 'unknown'}, not ${b.now} (the version the backup ${b.name} upgraded to); nothing was restored` };
  const known = new Set(b.runs);
  const later = s.runs.find((r) => !known.has(`${r.name}:${r.id}`));
  if (later) return { refuse: `run ${later.id} was started after the upgrade with ${b.now}: rolling back would leave it on state the older core never wrote. Finish or fail that run first; nothing was restored` };
  const { allowed } = installSet(root, plHome);
  /** @type {string[]} */ const unrestored = [];
  for (const [kind, rel, after, before] of b.rows) {
    if (!['replaced', 'removed', 'new'].includes(kind) || !relPlain(rel) || never(rel) || !allowed(rel)) {
      // a hook file the old version had and this one does not ship cannot be vouched for: it is listed, not restored
      if (kind === 'removed' && relPlain(rel) && rel.startsWith('.agents/hooks/') && !never(rel)) { unrestored.push(rel); continue; }
      return { refuse: `a row of ${b.name}/UPGRADE.tsv is not a path this upgrade installed: ${rel}; nothing was restored` };
    }
    if (viaLink(root, rel)) return { refuse: `${rel} is, or sits under, a symbolic link; nothing was restored` };
    if (resolvesIntoNever(root, rel)) return { refuse: `${rel} resolves into .agents/runs, .agents/local, .git or outside the project; nothing was restored` };
    try { if (!lstatSync(`${root}/${rel}`).isFile()) return { refuse: `${rel} is not a regular file; nothing was restored` }; } catch { /* absent: fine */ }
    if (kind === 'new') { if (!HEX.test(after ?? '')) return { refuse: `the row for ${rel} has no recorded sha256; nothing was restored` }; continue; }
    if (!HEX.test(before ?? '') || (kind === 'replaced' && after !== '-' && !HEX.test(after ?? ''))) return { refuse: `the row for ${rel} has no recorded sha256; nothing was restored` };
    const src = `${b.dir}/files/${rel}`;
    if (viaLink(`${b.dir}/files`, rel) || shaOf(src) === null) return { refuse: `backup copy ${rel} is not a plain file (or sits under a link); nothing was restored` };
    if (shaOf(src) !== before) return { refuse: `backup copy ${rel} does not match the sha256 recorded when it was made; nothing was restored` };
  }
  seams.afterValidate?.();
  /** @type {string[]} */ const restored = []; /** @type {string[]} */ const removed = []; /** @type {string[]} */ const kept = [];
  try {
    for (const [kind, rel, after, before] of b.rows.filter((r) => !unrestored.includes(r[1]))) {
      const dst = `${root}/${rel}`;
      const cur = shaOf(dst);
      if (kind === 'new') { if (cur === null) continue; if (cur === after) { rmSync(dst, { force: true }); removed.push(rel); } else kept.push(rel); continue; }
      if ((kind === 'removed' && cur !== null) || (kind === 'replaced' && cur !== null && after !== '-' && cur !== after)) { kept.push(rel); continue; }
      const src = `${b.dir}/files/${rel}`;
      mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.proofline-restore-${randomBytes(6).toString('hex')}`;
      try {
        // the copy was checked at validation and could have been swapped since: look again, open without following a link, hash the bytes that were read
        if (viaLink(`${b.dir}/files`, rel) || !lstatSync(src).isFile()) throw new Error(`backup copy ${rel} is not a plain file (a link or something else took its place)`);
        const fd = openSync(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes; let mode;
        try { const st = fstatSync(fd); if (!st.isFile()) throw new Error(`backup copy ${rel} is not a plain file`); mode = st.mode & 0o7777; bytes = readFileSync(fd); } finally { closeSync(fd); }
        if (sha256(bytes) !== before) throw new Error(`backup copy ${rel} changed after it was checked`);
        writeFileSync(tmp, bytes, { flag: 'wx', mode });
        renameSync(tmp, dst);
      } catch (e) { rmSync(tmp, { force: true }); throw e; }
      restored.push(rel);
    }
  } catch (e) {
    appendLine(b, `rollback_failed=${(/** @type {Error} */ (e).message).replace(/[\t\n]/g, ' ').slice(0, 200)} restored=${restored.length}`);
    return { refuse: `the rollback stopped after ${restored.length} file(s) restored and ${removed.length} removed (${/** @type {Error} */ (e).message}); the backup ${b.name} is kept and marked in UPGRADE.tsv, fix the cause and run proofline upgrade --rollback again` };
  }
  appendLine(b, 'rolled_back=yes');
  return { b, restored, removed, kept, unrestored };
}

/** @param {BackupInfo} b @param {string} line */
function appendLine(b, line) {
  const f = `${b.dir}/UPGRADE.tsv`;
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, `${text(f).replace(/\n*$/, '\n')}${line}\n`);
  renameSync(tmp, f);
}
