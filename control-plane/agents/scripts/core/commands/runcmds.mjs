// @ts-check
// Stage 4, package 4A: the run lifecycle commands that were agent.sh arms: baseline, discard-stray, branch, tier, classify, verify-assumptions,
// delivery-check, db-check, ask, status-block, tree-inspect, tree-accept, task-source-status, task-source-relocate. File formats, output texts and
// exit codes are those of agent.sh 0.0.46.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bytes } from '../config.mjs';
import { now } from '../clock.mjs';
import { dbGuardCheck } from '../dbguard.mjs';
import { fail, unsupported } from '../errors.mjs';
import { findApproval } from '../approvals.mjs';
import { consumeApproval, requestApproval, requireLead, requireOpenRun } from '../approve.mjs';
import { hashFile, pathFingerprint } from '../fingerprint.mjs';
import { currentBranch, git, headSha, trackedPaths, untrackedPaths } from '../git.mjs';
import { taskPatchFingerprint, taskOwnedPaths } from '../gates.mjs';
import { ledgerAppend, verifySeal } from '../ledger.mjs';
import { enforceTaskBranch, localTaskSource, localTaskSourceRun, setRunValue, taskSourceContractHash } from '../lifecycle.mjs';
import { isFile } from '../paths.mjs';
import { notRunRelative, realpathPosix } from '../pathin.mjs';
import * as proc from '../proc.mjs';
import { askCommand, verifyAssumptions } from '../questions.mjs';
import { fileText, gateField, gatesEnforced, planDestructive, sectionKeyPresent, sectionValue, textLines } from '../records.mjs';
import { lifecycleFolderStatus, requireRun, runDir } from '../runs.mjs';
import { inKnowledgeScope } from '../scope.mjs';
import { ECO_WARNING, ecosystemSets, pipelineClass, pipelineClassValid, pipelineDeclared, pipelineValue, runAutonomy, tierEffective } from '../signals.mjs';
import { slug } from '../slug.mjs';
import { statusBlockCommand } from '../statusblock.mjs';
import { taskType } from '../taskfile.mjs';
import { freshness, knowledgeOwnedPaths, verifyFreeze, verifyHandoff, verifyKnowledgeScope, verifyScope } from './verify.mjs';
import { topology, windowFiles } from './hookcmds.mjs';
import { forgetFiles } from '../approve.mjs';
import { sha256 } from '../hash.mjs';
import { runSecretScan } from '../secretscan.mjs';
export { runSecretScan };

/** @typedef {import('../context.mjs').Context} Context */

/** A mandatory argument (`${2:?usage}`). @param {string[]} args @param {number} i */
function need(args, i) {
  const v = args[i];
  if (v === undefined || v === '') throw unsupported('usage');
  return bytes(v);
}

/** `ledger_append ID EVENT FROM TO DETAIL` @param {Context} ctx @param {string} id @param {string} event @param {string} from @param {string} to @param {string} detail */
function led(ctx, id, event, from, to, detail) {
  ledgerAppend(runDir(ctx, id), ctx.role, event, from, to, detail);
  ctx.forget('file:');
}

/** The lines of an awk-rewritten file, written back with a final newline. @param {string[]} lines */
const joinLines = (lines) => lines.map((l) => `${l}\n`).join('');

// ---- baseline ---------------------------------------------------------------------------------------------------------------------

/** @param {Context} ctx @param {string[]} args */
function baseline(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail(`cannot record a baseline for CODE_DONE run: ${id}`);
  const status = sectionValue(ctx, dir, 'baseline', 'status');
  if (status !== '' && status !== 'pending') fail(`baseline already exists for ${id}; refusing to overwrite`);
  enforceTaskBranch(ctx, id);
  const text = fileText(ctx, `${dir}/RUN.yaml`);
  if (text === null) throw unsupported('RUN.yaml is not readable');
  // remove_pending_baseline, then the base sha of HEAD
  /** @type {string[]} */ const kept = [];
  let inside = false;
  for (const l of textLines(text)) {
    if (l === 'baseline:') { inside = true; continue; }
    if (inside && /^[^ \t\n\v\f\r]/.test(l)) inside = false;
    if (!inside) kept.push(l);
  }
  const sha = headSha(ctx);
  if (sha === '') fail('baseline needs a commit: git rev-parse HEAD failed (the repository has no commit yet)');
  let rep = false; let found = false;
  const withBase = kept.map((l) => {
    if (l === 'repository:') { rep = true; return l; }
    if (rep && /^[^ \t\n\v\f\r]/.test(l)) rep = false;
    if (rep && l.startsWith('  base_sha:')) { found = true; return `  base_sha: "${sha}"`; }
    return l;
  });
  if (!found) fail('RUN.yaml requires repository.base_sha');
  let block = '\nbaseline:\n  status: captured\n  tracked:\n';
  for (const p of trackedPaths(ctx)) if (p !== '') block += `    - path: ${p}\n      sha256: "${pathFingerprint(ctx, p)}"\n`;
  block += '  untracked:\n';
  for (const p of untrackedPaths(ctx)) if (p !== '') block += `    - path: ${p}\n      sha256: "${pathFingerprint(ctx, p)}"\n`;
  const tmp = `${dir}/RUN.yaml.tmp`;
  writeFileSync(tmp, Buffer.from(joinLines(withBase) + block, 'latin1'));
  renameSync(tmp, `${dir}/RUN.yaml`);
  forgetFiles(ctx); ctx.forget('baseline:');
  ctx.out(`baseline recorded: ${id}\n`);
  return 0;
}

