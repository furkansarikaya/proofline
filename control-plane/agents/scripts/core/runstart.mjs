// @ts-check
// Stage 4, package 4B: `start`. The task adapter (markdown import, status, create) is the built-in one of core/adapters (a project script of the same name wins, A216).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bytes } from './config.mjs';
import { dbSnapshot, dbBaselineFile } from './dbguard.mjs';
import { fail, unsupported } from './errors.mjs';
import { requireLead } from './approve.mjs';
import { batchMember } from './next.mjs';
import { testCmdPin } from './testmeasure.mjs';
import { led } from './lifeutil.mjs';
import { isFile } from './paths.mjs';
import { notRunRelative } from './pathin.mjs';
import { runTaskAdapter } from './adapters/index.mjs';
import { textLines, validTaskId } from './records.mjs';
import { activeRun, openRuns, runDir } from './runs.mjs';
import { statusBlockUpdate } from './statusblock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** A byte string as an argument for a child (the bytes must be UTF-8). @param {string} s */
export function toArg(s) {
  const back = Buffer.from(s, 'latin1').toString('utf8');
  if (bytes(back) !== s) throw unsupported('argument is not UTF-8');
  return back;
}

/** `db_guard_baseline ID`: the database files as they are when the run starts. @param {Context} ctx @param {string} id */
export function dbGuardBaseline(ctx, id) {
  const f = dbBaselineFile(ctx, id);
  try {
    mkdirSync(path.dirname(f), { recursive: true });
    const rows = dbSnapshot(ctx);
    writeFileSync(`${f}.tmp`, rows.length === 0 ? '' : `${rows.join('\n')}\n`, 'latin1');
    renameSync(`${f}.tmp`, f);
  } catch { /* best effort, like the shell */ }
}

/** A task adapter call: stderr goes to the user, stdout is returned (and shown unless `capture`). @param {Context} ctx @param {string[]} args @param {boolean} capture */
function adapterRun(ctx, args, capture) {
  const r = runTaskAdapter(ctx, 'markdown', args) ?? { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.from('markdown task adapter is missing\n') };
  const out = r.stdout.toString('latin1');
  if (r.stderr.length) ctx.err(r.stderr.toString('latin1'));
  if (!capture && out !== '') ctx.out(out);
  return { status: r.status, out: out.replace(/\n+$/, '') };
}

