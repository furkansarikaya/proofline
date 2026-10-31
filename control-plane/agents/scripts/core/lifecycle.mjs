// @ts-check
// Stage 2, package C2: the pieces of the verify-* family and `freshness` that read or move the run's own bookkeeping (agent.sh 0.0.41): the
// task branch rule, RUN.yaml writes (`set_run_value`), the optional ledger line (`ledger_if`), the task-source contract hash, the control
// plane range tests behind `base_moved_control_only` and the run folder walk of `validate_control_artifacts`. Every function keeps the
// message text and the order of its shell original.
import { lstatSync, opendirSync, renameSync, writeFileSync } from 'node:fs';
import { BridgeToShell, fail } from './errors.mjs';
import { git, headSha, isAncestor, objectExists, show } from './git.mjs';
import { sha256 } from './hash.mjs';
import { ledgerAppend } from './ledger.mjs';
import { WS, authorizedPath, fileText, gatesEnforced, ledgerLines, planScope, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import { isFile } from './paths.mjs';
import { ciChainOk, knownControlArtifact, lifecycleFolderStatus, runDir } from './runs.mjs';
import { blockOnlyText, inKnowledgeScope, installedControlPath, isBlockFile, stripProoflineBlock } from './scope.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `enforce_task_branch ID` (GIT.md): the run's own branch is checked out. @param {Context} ctx @param {string} id */
export function enforceTaskBranch(ctx, id) {
  const dir = runDir(ctx, id);
  if (!sectionKeyPresent(ctx, dir, 'repository', 'task_branch')) return;
  const expected = sectionValue(ctx, dir, 'repository', 'task_branch');
  if (expected === '' || expected === 'PENDING') fail(`task branch not established for ${id}; run 'agent.sh branch ${id}' first`);
  const current = git(ctx, ['branch', '--show-current']).out.replace(/\n+$/, '');
  if (current === '') fail(`detached HEAD: expected task branch ${expected} for ${id}`);
  if (current !== expected) fail(`wrong git branch for ${id}: expected ${expected}, currently on ${current}`);
}

/**
 * `set_run_value ID SECTION KEY VALUE`: every `  KEY:` line of the section becomes `  KEY: "VALUE"` (awk, a temp file, then a rename).
 * @param {Context} ctx @param {string} id @param {string} section @param {string} key @param {string} value
 */
export function setRunValue(ctx, id, section, key, value) {
  const dir = runDir(ctx, id);
  const file = `${dir}/RUN.yaml`;
  const text = fileText(ctx, file);
  if (text === null) throw new BridgeToShell('RUN.yaml is not readable');
  if (value.includes('\\')) throw new BridgeToShell('awk -v reads backslash escapes');
  let inside = false;
  let found = false;
  const re = new RegExp(`^  ${key}:`);
  const out = [];
  for (const line of textLines(text)) {
    if (line === `${section}:`) { inside = true; out.push(line); continue; }
    if (inside && new RegExp(`^[^ \\t\\n\\v\\f\\r#]`).test(line)) inside = false;
    if (inside && re.test(line)) { out.push(`  ${key}: "${value}"`); found = true; continue; }
    out.push(line);
  }
  if (!found) fail(`RUN.yaml has no ${section}.${key} to set`);
  const tmp = `${dir}/RUN.yaml.tmp`;
  writeFileSync(tmp, Buffer.from(`${out.join('\n')}\n`, 'latin1'));
  renameSync(tmp, file);
  ctx.forget('file:');
  ctx.forget('plan-scope:');
}

/**
 * `ledger_if ID EVENT FROM TO DETAIL`: one ledger line when the run enforces the lifecycle gates.
 * @param {Context} ctx @param {string} id @param {string} event @param {string} from @param {string} to @param {string} detail
 */
export function ledgerIf(ctx, id, event, from, to, detail) {
  const dir = runDir(ctx, id);
  if (id === '-' || !gatesEnforced(ctx, dir)) return;
  ledgerAppend(dir, ctx.role, event, from, to, detail);
  ctx.forget('file:');
}

// ---- the task-source contract -------------------------------------------------------------------------------------------------

const SB_KEYS = 'run type class stage event updated branch start_commit runtime session question answer park failure pr ci delivered_commit estimate duration tokens look_at known_issues'.split(' ');
const reBlank = new RegExp(`^${WS}*$`);
const reStatusKey = new RegExp(`^- (${SB_KEYS.join('|')}): `);

/** `local_task_source_run ID` @param {Context} ctx @param {string} id */
export function localTaskSourceRun(ctx, id) { return sectionValue(ctx, runDir(ctx, id), 'task_source', 'type') === 'local_markdown'; }

/**
 * `task_source_contract_hash ID FILE`: the task file without the status block and the completion report block the control plane writes and
 * without the Status value, its trailing blank lines dropped.
 * @param {Context} ctx @param {string} id @param {string} file
 */
export function taskSourceContractHash(ctx, id, file) {
  const text = fileText(ctx, file);
  if (text === null) throw new BridgeToShell('task source is not readable');
  const line = textLines(text);
  const nr = line.length;
  const begin = `<!-- COMPLETION-REPORT:BEGIN:${id} -->`;
  const endm = `<!-- COMPLETION-REPORT:END:${id} -->`;
  const sbegin = `<!-- PROOFLINE-STATUS:BEGIN:${id} -->`;
  const send = `<!-- PROOFLINE-STATUS:END:${id} -->`;
  /** @type {string[]} */ const kept = [];
  let stripped = false;
  let sstripped = false;
  for (let i = 0; i < nr; i++) {
    if (!sstripped && line[i] === '## Proofline Status') {
      let j = i + 1;
      while (j < nr && reBlank.test(line[j])) j++;
      if (j < nr && line[j] === sbegin) {
        let k = j + 1;
        while (k < nr && line[k] !== send) k++;
        if (k < nr) {
          for (let m = j + 1; m < k; m++) if (!reBlank.test(line[m]) && !reStatusKey.test(line[m])) kept.push(line[m]);
          i = k; sstripped = true; continue;
        }
      }
    }
    if (!stripped && line[i] === '## Completion Report') {
      let j = i + 1;
      while (j < nr && reBlank.test(line[j])) j++;
      if (j < nr && line[j] === begin) {
        let k = j + 1;
        while (k < nr && line[k] !== endm) k++;
        if (k < nr) { i = k; stripped = true; continue; }
      }
    }
    kept.push(line[i].startsWith('**Status:**') ? '**Status:**' : line[i]);
  }
  let n = kept.length;
  while (n > 0 && reBlank.test(kept[n - 1])) n--;
  return sha256(kept.slice(0, n).map((l) => `${l}\n`).join(''));
}

/** A regular file that is not a link. @param {string} p */
function plainFile(p) { try { return lstatSync(p).isFile(); } catch { return false; } }

/** `task_source_bookkeeping_only ID PATH`: the path is the run's task file and its contract is unchanged. @param {Context} ctx @param {string} id @param {string} p */
export function taskSourceBookkeepingOnly(ctx, id, p) {
  const dir = runDir(ctx, id);
  if (!localTaskSourceRun(ctx, id)) return false;
  if (p !== sectionValue(ctx, dir, 'task_source', 'path')) return false;
  const revision = sectionValue(ctx, dir, 'task_source', 'revision');
  if (revision === '' || revision === 'PENDING' || revision === 'not_applicable') return false;
  if (!plainFile(`${ctx.root}/${p}`)) return false;
  return revision === taskSourceContractHash(ctx, id, `${ctx.root}/${p}`);
}

/** `local_task_source DIR`: the task file of a local Markdown run, or a failure. @param {Context} ctx @param {string} dir */
export function localTaskSource(ctx, dir) {
  const p = sectionValue(ctx, dir, 'task_source', 'path');
  if (p === '' || p.startsWith('/') || p.includes('..') || p.includes('//')) fail('invalid local Markdown task source path');
  const source = `${ctx.root}/${p}`;
  let link = false;
  try { link = lstatSync(source).isSymbolicLink(); } catch { /* absent */ }
  if (link) fail(`task source must not be a symlink: ${p}`);
  if (!plainFile(source)) fail(`task source missing or non-regular: ${p} (if the task file was moved, record it with 'agent.sh task-source-relocate ${dir.slice(dir.lastIndexOf('/') + 1)} <NEW-PATH>')`);
  return source;
}

/** `verify_task_source_status ID`: the Status line of the task file agrees with its lifecycle folder. @param {Context} ctx @param {string} id */
export function verifyTaskSourceStatus(ctx, id) {
  const dir = runDir(ctx, id);
  if (!localTaskSourceRun(ctx, id)) return;
  const p = sectionValue(ctx, dir, 'task_source', 'path');
  const want = lifecycleFolderStatus(p);
  const abs = `${ctx.root}/${p}`;
  const text = want === '' ? null : fileText(ctx, abs);
  if (want === '' || text === null || !isFile(abs)) return;
  let have = '';
  for (const l of textLines(text)) {
    if (l.startsWith('**Status:**')) { have = l.slice('**Status:**'.length).replace(new RegExp(`^${WS}*`), '').replace(new RegExp(`${WS}*$`), ''); break; }
  }
  if (have === '') return;
  if (have !== want) fail(`task source status mismatch: ${p} is under ${want}/ but declares **Status:** ${have}; run 'agent.sh task-source-status ${id}' (the Status value is bookkeeping and needs no re-baseline)`);
}

// ---- the control plane range (A155, A161, A169) --------------------------------------------------------------------------------

/** `ledger_file`'s lines, [] when the ledger is absent. @param {Context} ctx @param {string} dir */
function ledgerOf(ctx, dir) { return ledgerLines(ctx, dir); }

/**
 * `control_plane_range_only BASE PATH MAPS [own]`: the change of PATH between BASE and HEAD is control plane only.
 * @param {Context} ctx @param {string} dir @param {string} base @param {string} p @param {Array<[string, string]>} maps @param {boolean} own
 */
function controlPlaneRangeOnly(ctx, dir, base, p, maps, own) {
  if (authorizedPath(maps, p)) return false;
  const tasks = ctx.config().get('tasks.dir', '.agents/tasks');
  if (own) {
    const id = dir.slice(dir.lastIndexOf('/') + 1);
    const src = sectionValue(ctx, dir, 'task_source', 'path');
    if (p.startsWith(`${tasks}/`)) {
      if (src !== '' && p.split('/').pop() === src.split('/').pop()
        && (ciChainOk(ctx, id) || ledgerOf(ctx, dir).some((l) => l.includes(' event=task-source-done ')))) return true;
    }
    if (inKnowledgeScope(ctx, p)) {
      if (ciChainOk(ctx, id)) return true;
      const head = show(ctx, `HEAD:${p}`);
      const h = objectExists(ctx, `HEAD:${p}`) ? sha256(head ?? '') : '';
      if (h !== '') {
        const t = `${p}@${h}`;
        for (const l of ledgerOf(ctx, dir)) {
          if (l.includes(' event=knowledge-paths ') && ` ${l.replace(' detail=', ' detail= ')} `.includes(` ${t} `)) return true;
        }
      }
    }
  }
  if (p.startsWith('.agents/runs/') || p.startsWith('.agents/local/') || p.startsWith(`${tasks}/`)) return false;
  if (p.startsWith('.agents/')) return true;
  if (installedControlPath(ctx, p)) return true;
  if (!isBlockFile(p)) return false;
  const a = show(ctx, `${base}:${p}`);
  const b = a === null ? null : show(ctx, `HEAD:${p}`);
  if (a !== null && b !== null) return sha256(stripProoflineBlock(a)) === sha256(stripProoflineBlock(b));
  if (!objectExists(ctx, `${base}:${p}`)) {
    const h = show(ctx, `HEAD:${p}`);
    if (h !== null) return blockOnlyText(h);
  }
  return false;
}

/** The scope mappings for the moved-base checks (`scope_mappings 2>/dev/null`, '' when malformed). @param {Context} ctx @param {string} dir */
function mapsOf(ctx, dir) { const sc = planScope(ctx, dir); return sc.ok ? sc.rows : []; }

/** `git diff --no-renames --name-only BASE HEAD`: the lines, or null when it fails. @param {Context} ctx @param {string} base */
function rangeNames(ctx, base) {
  const r = git(ctx, ['diff', '--no-renames', '--name-only', base, 'HEAD']);
  return r.status === 0 ? r.out.split('\n').filter((x) => x !== '') : null;
}

/**
 * `base_moved_control_only BASE [own]`: every file changed between BASE and HEAD is control plane only.
 * @param {Context} ctx @param {string} dir @param {string} base @param {boolean} own
 */
export function baseMovedControlOnly(ctx, dir, base, own) {
  const maps = mapsOf(ctx, dir);
  if (!isAncestor(ctx, base, 'HEAD')) return false;
  const list = rangeNames(ctx, base);
  if (list === null) return false;
  for (const p of list) if (!controlPlaneRangeOnly(ctx, dir, base, p, maps, own)) return false;
  return true;
}

/** `base_moved_offenders BASE` (A161): up to five paths that are not control plane, for the stale-plan message. @param {Context} ctx @param {string} dir @param {string} base */
export function baseMovedOffenders(ctx, dir, base) {
  const maps = mapsOf(ctx, dir);
  if (!isAncestor(ctx, base, 'HEAD')) return 'the old base is not an ancestor of HEAD (another history)';
  const lines = [];
  for (const p of rangeNames(ctx, base) ?? []) {
    if (controlPlaneRangeOnly(ctx, dir, base, p, maps, true)) continue;
    lines.push(isBlockFile(p) && !authorizedPath(maps, p) ? `${p} (project text outside the proofline block, a second marker pair, a symlink or no markers)` : p);
    if (lines.length === 5) break;
  }
  return lines.map((l) => `${l};`).join('').replace(/;$/, '').replace(/;/g, '; ');
}

/** `base_moved_lines ID` anchored to the line structure ledger_append writes. @param {Context} ctx @param {string} dir */
export function baseMovedLines(ctx, dir) {
  const re = /^seq=[0-9]+ prev=[^ ]+ event=base-moved role=[^ ]* from=[^ ]* to=[^ ]* digest=[^ ]* ts=[^ ]* epoch=[^ ]* detail=base_sha moved \(/;
  return ledgerOf(ctx, dir).filter((l) => re.test(l));
}

/** `git rev-parse HEAD` for the freshness check; a repository without a commit is the shell's (git's own message). @param {Context} ctx */
export function headOrBridge(ctx) {
  const h = headSha(ctx);
  if (h === '') throw new BridgeToShell('git rev-parse HEAD failed');
  return h;
}

// ---- the run folder walk ----------------------------------------------------------------------------------------------------------

/**
 * `find DIR -type f` and `find DIR -type l`: the paths under the run folder relative to the project root, in directory order (what find
 * prints). A name with a newline is several lines for the shell: its code decides.
 * @param {Context} ctx @param {string} dir @returns {{ files: string[], links: string[] }}
 */
export function walkRunFolder(ctx, dir) {
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const links = [];
  const rootLen = Buffer.byteLength(`${ctx.root}/`);
  /** @param {Buffer} b */
  const rel = (b) => b.subarray(rootLen).toString('latin1');
  /** @param {Buffer} d */
  const walk = (d) => {
    let handle;
    try { handle = opendirSync(d, { encoding: 'buffer' }); } catch { return; }
    try {
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
        const name = /** @type {Buffer} */ (/** @type {unknown} */ (e.name));
        const full = Buffer.concat([d, Buffer.from('/'), name]);
        let st;
        try { st = lstatSync(full); } catch { continue; }
        if (name.includes(0x0a)) throw new BridgeToShell('newline in a run file name');
        if (st.isSymbolicLink()) links.push(rel(full));
        else if (st.isDirectory()) walk(full);
        else if (st.isFile()) files.push(rel(full));
      }
    } finally { handle.closeSync(); }
  };
  walk(Buffer.from(dir));
  return { files, links };
}

/**
 * `validate_control_artifacts ID`: the run folder holds known artifacts only. Prints the stray ones on stderr and returns false.
 * @param {Context} ctx @param {string} id
 */
export function validateControlArtifacts(ctx, id) {
  const { files, links } = walkRunFolder(ctx, runDir(ctx, id));
  let bad = '';
  for (const p of files) if (p !== '' && !knownControlArtifact(ctx, id, p)) bad += `${p}\n`;
  for (const p of links) if (p !== '') bad += `${p}\n`;
  if (bad === '') return true;
  ctx.err(`unexpected run artifact:\n${bad}the lead removes a stray regular file (never a known artifact) with: agent.sh discard-stray ${id} <top-level-file-name> (A119)\n`);
  return false;
}
