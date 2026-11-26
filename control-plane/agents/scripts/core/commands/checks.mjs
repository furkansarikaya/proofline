// @ts-check
// Stage 2, package C2: ci-check, ci-task-command, design-rationales, commands-check, scale-check, batch-check. The last four read the
// approval and batch library (core/approvals.mjs, the read-only part); nothing here writes or consumes an approval, so no path needs a
// BridgeToShell for the Stage 3-7 libraries. Keeps arguments, stdout, stderr and exit status of agent.sh 0.0.41.
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bytes } from '../config.mjs';
import { ProoflineError, fail, unsupported } from '../errors.mjs';
import { DESIGN_MD_CANDIDATES, batchApproval, findApproval, hashOf, rationaleIds, rationaleLineIn, sharedDirOf } from '../approvals.mjs';
import { sha256 } from '../hash.mjs';
import { isFile } from '../paths.mjs';
import { onDiskLocal } from '../pathin.mjs';
import { detectPlatform } from '../platform.mjs';
import { fileLines, fileText } from '../records.mjs';
import { requireRun, runDir } from '../runs.mjs';
import { rationaleCarried } from '../standing.mjs';
import { taskChangedPaths } from '../signals.mjs';

/** @typedef {import('../context.mjs').Context} Context */

export const CI_WARN = 'no CI check runs on pull requests here. proofline merge verifies the commit locally instead (commands.build and commands.test in a clean copy) and the pull request says "verified locally, no CI".';

/** The platform word of the origin remote. @param {Context} ctx */
function platformField(ctx) { return detectPlatform(ctx).platform; }