/** @param {string} s a path or an adapter name that goes into RUN.yaml */
function plainValue(s) {
  if (/[\x00-\x1f\x7f"\\]/.test(s)) fail('refusing to record a task path or adapter name with a control character, a quote or a backslash');
  return s;
}

/** `start_run ID [--title TITLE] [--task-file PATH]` @param {Context} ctx @param {string[]} argv */
export function startRun(ctx, argv) {
  requireLead(ctx);
  const id = bytes(argv[0] ?? '');
  if (id === '') fail('usage: agent.sh start <TASK-ID> [--title TITLE] [--task-file PATH]');
  if (!validTaskId(id)) fail(`invalid task id: ${id}`);
  if (/^[^A-Za-z0-9]/.test(id) || id.includes('..')) fail(`invalid task id: ${id}`);
  let title = ''; let file = '';
  const rest = argv.slice(1);
  while (rest.length > 0) {
    if (rest.length < 2) fail('start option needs a value');
    const opt = rest[0]; const val = bytes(rest[1]);
    if (opt === '--title') title = val; else if (opt === '--task-file') file = val; else fail(`unknown start option: ${bytes(opt)}`);
    rest.splice(0, 2);
  }
  const dir = runDir(ctx, id);
  if (existsSync(dir)) fail(`run already exists: ${id}`);
  const open = openRuns(ctx).join('\n');
  if (open !== '') {
    // inside an approved batch the task has a worktree of its own (A169): the lead must run the command there, not in the folder that holds another run (A225)
    const hint = batchMember(ctx, id) ? ` ${id} belongs to the approved batch: run this command from the task's own worktree, .agents/local/worktrees/${id} (agent.sh worktree-add ${id} makes it; agent.sh batch-next names it), not from this folder.` : '';
    fail(`another open run exists in this worktree: ${open}. A second run needs a worktree of its own: agent.sh worktree-add <TASK-ID> in the main working tree (night mode does it for every task, A169)${hint}`);
  }
  const active = activeRun(ctx);
  if (active !== '') fail(`another active run exists: ${active}`);
  const adapter = ctx.config().get('tasks.adapter', 'markdown');
  const tasks = ctx.config().get('tasks.dir', '.agents/tasks');
  if (notRunRelative(tasks)) fail(`tasks.dir must be project-relative: ${tasks}`);
  const tmpd = mkdtempSync(`${tmpdir()}/agent-start.`);
  const tmp = `${tmpd}/task`;
  try {
    let taskPath;
    if (file !== '') {
      const root = bytes(ctx.root);
      const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file.replace(/^\.\//, '');
      if (!rel.startsWith(`${tasks}/`)) fail(`task file must be under tasks.dir (${tasks}): ${file}`);
      if (rel.includes('..')) fail(`invalid task path: ${file}`);
      if (!isFile(`${ctx.root}/${Buffer.from(rel, 'latin1').toString('utf8')}`)) fail(`task file missing: ${file}`);
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (!(name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith('.md')))) fail(`task file name must start with ${id}: ${file}`);
      const imp = adapterRun(ctx, ['import', toArg(rel), tmp], false);
      if (imp.status !== 0) return imp.status;
      const head = textLines(readFileSync(tmp, 'latin1'))[0] ?? '';
      const m = /^# Task: ([^ ]*) .*/.exec(head);
      if ((m ? m[1] : '') !== id) fail(`task file ID does not match ${id}`);
      const st = adapterRun(ctx, ['status', id, 'in-progress', toArg(rel)], true);
      if (st.status !== 0) fail('could not move task to in-progress');
      taskPath = st.out;
    } else {
      let body;
      try { body = readFileSync(0, 'latin1'); } catch { body = ''; }
      writeFileSync(tmp, body, 'latin1');
      if (title === '') { const m = /^# Task: [^ ]* — (.*)$/.exec(Buffer.from(textLines(body)[0] ?? '', 'latin1').toString('utf8')); title = m ? bytes(m[1]) : ''; }
      if (title === '') { ctx.out('MISSING title\n'); return 3; }
      const cr = adapterRun(ctx, ['create', id, toArg(title), tmp], true);
      if (cr.status !== 0) { ctx.out(`${cr.out}\n`); return cr.status; }
      taskPath = cr.out;
      const imp = adapterRun(ctx, ['import', taskPath, tmp], false);
      if (imp.status !== 0) fail('created task could not be imported');
    }
    plainValue(taskPath); plainValue(adapter);
    const template = readFileSync(`${ctx.agents}/templates/RUN.yaml`, 'latin1');
    let section = '';
    const out = [];
    for (const l of textLines(template)) {
      if (l === 'task:') section = 'task';
      if (l === 'task_source:') section = 'task_source';
      if (l === 'completion_report:') section = 'completion_report';
      if (/^[^ \t\n\v\f\r#]/.test(l) && !/^(task|task_source|completion_report):$/.test(l)) section = '';
      if (section === 'task' && l.startsWith('  id:')) { out.push(`  id: ${id}`); continue; }
      if (section === 'task_source' && l.startsWith('  type:')) { out.push('  type: local_markdown'); continue; }
      if (section === 'task_source' && l.startsWith('  path:')) { out.push(`  path: ${taskPath}`); continue; }
      if (section === 'completion_report' && l.startsWith('  adapter:')) { out.push(`  adapter: ${adapter}`); continue; }
      out.push(l);
    }
    const marker = `${ctx.root}/${ctx.config().get('active_run_file', '.agents/local/ACTIVE_RUN')}`;
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(`${dir}/RUN.yaml`, out.map((l) => `${l}\n`).join(''), 'latin1');
    writeFileSync(`${dir}/TASK.md`, readFileSync(tmp));
    writeFileSync(marker, `${id}\n`);
    ctx.forget('file:');
    led(ctx, id, 'start', '-', 'PLANNED', `task=${taskPath} adapter=${adapter} measure=1`);
    led(ctx, id, 'test-cmd-pin', '-', '-', `testcmd=${testCmdPin(ctx.config().cmds('commands.test'))}`); // the project test command as the run started (A275): the implementer cannot change it later
    dbGuardBaseline(ctx, id);
    statusBlockUpdate(ctx, id, 'run-start');
    ctx.out(`run started: ${id} task=${taskPath}\n`);
    return 0;
  } finally { rmSync(tmpd, { recursive: true, force: true }); }
}