// ---- discard-stray ----------------------------------------------------------------------------------------------------------------

const DS_PROTECTED = 'task.md plan.md run.yaml run.yaml.tmp completion_report.md ledger.log verify.md evidence.md qa_plan.md qa_report.md pid amendments dispatch worker-evidence decisions gates results reports questions approvals waivers security scratch reviews design ci-fix'.split(' ');

/** `[ -L ]`, `[ -f ]` and the inode, without following a link. @param {string} p */
function inode(p) { try { return String(statSync(p).ino); } catch { return ''; } }

/**
 * A210/A219: is the run-relative path `rel` cited by a record? Structured records only (the run state, the ledger without its own discard rows,
 * the lead's evidence and verdict files, the gate, approval, waiver, worker-evidence and decision folders); the free text of reports, results
 * and dispatch is not read, because an explorer's report names its own stray. Unreadable means cited (refuse when in doubt).
 * @param {string} dir @param {string} id @param {string} rel
 */
function citedByRecord(dir, id, rel) {
  // case-insensitive (the file system folds case on macOS and Windows); the run-relative spelling, the project-relative `.agents/runs/<ID>/` spelling
  // and an absolute path ending in it all name the file; any other prefix makes it a different path (`other/evidence/x`, another run's folder)
  const esc = (/** @type {string} */ x) => x.replace(/[.]/g, '\\.');
  const re = new RegExp(`(?:(?<![A-Za-z0-9._/-])(?:\\.agents/runs/${esc(id)}/)?|/\\.agents/runs/${esc(id)}/)${esc(rel)}(?![A-Za-z0-9._-])`, 'i');
  /** @type {string[]} */ const files = ['RUN.yaml', 'LEDGER.log', 'EVIDENCE.md', 'VERIFY.md', 'QA_REPORT.md', 'COMPLETION_REPORT.md'].map((f) => `${dir}/${f}`);
  for (const sub of ['gates', 'approvals', 'waivers', 'worker-evidence', 'decisions']) {
    let names = [];
    try { names = readdirSync(`${dir}/${sub}`); } catch { /* absent */ }
    for (const n of names) files.push(`${dir}/${sub}/${n}`);
  }
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'latin1'); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' || /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOTDIR' || /** @type {NodeJS.ErrnoException} */ (e).code === 'EISDIR') continue; return true; }
    for (const line of text.split('\n')) if (!/ event=discard-stray /.test(line) && re.test(line)) return true;
  }
  return false;
}

