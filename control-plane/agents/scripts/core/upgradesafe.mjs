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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cfgMergeNew } from './cfgcli.mjs';
import { configLines } from './config.mjs';
import { sha256File } from './hash.mjs';
import { ledgerAppend } from './lock.mjs';
import { runSections } from './records.mjs';

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
  const merged = keysOf(configLines(cfgMergeNew(cur, def)));
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
    if (was === null) rows.push(`new\t${rel}\t${now}`);
    else { rows.push(`${now === null ? 'removed' : 'replaced'}\t${rel}\t${now ?? '-'}`); kept++; }
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

/** @typedef {{ name: string, seq: number, dir: string, old: string, now: string, runs: string[], done: boolean, rows: Array<[string, string, string]> }} BackupInfo */

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
      rows: t.split('\n').filter((l) => /^(replaced|removed|new)\t/.test(l)).map((l) => /** @type {[string, string, string]} */ (l.split('\t'))) };
  }
  return best;
}

/**
 * Restore the newest backup. Refuses (returns the reason) when it was restored, when the installed version is not the one it upgraded to, or when a run was started since.
 * A file changed after the upgrade is kept and listed. @param {string} root @param {string} installed the installed version @param {Scan} s
 * @returns {{ refuse: string } | { b: BackupInfo, restored: string[], removed: string[], kept: string[] }}
 */
export function rollback(root, installed, s) {
  const b = newestBackup(root);
  if (b === null) return { refuse: `no upgrade backup under ${BACKUP_DIR}; nothing to restore` };
  if (b.done) return { refuse: `the newest backup (${b.name}) is already restored; nothing to restore` };
  if (installed !== b.now) return { refuse: `the installed version is ${installed || 'unknown'}, not ${b.now} (the version the backup ${b.name} upgraded to); nothing was restored` };
  const known = new Set(b.runs);
  const later = s.runs.find((r) => !known.has(`${r.name}:${r.id}`));
  if (later) return { refuse: `run ${later.id} was started after the upgrade with ${b.now}: rolling back would leave it on state the older core never wrote. Finish or fail that run first; nothing was restored` };
  /** @type {string[]} */ const restored = []; /** @type {string[]} */ const removed = []; /** @type {string[]} */ const kept = [];
  for (const [kind, rel, after] of b.rows) {
    const dst = `${root}/${rel}`;
    const cur = shaOf(dst);
    if (kind !== 'removed' && cur !== null && after !== '-' && cur !== after) { kept.push(rel); continue; }
    if (kind === 'removed' && cur !== null) { kept.push(rel); continue; }
    if (kind === 'new') { if (cur !== null) { rmSync(dst, { force: true }); removed.push(rel); } continue; }
    const src = `${b.dir}/files/${rel}`;
    if (!isFile(src)) { kept.push(rel); continue; }
    mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.proofline-restore`;
    copyFileSync(src, tmp);
    try { chmodSync(tmp, statSync(src).mode & 0o7777); } catch { /* mode as copied */ }
    renameSync(tmp, dst);
    restored.push(rel);
  }
  appendDone(b);
  return { b, restored, removed, kept };
}

/** @param {BackupInfo} b */
function appendDone(b) {
  const f = `${b.dir}/UPGRADE.tsv`;
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, `${text(f).replace(/\n*$/, '\n')}rolled_back=yes\n`);
  renameSync(tmp, f);
}
