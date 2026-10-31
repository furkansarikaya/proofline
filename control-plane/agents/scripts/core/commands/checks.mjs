// @ts-check
// Stage 2, package C2: ci-check, ci-task-command, design-rationales, commands-check, scale-check, batch-check. The last four read the
// approval and batch library (core/approvals.mjs, the read-only part); nothing here writes or consumes an approval, so no path needs a
// BridgeToShell for the Stage 3-7 libraries. Keeps arguments, stdout, stderr and exit status of agent.sh 0.0.41.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { bytes } from '../config.mjs';
import { BridgeToShell, fail } from '../errors.mjs';
import { DESIGN_MD_CANDIDATES, batchApproval, findApproval, hashOf, rationaleIds, rationaleLineIn, sharedDirOf } from '../approvals.mjs';
import { sha256 } from '../hash.mjs';
import { isFile } from '../paths.mjs';
import * as proc from '../proc.mjs';
import { fileLines, fileText } from '../records.mjs';
import { requireRun } from '../runs.mjs';

/** @typedef {import('../context.mjs').Context} Context */

const CI_WARN = 'no CI check runs on pull requests here. proofline merge verifies the commit locally instead (commands.build and commands.test in a clean copy) and the pull request says "verified locally, no CI".';

/** `sh platform.sh field platform -C ROOT 2>/dev/null || echo other`, as a `$(...)` value. @param {Context} ctx */
function platformField(ctx) {
  const r = proc.run('sh', [`${ctx.scripts}/platform.sh`, 'field', 'platform', '-C', ctx.root], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  let out = r.stdout.toString('latin1');
  if (r.status !== 0) out += 'other\n';
  return out.replace(/\n+$/, '');
}

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

/** @param {Context} ctx */
function ciCheck(ctx) {
  const pf = platformField(ctx);
  if (pf === 'gitlab') {
    if (isFile(`${ctx.root}/.gitlab-ci.yml`)) { ctx.out('ci: present (.gitlab-ci.yml)\n'); return 0; }
    ctx.out(`ci: absent\n${CI_WARN}\n`);
    return 1;
  }
  if (pf === 'azure') {
    for (const f of ['azure-pipelines.yml', 'azure-pipelines.yaml', '.azure-pipelines']) {
      if (existsSync(`${ctx.root}/${f}`)) { ctx.out(`ci: present (${f})\n`); return 0; }
    }
    ctx.out('ci: unknown (Azure DevOps build policies are not visible from the repository files)\n');
    return 0;
  }
  if (pf !== 'github') { ctx.out(`ci: unknown (platform ${pf}: checks are read through its tool or by the person who merges)\n`); return 0; }
  for (const n of workflowFiles(ctx.root)) {
    const f = `${ctx.root}/.github/workflows/${n}`;
    if (!isFile(f)) continue;
    if (workflowHasPr(fileLines(ctx, f))) { ctx.out(`ci: present (.github/workflows/${n})\n`); return 0; }
  }
  ctx.out(`ci: absent\n${CI_WARN}\n`);
  return 1;
}

/** `ci_join`: the lines with a field joined by "; ". @param {string[]} lines */
function ciJoin(lines) { return lines.filter((l) => /[^ \t\n]/.test(l)).join('; '); }

/** @param {string} text */
function envLines(text) { return `${text}\n`.split('\n').slice(0, -1); }

/** @param {Context} ctx */
function ciTaskCommand(ctx) {
  const cfg = ctx.config();
  let b = ciJoin(cfg.cmds('commands.build'));
  let t = ciJoin(cfg.cmds('commands.test'));
  if (b === '') b = ciJoin(envLines(ctx.env.PROOFLINE_CI_BUILD ?? ''));
  if (t === '') t = ciJoin(envLines(ctx.env.PROOFLINE_CI_TEST ?? ''));
  if (b === '') b = '(none found; add yours)';
  if (t === '') t = '(none found; add yours)';
  if (platformField(ctx) === 'gitlab') {
    ctx.out(`/proofline task Add a GitLab CI pipeline (.gitlab-ci.yml) that runs on merge requests and runs: build: ${b}; test: ${t} (the pipeline must run for merge requests)\n`);
    return 0;
  }
  ctx.out(`/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: ${b}; test: ${t} (the workflow must trigger on pull_request)\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function designRationales(ctx, args) {
  const first = args[0];
  if (first === undefined || first === '') throw new BridgeToShell('usage');
  const id = bytes(first);
  if (id !== '-') requireRun(ctx, id);
  const rest = args.slice(1);
  let json = false;
  if (rest[0] === '--json') { json = true; rest.shift(); }
  let file = rest[0] ?? '';
  if (file === '') {
    for (const c of DESIGN_MD_CANDIDATES) if (isFile(`${ctx.root}/${c}`)) { file = `${ctx.root}/${c}`; break; }
  } else {
    file = Buffer.from(bytes(file), 'latin1').toString('utf8');
    if (!file.startsWith('/')) file = `${ctx.cwd}/${file}`;
    // awk cannot open a missing file and prints its own message: the shell code decides
    if (!isFile(file)) {
      try { if (statSync(file).isDirectory()) throw new BridgeToShell('directory'); } catch (e) { if (e instanceof BridgeToShell) throw e; }
      if (!isFile(file)) throw new BridgeToShell('design document is not a readable file');
    }
  }
  const text = file === '' ? null : fileText(ctx, file);
  if (file !== '' && text === null) throw new BridgeToShell('design document is not readable');
  let out = '';
  let sep = '';
  let obj = '';
  for (const rid of text === null ? [] : rationaleIds(text)) {
    const t = rationaleLineIn(rid, text ?? '');
    if (t === '') continue;
    const b = sha256(t);
    const approved = findApproval(ctx, id, `rationale:${rid}`, b) !== null;
    if (json) {
      if (!approved) continue;
      obj += `${sep}"${rid}": "${b}"`;
      sep = ', ';
    } else out += `${rid}\t${approved ? 'approved' : 'unapproved'}\t${t.slice(t.indexOf(': ') + 2)}\n`;
  }
  if (json) out += `{"approved": {${obj}}}\n`;
  ctx.out(out);
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