/** @param {Context} ctx @param {string[]} args */
function discardStray(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  const rel = bytes(args[1] ?? '');
  requireRun(ctx, id);
  requireOpenRun(ctx, id);
  const d0 = runDir(ctx, id);
  if (sectionValue(ctx, d0, 'completion_report', 'published') === 'true') fail('discard-stray refused: the run is sealed (completion report published)');
  if (rel === '') fail('usage: agent.sh discard-stray <ID> <file-name-in-the-run-directory | evidence/file-name>');
  // A219: exactly one extra level is accepted, and only the folder `evidence/` (a name no registry entry knows, so nothing there is a record)
  const inEvidence = rel.startsWith('evidence/');
  const name = inEvidence ? rel.slice('evidence/'.length) : rel;
  if (name.includes('/') || name.startsWith('.') || name.startsWith('-')) fail(`discard-stray refused: '${rel}' must be a single top-level file name of the run directory, or evidence/<file-name> (strays elsewhere in subdirectories are not handled)`);
  if (name === '' || /[^A-Za-z0-9._-]/.test(name)) fail(`discard-stray refused: '${rel}' may contain only A-Z a-z 0-9 . _ - in the file name`);
  const lc = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let dir;
  try { dir = realpathPosix(d0); } catch { return fail('discard-stray refused: run directory does not resolve'); }
  if (inEvidence) {
    let ed = false;
    try { const st = lstatSync(`${dir}/evidence`); ed = st.isDirectory() && !st.isSymbolicLink(); } catch { /* absent */ }
    if (!ed) fail("discard-stray refused: 'evidence' is not a plain folder of the run directory");
    let real = '';
    try { real = realpathPosix(`${dir}/evidence`); } catch { /* checked below */ }
    if (real !== `${dir}/evidence`) fail("discard-stray refused: 'evidence' resolves outside the run directory");
  }
  const file = inEvidence ? `${dir}/evidence/${name}` : `${dir}/${name}`;
  let link = false;
  try { link = lstatSync(file).isSymbolicLink(); } catch { /* absent */ }
  if (link) fail(`discard-stray refused: '${rel}' is a symlink`);
  const ino = inode(file);
  if (!inEvidence && DS_PROTECTED.includes(lc)) fail(`discard-stray refused: '${rel}' is a known run artifact`);
  // the protected inodes come from the real directory entries (PLAN.md, not plan.md): a lookup by the lower-case name finds nothing on a
  // case-sensitive file system, and a hard-link alias of PLAN.md would then be deleted as a stray
  if (ino !== '') {
    let entries = [];
    try { entries = readdirSync(dir); } catch { fail('discard-stray refused: run directory cannot be read'); }
    for (const e of entries) {
      if (DS_PROTECTED.includes(e.replace(/[A-Z]/g, (c) => c.toLowerCase())) && inode(`${dir}/${e}`) === ino) fail(`discard-stray refused: '${rel}' is a known run artifact`);
    }
  }
  let regular = false;
  try { regular = statSync(file).isFile(); } catch { /* absent */ }
  if (!regular) fail(`discard-stray refused: '${rel}' is not a regular file in the run directory`);
  if (inEvidence && citedByRecord(dir, id, rel)) fail(`discard-stray refused: '${rel}' is cited by a run record (RUN.yaml, the ledger, EVIDENCE.md, a gate, approval, waiver or worker-evidence record): it is evidence, not a stray`);
  const sha = hashFile(file);
  rmSync(file, { force: true });
  if (gatesEnforced(ctx, d0)) { const s = sectionValue(ctx, d0, 'handoff', 'state'); led(ctx, id, 'discard-stray', s, s, `path=${rel} sha256=${sha}`); }
  ctx.out(`discarded stray run file: ${rel} (sha256 ${sha})\n`);
  return 0;
}

// ---- branch -----------------------------------------------------------------------------------------------------------------------

