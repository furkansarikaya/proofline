// @ts-check
// Stage 2, package TOOLS: the self-contained leaf commands (no ledger, gate or fingerprint library). Each keeps arguments, stdout, stderr and
// exit status of agent.sh 0.0.41. An argument shape whose shell text is shell-specific (`${2:?usage}`, a backslash, a newline in a path) throws
// BridgeToShell before any output; the entry then runs the shell code.
//
// Taken: debt, task-type, task-scope-entries, scope-covers, human-checks, questions, repro-normalize, design-surface, test-path, path-kind,
// scope-kinds. Left (they read the approval or batch library, stage 3): design-rationales, commands-check, scale-check, batch-check.
import { readSync, readdirSync, statSync } from 'node:fs';
import { bytes } from '../config.mjs';
import { debt } from '../debt.mjs';
import { BridgeToShell, ProoflineError, fail } from '../errors.mjs';
import { designGlobMatch, PathKinds, scopeKindRows } from '../pathkind.mjs';
import { isDir, isFile } from '../paths.mjs';
import { afterFrontMatter, evidenceField, humanChecks, readBytes, scopeEntries, scopeEntryCovers, taskType } from '../taskfile.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** An argument as a byte string; text that is not valid UTF-8 cannot travel through process.argv, so the shell decides. @param {string | undefined} a */
function arg(a) {
  const s = a ?? '';
  if (s.includes('�')) throw new BridgeToShell('argument is not UTF-8');
  return bytes(s);
}

/** A byte-string path as a path on disk. @param {Context} ctx @param {string} s */
function disk(ctx, s) {
  const back = Buffer.from(s, 'latin1').toString('utf8');
  if (bytes(back) !== s) throw new BridgeToShell('path is not UTF-8');
  return back.startsWith('/') ? back : `${ctx.cwd}/${back}`;
}

/** `${N:?usage}` -> the shell prints a shell-specific error for a missing or empty argument. @param {string | undefined} a */
function required(a) {
  if (a === undefined || a === '') throw new BridgeToShell('missing argument');
  return arg(a);
}

/** @param {Context} ctx */
function requireLead(ctx) {
  if (ctx.role !== 'lead') throw new ProoflineError(`command denied for ${ctx.role} (lead only)`, 1);
}

/** @param {Context} ctx @param {string[]} args */
function debtCommand(ctx, args) {
  const op = args[0] === undefined || args[0] === '' ? 'list' : arg(args[0]);
  if (op === 'page') requireLead(ctx);
  return debt(ctx, op);
}