/** `ci_workflow_has_pr FILE`: the workflow's `on:` has a pull_request or pull_request_target trigger. @param {string[]} lines */
export function workflowHasPr(lines) {
  let on = false;
  let ci = -1;
  for (const raw of lines) {
    let l = raw.replace(/\r/g, '');
    if (/^[ \t]*#/.test(l)) continue;
    l = l.replace(/[ \t]+#.*$/, '');
    if (/^[^ \t-]/.test(l)) {
      on = /^("on"|'on'|on)[ \t]*:/.test(l);
      ci = -1;
      if (on) {
        const v = l.replace(/^[^:]*:/, '');
        if (/(^|[^A-Za-z_])pull_request(_target)?([^A-Za-z_]|$)/.test(v)) return true;
      }
      continue;
    }
    if (on && /^[ \t]+[^ \t]/.test(l)) {
      const len = /^[ \t]+/.exec(l)?.[0].length ?? 0;
      if (ci < 0) ci = len;
      if (len === ci && /^[ \t]+(-[ \t]+)?"?pull_request(_target)?"?[ \t]*(:|,|\]|$)/.test(l)) return true;
    }
  }
  return false;
}

/** The workflow files, `.yml` then `.yaml`, each in byte order (a glob). @param {string} root */
function workflowFiles(root) {
  let names = [];
  try { names = readdirSync(`${root}/.github/workflows`).sort(); } catch { return []; }
  return [...names.filter((n) => n.endsWith('.yml') && !n.startsWith('.')), ...names.filter((n) => n.endsWith('.yaml') && !n.startsWith('.'))];
}

/** `ci_check`: the text and the status of the CI visibility check (read-only, repository files only). @param {Context} ctx @returns {{ text: string, rc: number }} */
export function ciCheckResult(ctx) {
  const pf = platformField(ctx);
  if (pf === 'gitlab') {
    if (isFile(`${ctx.root}/.gitlab-ci.yml`)) return { text: 'ci: present (.gitlab-ci.yml)\n', rc: 0 };
    return { text: `ci: absent\n${CI_WARN}\n`, rc: 1 };
  }
  if (pf === 'azure') {
    for (const f of ['azure-pipelines.yml', 'azure-pipelines.yaml', '.azure-pipelines']) {
      if (existsSync(`${ctx.root}/${f}`)) return { text: `ci: present (${f})\n`, rc: 0 };
    }
    return { text: 'ci: unknown (Azure DevOps build policies are not visible from the repository files)\n', rc: 0 };
  }
  if (pf !== 'github') return { text: `ci: unknown (platform ${pf}: checks are read through its tool or by the person who merges)\n`, rc: 0 };
  for (const n of workflowFiles(ctx.root)) {
    const f = `${ctx.root}/.github/workflows/${n}`;
    if (!isFile(f)) continue;
    if (workflowHasPr(fileLines(ctx, f))) return { text: `ci: present (.github/workflows/${n})\n`, rc: 0 };
  }
  return { text: `ci: absent\n${CI_WARN}\n`, rc: 1 };
}

/** @param {Context} ctx */
function ciCheck(ctx) {
  const r = ciCheckResult(ctx);
  ctx.out(r.text);
  return r.rc;
}

/** `ci_absent`: true only when ci-check says absent (unknown and present are not a block). @param {Context} ctx */
export function ciAbsent(ctx) {
  const r = ciCheckResult(ctx);
  return r.rc !== 0 && r.text.split('\n')[0] === 'ci: absent';
}

/** `ci_join`: the lines with a field joined by "; ". @param {string[]} lines */
function ciJoin(lines) { return lines.filter((l) => /[^ \t\n]/.test(l)).join('; '); }

/** @param {string} text */
function envLines(text) { return `${text}\n`.split('\n').slice(0, -1); }

/** `ci_task_command`: one pasteable line that asks for the missing workflow, with the project's own build and test commands. @param {Context} ctx */
export function ciTaskCommandText(ctx) {
  const cfg = ctx.config();
  let b = ciJoin(cfg.cmds('commands.build'));
  let t = ciJoin(cfg.cmds('commands.test'));
  if (b === '') b = ciJoin(envLines(ctx.env.PROOFLINE_CI_BUILD ?? ''));
  if (t === '') t = ciJoin(envLines(ctx.env.PROOFLINE_CI_TEST ?? ''));
  if (b === '') b = '(none found; add yours)';
  if (t === '') t = '(none found; add yours)';
  if (platformField(ctx) === 'gitlab') return `/proofline task Add a GitLab CI pipeline (.gitlab-ci.yml) that runs on merge requests and runs: build: ${b}; test: ${t} (the pipeline must run for merge requests)`;
  return `/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: ${b}; test: ${t} (the workflow must trigger on pull_request)`;
}

/** @param {Context} ctx */
function ciTaskCommand(ctx) {
  ctx.out(`${ciTaskCommandText(ctx)}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function designRationales(ctx, args) {
  const first = args[0];
  if (first === undefined || first === '') throw unsupported('usage');
  const id = bytes(first);
  if (id !== '-') requireRun(ctx, id);
  const rest = args.slice(1);
  let json = false;
  let outFile = '';
  for (;;) {
    if (rest[0] === '--json') { json = true; rest.shift(); } else if (rest[0] === '--out' && rest.length > 1) { outFile = rest[1]; rest.splice(0, 2); } else break;
  }
  if (outFile !== '' && (!json || id === '-')) fail('--out writes the --json object of a run: agent.sh design-rationales <ID> --json --out reviews/visual-proof/<name>.json');
  let file = rest[0] ?? '';
  if (file === '') {
    for (const c of DESIGN_MD_CANDIDATES) if (isFile(`${ctx.root}/${c}`)) { file = `${ctx.root}/${c}`; break; }
  } else {
    file = Buffer.from(bytes(file), 'latin1').toString('utf8');
    const local = onDiskLocal(ctx.cwd, file);
    if (local === null) throw unsupported('design document is not a readable file');
    file = local;
    // awk cannot open a missing file and prints its own message: the shell code decides
    if (!isFile(file)) {
      try { if (statSync(file).isDirectory()) throw unsupported('design document is a directory'); } catch (e) { if (e instanceof ProoflineError) throw e; }
      if (!isFile(file)) throw unsupported('design document is not a readable file');
    }
  }
  const text = file === '' ? null : fileText(ctx, file);
  if (file !== '' && text === null) throw unsupported('design document is not readable');
  let out = '';
  let sep = '';
  let obj = '';
  let carried = 0;
  let napp = 0;
  const rel = file === '' ? '' : path.relative(ctx.root, file).split(path.sep).join('/');
  for (const rid of text === null ? [] : rationaleIds(text)) {
    const t = rationaleLineIn(rid, text ?? '');
    if (t === '') continue;
    const b = sha256(t);
    // A361: an approval of this run, or one the user gave in an earlier task, batch or run for exactly this line of this document (the standing store)
    const own = findApproval(ctx, id, `rationale:${rid}`, b) !== null;
    const stand = !own && rel !== '' && rationaleCarried(ctx, rid, rel, b);
    const approved = own || stand;
    if (stand) carried++;
    if (json) {
      if (!approved) continue;
      obj += `${sep}"${rid}": "${b}"`;
      sep = ', ';
      napp++;
    } else out += `${rid}\t${approved ? 'approved' : 'unapproved'}\t${t.slice(t.indexOf(': ') + 2)}\n`;
  }
  if (json) out += `{"approved": {${obj}}}\n`;
  if (outFile !== '') return writeApprovedFile(ctx, id, outFile, out, napp, carried);
  ctx.out(out);
  return 0;
}

/**
 * `design-rationales ID --json --out FILE` (A361, issue 338 C3): the control plane writes the approved-rationales object the QA visual lint takes (`--approved-rationales`), so
 * no role builds a control file by hand. FILE must be a new or existing regular file under `reviews/visual-proof/` of the run (never a link); the command prints the file, the counts
 * and `lint-paths:`, the existing files the task changed (the lint is limited to the task's own files: a finding of an untouched committed file is not a finding of this change).
 * @param {Context} ctx @param {string} id @param {string} outFile @param {string} body @param {number} n @param {number} carried
 */
function writeApprovedFile(ctx, id, outFile, body, n, carried) {
  const dir = runDir(ctx, id);
  const base = path.resolve(dir, 'reviews/visual-proof');
  const target = path.resolve(outFile.startsWith('.agents/') ? ctx.root : dir, outFile);   // run-relative, or relative to the project root when it starts with .agents/
  if (path.dirname(target) !== base || !/^[A-Za-z0-9._-]+\.json$/.test(path.basename(target))) fail(`--out must be a .json file directly under .agents/runs/${id}/reviews/visual-proof/`);
  mkdirSync(base, { recursive: true });
  try { const st = lstatSync(target); if (st.isSymbolicLink() || !st.isFile()) fail('--out is not a regular file'); } catch (e) { if (e instanceof ProoflineError) throw e; }
  writeFileSync(target, Buffer.from(body, 'latin1'));
  const paths = taskChangedPaths(ctx, dir).filter((p) => !/[,\n]/.test(p) && isFile(`${ctx.root}/${p}`));
  ctx.out(`approved-rationales: ${path.relative(ctx.root, target).split(path.sep).join('/')} (${n} approved, ${carried} of them carried from standing approvals)\nlint-paths: ${paths.join(',')}\n`);
  return 0;
}

/** @param {Context} ctx */
function commandsCheck(ctx) {
  const f = `${sharedDirOf(ctx, 'commands')}/PROPOSAL.tsv`;
  if (!nonEmpty(f)) fail('no commands proposal (proofline doctor --commands)');
  const full = hashOf(f);
  const h = full.slice(0, 12);
  if (batchApproval(ctx) !== null) {
    const summary = fileLines(ctx, `${sharedDirOf(ctx, 'batch')}/SUMMARY.md`);
    if (summary.includes(`commands proposal: ${h}`)) { ctx.out(`commands ${h}: covered by the batch approval\n`); return 0; }
  }
  if (findApproval(ctx, '-', 'commands', full) === null) fail('the user\'s newest message does not approve the commands: no unconsumed commands approval is bound to this proposal (ask: agent.sh request-approval - commands, relay it; the reply "approve commands" records the approval)');
  ctx.out(`commands ${h}: approved by the user\n`);
  return 0;
}

/** `[ -s FILE ]` @param {string} f */
function nonEmpty(f) { try { return statSync(f).size > 0; } catch { return false; } }

/** @param {Context} ctx */
function scaleCheck(ctx) {
  const f = `${sharedDirOf(ctx, 'scale')}/PROPOSAL.tsv`;
  if (!nonEmpty(f)) fail('no scale proposal (proofline doctor --scale)');
  const full = hashOf(f);
  if (findApproval(ctx, '-', 'scale', full) === null) fail('the user\'s newest message does not approve the scale: no unconsumed scale approval is bound to this proposal (ask: agent.sh request-approval - scale, relay it; the reply "approve scale" records the approval)');
  ctx.out(`scale ${full.slice(0, 12)}: approved by the user\n`);
  return 0;
}

/** @param {Context} ctx */
function batchCheck(ctx) {
  if (batchApproval(ctx) === null) fail('no valid batch approval for the current summary (agent.sh batch-plan, then the user\'s reply "approve batch")');
  ctx.out(`${hashOf(`${sharedDirOf(ctx, 'batch')}/SUMMARY.md`)}\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const CHECK_HANDLERS = {
  'ci-check': ciCheck,
  'ci-task-command': ciTaskCommand,
  'design-rationales': designRationales,
  'commands-check': commandsCheck,
  'scale-check': scaleCheck,
  'batch-check': batchCheck,
};