/** `wt_linked`: the run's tree is a linked worktree. @param {Context} ctx */
export function wtLinked(ctx) {
  const r = git(ctx, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (r.status !== 0) return false;
  const [a, b] = r.out.split('\n');
  try { return realpathSync(path.resolve(ctx.root, a)) !== realpathSync(path.resolve(ctx.root, b)); } catch { return false; }
}

/** `task_title_of TASK.md`: the H1 title. @param {string} text */
export function taskTitle(text) {
  const first = textLines(text)[0] ?? '';
  const m = /^# Task: *[^ ]* *[-—]* *(.*)$/.exec(Buffer.from(first, 'latin1').toString('utf8'));
  return m ? bytes(m[1]) : '';
}

/** `derive_task_slug DIR` @param {Context} ctx @param {string} dir @param {string} id */
function deriveSlug(ctx, dir, id) {
  const type = sectionValue(ctx, dir, 'task_source', 'type');
  let s = '';
  if (type === 'local_markdown') {
    const p = sectionValue(ctx, dir, 'task_source', 'path');
    const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');
    if (base.startsWith(`${id}-`)) s = base.slice(id.length + 1); else if (base === id) s = ''; else s = base;
  } else if (type === 'none') s = 'run';
  s = slug(s);
  const idLow = slug(id);
  if (s === '' || s === idLow) s = slug(taskTitle(fileText(ctx, `${dir}/TASK.md`) ?? ''));
  if (s === idLow) s = '';
  return s === '' ? 'task' : s;
}

/** @param {Context} ctx @param {string[]} args */
function branch(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail(`cannot modify task branch on CODE_DONE run: ${id}`);
  const canonical = ctx.config().get('canonical_branch', '');
  if (canonical === '') fail('canonical_branch not configured');
  let current = currentBranch(ctx);
  const tip = () => { const r = git(ctx, ['rev-parse', '-q', '--verify', `refs/heads/${canonical}`]); return r.status === 0 ? r.out.replace(/\n+$/, '') : ''; };
  if (current === '' && wtLinked(ctx) && headSha(ctx) === tip() && tip() !== '') current = canonical;
  if (current === '') fail('task branch setup requires a checked-out branch, not detached HEAD');
  const existing = sectionValue(ctx, dir, 'repository', 'task_branch');
  const refExists = (/** @type {string} */ b) => git(ctx, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
  const checkout = (/** @type {string} */ b, /** @type {string} */ msg) => { if (git(ctx, ['checkout', '-q', b]).status !== 0) fail(msg); ctx.forget('changed:'); ctx.forget('git:'); };
  if (existing === '' || existing === 'PENDING') {
    if (current !== canonical) fail(`task branch setup must start from canonical branch (${canonical}); currently on: ${current}`);
    const bs = sectionValue(ctx, dir, 'baseline', 'status');
    if (bs !== '' && bs !== 'pending') fail(`task branch setup must occur before baseline: ${id}`);
    const csha = tip();
    if (csha === '') fail(`canonical branch not found locally: ${canonical}`);
    const tb = `${ctx.config().get('git.branch_prefix', 'proofline/')}${id}-${deriveSlug(ctx, dir, id)}`;
    if (refExists(tb)) {
      const r = git(ctx, ['rev-parse', `refs/heads/${tb}`]).out.replace(/\n+$/, '');
      if (r !== csha) fail(`existing branch ${tb} is not compatible with canonical base ${csha}; will not reuse or overwrite`);
    } else if (git(ctx, ['branch', tb, csha]).status !== 0) fail(`failed to create task branch: ${tb}`);
    checkout(tb, `failed to switch to task branch: ${tb}`);
    setRunValue(ctx, id, 'repository', 'canonical_branch', canonical);
    setRunValue(ctx, id, 'repository', 'task_branch', tb);
    ctx.out(`task branch established: ${id} ${tb}\n`);
  } else {
    if (!refExists(existing)) fail(`recorded task branch missing: ${existing}; will not regenerate, recover manually`);
    if (current !== existing) {
      if (current !== canonical) fail(`cannot resume ${id}: on unexpected branch ${current} (expected ${canonical} or ${existing})`);
      checkout(existing, `failed to switch to recorded task branch: ${existing}`);
    }
    ctx.out(`task branch resumed: ${id} ${existing}\n`);
  }
  return 0;
}

// ---- classify and tier ------------------------------------------------------------------------------------------------------------

/** @param {string} c */
const classRank = (c) => (c === 'STANDARD' ? 1 : c === 'COMPLEX' ? 2 : c === 'CRITICAL' ? 3 : 0);

/** `eco_warning >&2` @param {Context} ctx */
function ecoWarning(ctx) { if (!ecosystemSets(ctx).loaded) ctx.err(`warning: ${ECO_WARNING}\n`); }

/** @param {Context} ctx @param {string[]} args */
function classify(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0); const cls = need(args, 1); const opt = bytes(args[2] ?? '');
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) fail('classify requires the lifecycle_gates policy');
  if (!pipelineDeclared(ctx, dir)) fail('RUN.yaml has no pipeline block (create the run from .agents/templates/RUN.yaml)');
  requireOpenRun(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail(`cannot reclassify a completed run: ${id}`);
  if (!pipelineClassValid(cls)) fail(`invalid classification: ${cls} (want TRIVIAL|STANDARD|COMPLEX|CRITICAL)`);
  const taskText = fileText(ctx, `${dir}/TASK.md`);
  // A61: a class below the task's own Suggested class is refused
  let sug = '';
  let g = false;
  for (const l of textLines(taskText ?? '')) {
    if (/^## Suggested class[ \t\n\v\f\r]*$/.test(l)) { g = true; continue; }
    if (l.startsWith('## ')) g = false;
    const m = g ? /(TRIVIAL|STANDARD|COMPLEX|CRITICAL)/.exec(l) : null;
    if (m) { sug = m[1]; break; }
  }
  if (sug !== '' && classRank(cls) < classRank(sug)) fail(`classification refused: TASK.md suggests ${sug} and ${cls} is lower. Classify at least ${sug}, or change the task's '## Suggested class' with the reason (a task change before freeze)`);
  const type = taskType(taskText ?? '');
  if (type === 'invalid') fail(`classification refused: the task type in ${dir}/TASK.md cannot be read (front matter \`type:\` must be one of feature, bug, refactor, content, docs, chore, optionally followed by a # comment); an unreadable type gets no exemption and no lighter path, so the user corrects it (A202)`);
  if ((type === 'bug' || type === 'refactor') && cls === 'TRIVIAL') fail(`classification refused: the task is typed ${type} and TRIVIAL covers text and configuration only; classify STANDARD or higher, or ask the user to change the task type`);
  const tb = sectionValue(ctx, dir, 'repository', 'task_branch');
  if (tb !== '' && tb !== 'PENDING') enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (plan !== null && planDestructive(plan) === 'yes' && cls !== 'CRITICAL') fail('PLAN.md declares a destructive data change: the class is CRITICAL');
  const configured = pipelineValue(ctx, cls, 'review');
  let review;
  if (configured === 'yes' || configured === 'no') {
    if (opt !== '') fail(`the ${cls} pipeline fixes review=${configured}; the 'review' option exists only where a pipeline says optional`);
    review = configured;
  } else if (configured === 'optional') {
    if (opt === '') review = 'no'; else if (opt === 'review') review = 'yes'; else return fail(`unknown option: ${opt} (want: review)`);
  } else return fail(`no pipelines.${cls} entry in .agents/config.yaml`);
  setRunValue(ctx, id, 'pipeline', 'classification', cls);
  setRunValue(ctx, id, 'pipeline', 'review', review);
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  led(ctx, id, 'classify', hs, hs, `${cls} review=${review}`);
  ctx.out(`classified: ${id} ${cls} (autonomy: ${runAutonomy(ctx, dir)})\n`);
  ecoWarning(ctx);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function tier(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!pipelineClassValid(pipelineClass(ctx, dir))) fail(`run ${id} is not classified yet`);
  const t = tierEffective(ctx, dir);
  if (ctx.role === 'lead' && sectionKeyPresent(ctx, dir, 'pipeline', 'tier') && sectionValue(ctx, dir, 'pipeline', 'tier') !== t) {
    const prev = sectionValue(ctx, dir, 'pipeline', 'tier');
    setRunValue(ctx, id, 'pipeline', 'tier', t);
    led(ctx, id, 'tier', prev, t, 'effective tier');
  }
  ctx.out(`${t}\n`);
  return 0;
}

// ---- verify-assumptions, db-check -------------------------------------------------------------------------------------------------

/** @param {Context} ctx @param {string[]} args */
function verifyAssumptionsCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  verifyAssumptions(ctx, id, false);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function dbCheck(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  requireRun(ctx, id);
  dbGuardCheck(ctx, id);
  ctx.out(`database guard: unchanged (${id})\n`);
  return 0;
}

// ---- tree-inspect, tree-accept ----------------------------------------------------------------------------------------------------

/** `last_attested_tree ID` @param {Context} ctx @param {string} dir */
function lastAttested(ctx, dir) {
  let n = sha256('');
  for (const w of windowFiles(`${dir}/worker-evidence`)) n = gateField(ctx, `${dir}/worker-evidence/${w}`, 'after_sha256');
  return n;
}

/** @param {Context} ctx @param {string} id */
function inspect(ctx, id) {
  const dir = runDir(ctx, id);
  const att = lastAttested(ctx, dir); const cur = taskPatchFingerprint(ctx, dir);
  ctx.out(`attested tree (last worker window): ${att}\ncurrent task-owned tree:             ${cur}\n`);
  if (att === cur) { ctx.out('the tree is the attested one: nothing to accept\n'); return; }
  const b = sectionValue(ctx, dir, 'repository', 'base_sha');
  ctx.out(`task-owned paths that differ from the run's base (${b !== '' ? b : 'no base recorded'}); a path the worker windows already attested is among them, the full diff is 'git diff ${b !== '' ? b : '<base>'}':\n`);
  for (const [p] of taskOwnedPaths(ctx, dir)) {
    if (p === '') continue;
    if (b !== '') ctx.out(git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--stat', b, '--', p]).out);
    for (const l of git(ctx, ['status', '--short', '--', p]).out.split('\n')) if (l.startsWith('??')) ctx.out(`${l}\n`);
  }
  ctx.out(`to keep the run: agent.sh tree-accept ${id} (asks for your approval of this tree; every gate then runs again)\n`);
}

/** @param {Context} ctx @param {string[]} args */
function treeInspect(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  requireRun(ctx, id);
  inspect(ctx, id);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function treeAccept(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  requireOpenRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) fail(`run ${id} has no lifecycle_gates policy: nothing to accept`);
  if (topology(ctx, dir) !== 'orchestrated') fail(`tree-accept is for the orchestrated topology (worker windows); ${id} is not`);
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  if (!['IMPLEMENTING', 'IMPLEMENTED', 'CODE_DONE'].includes(hs)) fail(`tree-accept applies to a run at IMPLEMENTING, IMPLEMENTED or CODE_DONE; ${id} is at ${hs}`);
  const att = lastAttested(ctx, dir); const cur = taskPatchFingerprint(ctx, dir);
  if (att === cur) fail('the tree is the last attested one: there is nothing to accept');
  const app = findApproval(ctx, id, 'tree', cur);
  if (app === null) {
    inspect(ctx, id);
    requestApproval(ctx, id, 'tree');
    fail(`accepting the tree needs your approval: relay the question above verbatim; your reply (for example "approve the tree") records it, then run agent.sh tree-accept ${id} again`);
  }
  if (gateField(ctx, app, 'answered_by') !== 'user') fail("the approval is not the user's");
  const ev = `${dir}/worker-evidence`;
  try { mkdirSync(ev, { recursive: true }); } catch { fail(`cannot create ${ev}`); }
  const n = nextWindow(ev);
  const base = app.slice(app.lastIndexOf('/') + 1);
  try {
    writeFileSync(`${ev}/WINDOW-${n}.yaml`, Buffer.from(`task_id: "${id}"\nseq: ${n}\nrole: "user"\ntopology: "orchestrated"\nbefore_sha256: "${att}"\nafter_sha256: "${cur}"\nexit_status: "0"\napproval: "${base}"\ntimestamp: "${now().iso}"\n`, 'latin1'));
  } catch { fail('could not write the window record'); }
  ctx.forget('file:');
  led(ctx, id, 'tree-accept', '-', '-', `worker-evidence/WINDOW-${n}.yaml@${hashFile(`${ev}/WINDOW-${n}.yaml`)} approval=${base} tree=${cur}`);
  consumeApproval(ctx, id, app);
  if (hs === 'IMPLEMENTED' || hs === 'CODE_DONE') {
    setRunValue(ctx, id, 'handoff', 'state', 'IMPLEMENTING');
    setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', 'PENDING');
    setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
    led(ctx, id, 'handoff:IMPLEMENTING', hs, 'IMPLEMENTING', 'tree accepted by the user: every gate runs again');
  }
  ctx.out(`tree accepted: ${id} WINDOW-${n} attests ${cur}; handoff ${hs} -> IMPLEMENTING; next: agent.sh handoff ${id} IMPLEMENTED, then every gate again (agent.sh next ${id})\n`);
  return 0;
}

/** `next_evidence_seq DIR WINDOW`: one more than the highest WINDOW number. @param {string} ev */
function nextWindow(ev) {
  let max = 0;
  for (const w of windowFiles(ev)) max = Math.max(max, Number(w.slice(7, -5)));
  return String(max + 1);
}

// ---- task-source-status, task-source-relocate -------------------------------------------------------------------------------------

/** `declared_task_status FILE` @param {string} text */
function declaredStatus(text) {
  for (const l of textLines(text)) if (l.startsWith('**Status:**')) return l.slice(11).replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');
  return '';
}

/** @param {Context} ctx @param {string[]} args */
function taskSourceStatus(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  requireOpenRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!localTaskSourceRun(ctx, id)) fail('task-source-status requires a local Markdown task source');
  if (sectionValue(ctx, dir, 'completion_report', 'published') === 'true') fail('cannot change the task source status after the completion report is published: its receipt binds the task source');
  enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  const p = sectionValue(ctx, dir, 'task_source', 'path');
  const source = localTaskSource(ctx, dir);
  const want = lifecycleFolderStatus(p);
  if (want === '') fail(`task source ${p} is not under a lifecycle folder (backlog/, todo/, in-progress/ or done/): nothing to synchronize`);
  const text = fileText(ctx, source);
  if (text === null) throw unsupported('task source is not readable');
  const have = declaredStatus(text);
  if (have === '') fail(`task source ${p} has no **Status:** line`);
  if (have === want) { ctx.out(`task source status already ${want}: ${id}\n`); return 0; }
  const revision = sectionValue(ctx, dir, 'task_source', 'revision');
  const next = joinLines(textLines(text).map((l) => (l.startsWith('**Status:**') ? `**Status:** ${want}` : l)));
  if (revision !== '' && revision !== 'PENDING' && revision !== 'not_applicable') {
    const tmp = mkdtempSync(`${tmpdir()}/agent-task-status.`);
    try {
      writeFileSync(`${tmp}/t`, Buffer.from(next, 'latin1'));
      if (revision !== taskSourceContractHash(ctx, id, `${tmp}/t`)) fail('refusing to change the task source: the frozen task contract would change; amendment and refreeze required');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  writeFileSync(source, Buffer.from(next, 'latin1'));
  ctx.forget('file:');
  if (gatesEnforced(ctx, dir)) { const s = sectionValue(ctx, dir, 'handoff', 'state'); led(ctx, id, 'task-source-status', s, s, `${p}: ${have} -> ${want}`); }
  ctx.out(`task source status synchronized: ${id} ${p} ${have} -> ${want}\n`);
  return 0;
}

/** @param {string} p */
function lexists(p) { try { lstatSync(p); return true; } catch { return false; } }

/** `freeze_hash_present` @param {Context} ctx @param {string} dir */
function freezeHashPresent(ctx, dir) {
  let inside = false;
  for (const l of textLines(fileText(ctx, `${dir}/RUN.yaml`) ?? '')) {
    if (l === 'freeze:') { inside = true; continue; }
    if (inside && /^[^ \t\n\v\f\r]/.test(l)) return false;
    if (inside && /^[ \t\n\v\f\r]*(task|evidence|plan|policy)_sha256: "[0-9a-f][0-9a-f]/.test(l)) return true;
  }
  return false;
}

/** @param {Context} ctx @param {string[]} args */
function taskSourceRelocate(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0); const nw = need(args, 1);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!localTaskSourceRun(ctx, id)) fail('task-source-relocate requires a local Markdown task source');
  if (!freezeHashPresent(ctx, dir)) fail('the task source can be relocated only after the run is frozen');
  if (sectionValue(ctx, dir, 'completion_report', 'published') === 'true') fail('cannot relocate the task source after the completion report is published: its receipt binds the location');
  verifyFreeze(ctx, id, true);
  enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  if (notRunRelative(nw) || nw.includes('//') || /[\x00-\x1f\x7f"\\]/.test(nw)) fail(`invalid task source path: ${JSON.stringify(nw)}`);
  const old = sectionValue(ctx, dir, 'task_source', 'path');
  if (nw === old) fail(`the task source is already recorded at ${old}`);
  if (lexists(`${ctx.root}/${old}`)) fail(`the task source still exists at ${old}: a relocation is a move, not a copy`);
  let link = false;
  try { link = lstatSync(`${ctx.root}/${nw}`).isSymbolicLink(); } catch { /* absent */ }
  if (link) fail(`task source must not be a symlink: ${nw}`);
  if (!isFile(`${ctx.root}/${nw}`)) fail(`task source missing or non-regular: ${nw}`);
  if (sectionValue(ctx, dir, 'task_source', 'revision') !== taskSourceContractHash(ctx, id, `${ctx.root}/${nw}`)) fail(`the task contract at ${nw} differs from the frozen contract (only the Status value and the published completion-report block may differ); amendment and refreeze required`);
  setRunValue(ctx, id, 'task_source', 'path', nw);
  if (gatesEnforced(ctx, dir)) { const s = sectionValue(ctx, dir, 'handoff', 'state'); led(ctx, id, 'task-source-relocate', s, s, `${old} -> ${nw}`); }
  ctx.out(`task source relocated: ${id} ${old} -> ${nw}\n`);
  return 0;
}

// ---- delivery-check ---------------------------------------------------------------------------------------------------------------

/** `knowledge_drift ID`: design-sync drift in knowledge-scope documents that the verifier reported and the tree still shows (at most five). @param {Context} ctx @param {string} id @returns {string[]} */
export function knowledgeDrift(ctx, id) {
  const sync = `${runDir(ctx, id)}/design/SYNC.md`;
  const script = `${ctx.root}/.agents/skills/design-sync/scripts/design-sync.mjs`;
  if (!isFile(sync) || !isFile(script)) return [];
  const r = proc.run(process.execPath, ['.agents/skills/design-sync/scripts/design-sync.mjs', '--root', '.'], { cwd: ctx.root, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  let j;
  try { j = JSON.parse(r.stdout.toString('utf8')); } catch { return []; }
  let drift = '';
  try {
    const m = /^## Drift\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readFileSync(sync, 'utf8'));
    drift = m ? m[1] : '';
  } catch { return []; }
  /** @type {string[]} */ const out = [];
  for (const c of j.claims ?? []) {
    if (c.status === 'unmatched' && drift.includes(c.doc) && drift.includes(c.claim)) {
      const row = bytes(`${c.doc}:${c.line} -> ${c.kind} ${c.claim}`);
      if (inKnowledgeScope(ctx, row.slice(0, row.indexOf(':')))) out.push(row);
    }
  }
  return out.slice(0, 5);
}

/** `scan_knowledge_secrets ID` @param {Context} ctx @param {string} id */
export function scanKnowledgeSecrets(ctx, id) {
  const paths = knowledgeOwnedPaths(ctx, id).filter((p) => isFile(`${ctx.root}/${p}`));
  if (paths.length === 0) return;
  const r = runSecretScan(ctx, paths);
  if (r.status === 0) return;
  const out = (r.stdout.toString('latin1') + r.stderr.toString('latin1')).replace(/\n+$/, '');
  if (r.status === 1) { ctx.err(out.split('\n').map((l) => `  ${l}\n`).join('')); fail('secret scan of the knowledge-scope files written after CODE_DONE found secrets: remove them'); }
  fail(`secret scan of the knowledge-scope files failed (exit ${r.status}): ${out.split('\n').slice(0, 3).join(' ')}`);
}

/** `require_knowledge_done ID` @param {Context} ctx @param {string} id */
function requireKnowledgeDone(ctx, id) {
  const ks = sectionValue(ctx, runDir(ctx, id), 'execution', 'knowledge_state');
  if (ks !== 'KNOWLEDGE_DONE' && ks !== 'not_applicable') fail(`delivery blocked: knowledge step not complete; run '/proofline knowledge ${id}' (agent.sh knowledge-done ${id} [not_applicable "<reason>"])`);
  const drift = knowledgeDrift(ctx, id);
  if (drift.length > 0) fail(`delivery blocked: design-sync drift in knowledge-scope documents is still there (${drift.join(';')}); the knowledge step must fix it (update the document or the code claim), then 'agent.sh knowledge-done ${id}'. No waiver or scope change applies to these documents`);
}

/** @param {Context} ctx @param {string[]} args */
export function deliveryCheck(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') !== 'CODE_DONE') fail('delivery blocked: CODE_DONE required');
  const branchName = currentBranch(ctx);
  if (branchName === '') fail('delivery blocked: detached HEAD');
  enforceTaskBranch(ctx, id);
  let rc = freshness(ctx, id);
  if (rc !== 0) return rc;
  rc = verifyScope(ctx, id, true);
  if (rc !== 0) return rc;
  rc = verifyKnowledgeScope(ctx, id);
  if (rc !== 0) return rc;
  scanKnowledgeSecrets(ctx, id);
  requireKnowledgeDone(ctx, id);
  rc = verifyHandoff(ctx, id, true);
  if (rc !== 0) return rc;
  const patch = taskPatchFingerprint(ctx, dir);
  if (sectionValue(ctx, dir, 'handoff', 'implemented_patch_sha256') !== patch) fail('delivery blocked: implementation stale or missing');
  if (sectionValue(ctx, dir, 'handoff', 'code_done_patch_sha256') !== patch) fail('delivery blocked: CODE_DONE handoff stale or missing');
  ctx.out(`delivery_branch=${branchName}\ndelivery_ready=true\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const RUNCMD_HANDLERS = {
  baseline,
  'discard-stray': discardStray,
  branch,
  classify,
  tier,
  'verify-assumptions': verifyAssumptionsCommand,
  'db-check': dbCheck,
  ask: askCommand,
  'status-block': (ctx, args) => { ctx.fpMode = 'yes'; return statusBlockCommand(ctx, args); },
  'tree-inspect': treeInspect,
  'tree-accept': treeAccept,
  'task-source-status': taskSourceStatus,
  'task-source-relocate': taskSourceRelocate,
  'delivery-check': deliveryCheck,
};