/** @param {Context} ctx @param {string[]} args */
function taskTypeCommand(ctx, args) {
  if (args.length !== 1) fail('usage: agent.sh task-type <TASK.md>');
  const file = disk(ctx, arg(args[0]));
  const text = readBytes(file);
  // awk cannot open the file: its exit status 2 ends the shell (set -e) with no output
  if (text === null && !isDir(file)) return 2;
  ctx.out(`${taskType(text ?? '')}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function taskScopeEntries(ctx, args) {
  if (args.length !== 2) fail('usage: agent.sh task-scope-entries <task-file> <heading>');
  const file = disk(ctx, arg(args[0]));
  if (!isFile(file)) return 0;
  const text = readBytes(file);
  if (text === null) throw new BridgeToShell('task file unreadable');
  for (const e of scopeEntries(text, arg(args[1]))) ctx.out(`${e}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function scopeCovers(ctx, args) {
  if (args.length !== 2) fail('usage: agent.sh scope-covers <entry> <path>');
  return scopeEntryCovers(arg(args[0]), arg(args[1])) ? 0 : 1;
}

/** @param {Context} ctx @param {string[]} args */
function humanChecksCommand(ctx, args) {
  const id = required(args[0]);
  const f = `${ctx.runDir(id)}/QA_REPORT.md`;
  if (!isFile(f)) return 0;
  const text = readBytes(f);
  if (text === null) throw new BridgeToShell('QA_REPORT.md unreadable');
  for (const l of humanChecks(text)) ctx.out(`${l}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function questions(ctx, args) {
  const id = required(args[0]);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('invalid task id');
  const dir = ctx.runDir(id);
  if (!isDir(dir)) fail(`run not found: ${id}`);
  // a run under its own delivery commit is judged from base_sha by require_run (git work): the shell code decides
  if (isFile(`${ctx.root}/.agents/local/deliver/${id}/SUMMARY.md`)) throw new BridgeToShell('delivered run');
  const qd = `${dir}/questions`;
  let names = [];
  try { names = readdirSync(qd, { encoding: 'latin1' }).filter((n) => /^[0-9][0-9][0-9]\.md$/.test(n)).sort(); } catch { names = []; }
  const exists = (/** @type {string} */ p) => { try { statSync(p); return true; } catch { return false; } };
  let any = false;
  for (const n of names) {
    const f = `${qd}/${n}`;
    if (!exists(f)) continue;
    if (exists(`${f.slice(0, -3)}.answer.md`)) continue;
    const text = readBytes(f);
    if (text === null || (text !== '' && !text.endsWith('\n'))) throw new BridgeToShell('question file shape');
    any = true;
    ctx.out(`=== QUESTION ${n.slice(0, 3)} (from ${evidenceField(text, 'from') ?? ''})\n`);
    for (const l of afterFrontMatter(text)) ctx.out(`${l}\n`);
  }
  if (!any) ctx.out(`no pending questions: ${id}\n`);
  return 0;
}

/** Standard input as a byte string. @param {Context} ctx */
function readStdin(ctx) {
  const given = /** @type {{ stdinText?: string }} */ (ctx.io).stdinText;
  if (given !== undefined) return given;
  /** @type {Buffer[]} */ const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = readFileSyncRead(buf); } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF' || code === 'EBADF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('latin1');
}

/** @param {Buffer} buf */
function readFileSyncRead(buf) { return readSync(0, buf, 0, buf.length, null); }

/** @type {Array<[RegExp, string]>} */
const NORMALIZE = [
  [/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?/g, '<TIMESTAMP>'],
  [/(^|[^0-9:])[0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?/g, '$1<TIME>'],
  [/((^|[^A-Za-z])([Ii]n|[Tt]ook|[Dd]uration|[Ee]lapsed|[Tt]ime)[ :=]+)[0-9]+(\.[0-9]+)? ?(ms|sec|secs|seconds|min|s|m)([^A-Za-z0-9]|$)/g, '$1<DURATION>$6'],
  [/\([0-9]+(\.[0-9]+)? ?(ms|s)\)/g, '(<DURATION>)'],
  [/^(<TIME> )?\[build\] Complete!( in <DURATION>| \(<DURATION>\))?$/, '[build] Complete!'],
];

/** @param {Context} ctx */
function reproNormalize(ctx) {
  const text = readStdin(ctx);
  // sed keeps a missing final newline missing (GNU and BSD alike)
  const lines = text.split('\n');
  const last = lines.pop() ?? '';
  const norm = (/** @type {string} */ l) => { let s = l; for (const [re, to] of NORMALIZE) s = s.replace(re, to); return s; };
  for (const l of lines) ctx.out(`${norm(l)}\n`);
  if (last !== '') ctx.out(norm(last));
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function designSurface(ctx, args) {
  const given = required(args[0]);
  const f = given.startsWith('./') ? given.slice(2) : given;
  const pk = new PathKinds(ctx);
  const cfg = ctx.config();
  const names = pk.surfaceNames();
  const exists = (/** @type {string} */ rel) => isFile(disk(ctx, `${ctx.root}/${rel}`));
  if (names.length === 0) {
    const d = cfg.get('design_docs.design', 'docs/design/DESIGN.md');
    ctx.out(`mode=single\nstatus=ok\nsurface=-\nvisitor_mode=-\ndoc=${d}\ndoc_exists=${exists(d) ? 'yes' : 'no'}\nshared=-\nshared_exists=no\n`);
    return 0;
  }
  const sh = cfg.get('design_docs.design.shared', '');
  const she = sh !== '' && exists(sh) ? 'yes' : 'no';
  const hits = names.filter((s) => designGlobMatch(f, cfg.get(`design_docs.design.surfaces.${s}.paths`, '')));
  if (hits.length > 1) {
    ctx.out(`mode=surfaces\nstatus=overlap\nsurface=-\nsurfaces=${hits.join(' ')}\n`);
    ctx.err(`design-surface: ${f} matches more than one surface (${hits.join(' ')}): narrow the paths of design_docs.design.surfaces in .agents/config.yaml\n`);
    return 1;
  }
  if (hits.length === 0) {
    ctx.out(`mode=surfaces\nstatus=no-surface\nsurface=-\nvisitor_mode=-\ndoc=-\ndoc_exists=no\nshared=${sh === '' ? '-' : sh}\nshared_exists=${she}\n`);
    if (sh === '') ctx.err(`warning: no design surface matches ${f} and design_docs.design.shared is not set: no design document applies to it\n`);
    return 0;
  }
  const s = hits[0];
  const d = cfg.get(`design_docs.design.surfaces.${s}.doc`, '');
  const e = d !== '' && exists(d) ? 'yes' : 'no';
  ctx.out(`mode=surfaces\nstatus=${e === 'yes' ? 'ok' : 'new-direction'}\nsurface=${s}\nvisitor_mode=${cfg.get(`design_docs.design.surfaces.${s}.mode`, '-')}\ndoc=${d === '' ? '-' : d}\ndoc_exists=${e}\nshared=${sh === '' ? '-' : sh}\nshared_exists=${she}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function testPath(ctx, args) {
  if (args.length === 0) fail('usage: agent.sh test-path <path>...');
  const pk = new PathKinds(ctx);
  for (const a of args) { const p = arg(a); ctx.out(`${pk.testCodePath(p) ? 'test' : 'product'}\t${p}\n`); }
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function pathKind(ctx, args) {
  if (args.length === 0) fail('usage: agent.sh path-kind <path>...');
  const pk = new PathKinds(ctx);
  for (const a of args) { const p = arg(a); ctx.out(`${pk.pathKind(p)}\t${p}\n`); }
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function scopeKinds(ctx, args) {
  const id = required(args[0]);
  const f = `${ctx.runDir(id)}/PLAN.md`;
  const text = isFile(f) ? readBytes(f) : null;
  if (text === null) throw new BridgeToShell('PLAN.md missing: awk prints its own error');
  ctx.out(scopeKindRows(new PathKinds(ctx), text));
  return 0;
}

/** The commands of package TOOLS, appended to HANDLERS by moved.mjs. @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const TOOLS_HANDLERS = {
  debt: debtCommand,
  'task-type': taskTypeCommand,
  'task-scope-entries': taskScopeEntries,
  'scope-covers': scopeCovers,
  'human-checks': humanChecksCommand,
  questions,
  'repro-normalize': reproNormalize,
  'design-surface': designSurface,
  'test-path': testPath,
  'path-kind': pathKind,
  'scope-kinds': scopeKinds,
};
