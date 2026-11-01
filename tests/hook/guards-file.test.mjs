// @ts-check
// The file-tool PreToolUse guards (adapters/claude/hooks/guards/{read,write,other}.mjs) against the shell hook (the specification) on a corpus
// of recorded and adversarial inputs: the same verdict and the same deny text (the shell adds only the alternative hint and the "proofline: "
// prefix, which the router owns). Cases where the Node guard is stricter on purpose (a closed hole of the shell) are listed apart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, finish } from '../../adapters/claude/hooks/lib/context.mjs';
import { readGuard } from '../../adapters/claude/hooks/guards/read.mjs';
import { writeGuard } from '../../adapters/claude/hooks/guards/write.mjs';
import { otherGuard } from '../../adapters/claude/hooks/guards/other.mjs';
import { buildTemplate, haveJq, runHook, cleanEnv, copyProject, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, existsSync } from './harness.mjs';
import { symlinkSync, linkSync } from 'node:fs';

const skip = haveJq ? false : 'jq is required for the shell hook';
/** @type {string} */ let base = '';
/** @type {string} */ let runDir = '';
/** @type {string} */ let noRunDir = '';
/** @type {string} */ let outside = '';
/** @type {string} */ let template = '';
let caseSensitive = true;

const PLAN = '---\nscope:\n  - path: impl.txt\n  - path: lib/\n---\n';

/** @param {string} d */
function prepare(d) {
  mkdirSync(join(d, 'src'), { recursive: true });
  mkdirSync(join(d, '.agents/local/windows'), { recursive: true });
  writeFileSync(join(d, '.agents/local/windows/a7'), 'W\n');
  mkdirSync(join(d, 'docs/wiki'), { recursive: true });
  writeFileSync(join(d, 'impl.txt'), 'x\n');
  writeFileSync(join(d, 'src/app.js'), 'x\n');
  writeFileSync(join(d, 'hard1.txt'), 'x\n'); linkSync(join(d, 'hard1.txt'), join(d, 'hard2.txt'));
  mkdirSync(join(d, '.agents/runs/LC/amendments'), { recursive: true });
  symlinkSync(join(d, '.agents/local/prompts'), join(d, '.agents/runs/LC/amendments/f.json'));
  symlinkSync(outside, join(d, 'escape'));
  symlinkSync(join(d, '.agents/local'), join(d, 'viaLocal'));
  symlinkSync(join(d, 'nowhere'), join(d, 'dangling'));
  symlinkSync(join(d, 'src'), join(d, 'srcLink'));
  mkdirSync(join(d, 'sub/deep'), { recursive: true });
  symlinkSync(join(d, 'sub/deep'), join(d, 'linkdeep'));
  mkdirSync(join(outside, 'deep'), { recursive: true });
  symlinkSync(join(outside, 'deep'), join(d, 'escdeep'));
  writeFileSync(join(d, 'data.db'), '');
  writeFileSync(join(d, '.git/info/exclude'), 'dist/\n', { flag: 'a' });
  writeFileSync(join(d, '.agents/runs/LC/PLAN.md'), PLAN);
}

before(() => {
  template = buildTemplate();
  base = mkdtempSync(join(tmpdir(), 'hook-gf-'));
  outside = join(base, 'elsewhere');
  mkdirSync(outside);
  runDir = copyProject(template, base);
  prepare(runDir);
  rmSync(template, { recursive: true, force: true });
  template = buildTemplate({ run: false });
  noRunDir = copyProject(template, base);
  prepare(noRunDir);
  caseSensitive = !existsSync(join(runDir, 'IMPL.TXT'));
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** The Node side: the guard the router would pick for the tool. @param {string} dir @param {any} payload @param {Record<string, string>} env */
async function nodeVerdict(dir, payload, env) {
  const raw = Buffer.from(JSON.stringify({ cwd: dir, session_id: 's1', ...payload }));
  const ctx = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: dir, ...env }));
  assert.ok(ctx);
  try {
    const t = payload.tool_name;
    const r = /^(Read|Glob|Grep)$/.test(t) ? await readGuard(ctx.input, ctx) : /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t) ? await writeGuard(ctx.input, ctx) : await otherGuard(ctx.input, ctx);
    return r;
  } finally { finish(ctx); }
}

/** @param {string} out the shell hook's stdout @returns {string | null} the deny reason without the prefix */
function shellReason(out) {
  if (out.trim() === '') return null;
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  return j.hookSpecificOutput.permissionDecisionReason;
}

/**
 * @typedef {{ n: string, tool: string, input: (d: string) => any, who?: string, env?: Record<string, string>, run?: boolean, stricter?: boolean, expect?: 'deny' | 'allow' }} Case
 * @param {Case} c
 */
async function compare(c) {
  const dir = c.run === false ? noRunDir : runDir;
  const agent = c.who ? { agent_type: c.who.split(' ')[0], agent_id: c.who.split(' ')[1] ?? 'a1' } : {};
  const payload = { hook_event_name: 'PreToolUse', tool_name: c.tool, tool_input: c.input(dir), ...agent };
  const env = c.env ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, v.replaceAll('<P>', dir).replaceAll('<B>', base)])) : {};
  const [sh, node] = await Promise.all([runHook('sh', dir, 'pretool', payload, { env }), nodeVerdict(dir, payload, env)]);
  const sr = shellReason(sh.stdout);
  if (c.stricter) {
    assert.equal(sr, null, `${c.n}: the shell allows this one (that is the hole)`);
    assert.equal(node?.decision, 'deny', `${c.n}: the Node guard must deny`);
    return;
  }
  if (sr === null) assert.equal(node, null, `${c.n}: shell allows, node says ${node?.reason}`);
  else {
    assert.ok(node, `${c.n}: shell denies (${sr}), node allows`);
    assert.equal(node.decision, 'deny');
    assert.ok(sr === `proofline: ${node.reason}` || sr.startsWith(`proofline: ${node.reason} | `), `${c.n}: texts differ\n shell: ${sr}\n node:  ${node.reason}`);
  }
  if (c.expect) assert.equal(sr === null ? 'allow' : 'deny', c.expect, `${c.n}: expectation`);
}

/** @param {string} n @param {string} tool @param {string} p @param {Partial<Case>} [o] @returns {Case} */
const fp = (n, tool, p, o = {}) => ({ n, tool, input: (d) => ({ file_path: p.replaceAll('<P>', d).replaceAll('<B>', base) }), ...o });
/** @type {Case[]} */
const corpus = [
  // lead in a run
  fp('lead Write product', 'Write', '<P>/src/x.js', { expect: 'deny' }),
  fp('lead Edit relative product', 'Edit', 'impl.txt', { expect: 'deny' }),
  fp('lead Write PLAN.md', 'Write', '<P>/.agents/runs/LC/PLAN.md', { expect: 'allow' }),
  fp('lead Write amendment', 'Write', '.agents/runs/LC/amendments/001.md', { expect: 'allow' }),
  fp('lead Write task file', 'Write', '.agents/tasks/LC.md', { expect: 'allow' }),
  fp('lead Write gate', 'Write', '<P>/.agents/runs/LC/gates/001-VERIFY.yaml', { expect: 'deny' }),
  fp('lead Write approval', 'Write', '.agents/runs/LC/approvals/001-plan.yaml', { expect: 'deny' }),
  fp('lead Write prompt capture', 'Write', '.agents/local/prompts/forged.json', { expect: 'deny' }),
  fp('lead Edit RUN.yaml', 'Edit', '.agents/runs/LC/RUN.yaml', { expect: 'deny' }),
  fp('lead Edit LEDGER', 'Edit', '.agents/runs/LC/LEDGER.log', { expect: 'deny' }),
  fp('lead Edit settings', 'Edit', '.claude/settings.json', { expect: 'deny' }),
  fp('lead Edit settings.local', 'Edit', '.claude/settings.local.json', { expect: 'deny' }),
  fp('lead Edit hooks dir', 'Write', '.agents/hooks/x.sh', { expect: 'deny' }),
  fp('lead Edit codex hooks', 'Write', '.codex/hooks.json', { expect: 'deny' }),
  fp('lead Edit config', 'Edit', '<P>/.agents/config.yaml', { expect: 'deny' }),
  fp('lead Write githook', 'Write', '.agents/githooks/pre-commit', { expect: 'deny' }),
  fp('lead Write git config', 'Write', '.git/config', { expect: 'deny' }),
  fp('lead Write git config.worktree', 'Write', '.git/config.worktree', { expect: 'deny' }),
  fp('lead NotebookEdit', 'NotebookEdit', '<P>/src/n.ipynb', { input: (d) => ({ notebook_path: `${d}/src/n.ipynb` }) }),
  fp('lead scratch', 'Write', '.agents/runs/LC/scratch/probe.mjs', { expect: 'allow' }),
  fp('lead assignments', 'Write', '.agents/local/assignments/D.md', { expect: 'allow' }),
  fp('lead outside', 'Write', '<B>/elsewhere.txt', { expect: 'deny' }),
  fp('lead sibling prefix', 'Write', '<P>-design/DESIGN.md', { expect: 'deny' }),
  fp('lead ../x', 'Write', '<P>/../x', { expect: 'deny' }),
  fp('lead missing ../', 'Write', '.agents/runs/LC/../../../impl.txt', { expect: 'deny' }),
  fp('lead existing ../ (physical)', 'Write', 'src/../impl.txt'),
  fp('lead symlink in amendments', 'Write', '.agents/runs/LC/amendments/f.json', { expect: 'deny' }),
  fp('lead hard link', 'Write', 'hard1.txt', { expect: 'deny' }),
  fp('lead dangling link', 'Write', 'dangling', { expect: 'deny' }),
  fp('lead file under dangling link', 'Write', 'dangling/x', { expect: 'deny' }),
  fp('lead escape link', 'Write', 'escape/x.txt', { expect: 'deny' }),
  fp('lead escape link file', 'Write', 'escape', { expect: 'deny' }),
  fp('lead write via link to .agents/local', 'Write', 'viaLocal/approvals/001-push.yaml', { expect: 'deny' }),
  fp('lead write via link to src', 'Write', 'srcLink/z.js', { expect: 'deny' }),
  fp('lead without path', 'Write', '', { input: () => ({ content: 'x' }) }),
  fp('path field Edit', 'Edit', '', { input: (d) => ({ path: `${d}/src/x.js` }) }),
  // roles
  fp('explorer product', 'Write', 'impl.txt', { who: 'proofline-explorer e1', expect: 'deny' }),
  fp('explorer run report', 'Write', '.agents/runs/LC/reports/001-explorer.md', { who: 'proofline-explorer e1', expect: 'allow' }),
  fp('reviewer report', 'Write', '.agents/runs/LC/reviews/proof-review/rules/REPORT.md', { who: 'proofline-reviewer r1' }),
  fp('reviewer product', 'Write', 'src/app.js', { who: 'proofline-reviewer r1', expect: 'deny' }),
  fp('reviewer gate', 'Write', '.agents/runs/LC/gates/009-VERIFY.yaml', { who: 'proofline-reviewer r1', expect: 'deny' }),
  fp('security reviewer prefix', 'Write', '.agents/runs/LC/security/REPORT.md', { who: 'proofline:proofline-security-reviewer s1' }),
  fp('designer no window', 'Write', 'docs/design/DESIGN.md', { who: 'proofline-designer d1', expect: 'deny' }),
  fp('implementer window ok', 'Edit', 'impl.txt', { who: 'proofline:proofline-implementer a7' }),
  fp('implementer no window', 'Edit', 'impl.txt', { who: 'proofline-implementer a8', expect: 'deny' }),
  fp('implementer scope dir', 'Edit', 'lib/x.js', { who: 'proofline-implementer a7' }),
  fp('implementer out of scope', 'Write', 'src/app.js', { who: 'proofline-implementer a7', expect: 'deny' }),
  fp('implementer worker evidence', 'Write', '.agents/runs/LC/worker-evidence/RED-9.yaml', { who: 'proofline-implementer a7', expect: 'deny' }),
  fp('implementer env role', 'Edit', 'impl.txt', { env: { AGENT_ROLE: 'implementer' } }),
  fp('reviewer env role', 'Edit', 'impl.txt', { env: { AGENT_ROLE: 'reviewer' }, expect: 'deny' }),
  fp('failover implementer', 'Edit', 'impl.txt', { who: 'proofline-implementer f1', env: { AGENT_ROLE: 'implementer' } }),
  fp('non-proofline subagent', 'Edit', 'impl.txt', { who: 'general-purpose g1', expect: 'deny' }),
  fp('qa outside', 'Write', '<B>/elsewhere/n.txt', { who: 'proofline-qa q1', expect: 'deny' }),
  fp('qa runtime memory', 'Write', '<B>/home/.claude/plans/p.md', { who: 'proofline-qa q1', env: { HOME: '<B>/home' }, expect: 'allow' }),
  fp('qa runtime project memory', 'Write', '<B>/home/.claude/projects/x/memory/m.md', { who: 'proofline-qa q1', env: { HOME: '<B>/home' }, expect: 'allow' }),
  fp('qa runtime settings', 'Write', '<B>/home/.claude/settings.json', { who: 'proofline-qa q1', env: { HOME: '<B>/home' }, expect: 'deny' }),
  // database guard
  fp('Read db', 'Read', '<P>/data.db', { expect: 'deny' }),
  fp('Read db relative', 'Read', 'data.db', { expect: 'deny' }),
  fp('Read sqlite3 deep', 'Read', 'a/b/c.sqlite3', { expect: 'deny' }),
  fp('Read db in /tmp', 'Read', '/tmp/own.db', { expect: 'allow' }),
  fp('Read db in /tmp with ..', 'Read', '/tmp/../proj/x.db', { stricter: true }),
  fp('Read src', 'Read', 'src/app.js', { expect: 'allow' }),
  fp('Read secrets (no rule)', 'Read', '.env', { expect: 'allow' }),
  fp('Read approvals (no rule)', 'Read', '.agents/local/approvals/001-push.yaml', { expect: 'allow' }),
  { n: 'Grep pattern db', tool: 'Grep', input: () => ({ pattern: 'x', path: 'data.db' }), expect: 'deny' },
  { n: 'Grep glob token', tool: 'Grep', input: () => ({ pattern: '*.sqlite', path: '.' }), expect: 'deny' },
  { n: 'Glob db', tool: 'Glob', input: () => ({ pattern: '**/*.db' }), expect: 'deny' },
  { n: 'Glob ts', tool: 'Glob', input: () => ({ pattern: '**/*.ts' }), expect: 'allow' },
  fp('Write db', 'Write', 'data.db', { expect: 'deny' }),
  fp('Edit db as qa in scratch', 'Edit', '.agents/runs/LC/scratch/x.db', { who: 'proofline-qa q1', expect: 'deny' }),
  // language check (run files are English)
  { n: 'language ok', tool: 'Write', input: (d) => ({ file_path: `${d}/.agents/runs/LC/PLAN.md`, content: 'This plan is written in English.\n' }) },
  { n: 'language bad', tool: 'Write', input: (d) => ({ file_path: `${d}/.agents/runs/LC/EVIDENCE.md`, content: 'Bu dosya Turkce yazildi ve su degisiklik icin gerekli olan her sey burada.\n' }) },
  { n: 'language multiedit', tool: 'MultiEdit', input: (d) => ({ file_path: `${d}/.agents/runs/LC/EVIDENCE.md`, edits: [{ old_string: 'a', new_string: 'Bu dosya Turkce yazildi ve su degisiklik icin gerekli olan her sey burada.' }, { old_string: 'b', new_string: 'fine' }] }) },
  { n: 'language quote block exempt', tool: 'Write', input: (d) => ({ file_path: `${d}/.agents/runs/LC/EVIDENCE.md`, content: '> Bu dosya Turkce yazildi ve su degisiklik icin gerekli olan her sey burada.\n' }) },
  { n: 'language edit new_string', tool: 'Edit', input: (d) => ({ file_path: `${d}/.agents/runs/LC/TASK.md`, old_string: 'a', new_string: 'Bu dosya Turkce yazildi ve su degisiklik icin gerekli olan her sey burada.' }) },
  // Codex patch tools
  { n: 'patch product', tool: 'apply_patch', input: () => ({ command: '*** Begin Patch\n*** Update File: src/x.js\n*** End Patch' }), expect: 'deny' },
  { n: 'patch scratch', tool: 'apply_patch', input: () => ({ command: '*** Begin Patch\n*** Add File: .agents/runs/LC/scratch/a.txt\n*** End Patch' }), expect: 'allow' },
  { n: 'patch githook', tool: 'apply_patch', input: () => ({ input: '*** Begin Patch\n*** Add File: .agents/githooks/pre-commit\n*** End Patch' }), expect: 'deny' },
  { n: 'patch move to protected', tool: 'apply_patch', input: () => ({ input: '*** Begin Patch\n*** Update File: .agents/runs/LC/scratch/a.txt\n*** Move to: .agents/local/approvals/x.yaml\n*** End Patch' }), expect: 'deny' },
  { n: 'patch string input', tool: 'apply_patch', input: () => '*** Begin Patch\n*** Update File: src/x.js\n*** End Patch', expect: 'deny' },
  { n: 'patch delete tracked', tool: 'apply_patch', input: () => ({ input: '*** Begin Patch\n*** Delete File: impl.txt\n*** End Patch' }), expect: 'deny' },
  { n: 'patch delete scratch', tool: 'apply_patch', input: () => ({ input: '*** Begin Patch\n*** Delete File: .agents/runs/LC/scratch/none.txt\n*** End Patch' }) },
  { n: 'patch db', tool: 'apply_patch', input: () => ({ input: '*** Begin Patch\n*** Update File: data.db\n*** End Patch' }), expect: 'deny' },
  // other tools
  { n: 'Task has no rule', tool: 'Task', input: () => ({ prompt: 'x' }), expect: 'allow' },
  { n: 'MCP tool has no rule', tool: 'mcp__x__y', input: () => ({ path: 'data.db' }), expect: 'allow' },
  // Windows spellings (on POSIX an ordinary relative or absolute name)
  fp('windows drive backslash', 'Write', 'C:\\Users\\x\\a.txt'),
  fp('windows drive slash', 'Write', 'C:/Users/x/a.txt'),
  fp('windows msys', 'Write', '/c/Users/x/a.txt', { expect: 'deny' }),
  fp('windows backslash relative', 'Write', 'src\\x.js'),
  // odd spellings
  fp('trailing slash', 'Write', '.agents/local/approvals/', { expect: 'deny' }),
  fp('double slashes', 'Write', '<P>//.agents//local//approvals/x.yaml', { expect: 'deny' }),
  fp('dot components', 'Write', './.agents/./local/approvals/x.yaml', { expect: 'deny' }),
  fp('missing dir with dot', 'Write', 'nothere/./x.js'),
  fp('unicode name', 'Write', '.agents/runs/LC/scratch/\u00e9\u00e8\u4e2d.txt', { expect: 'allow' }),
  fp('unicode nfd name', 'Write', '.agents/runs/LC/scratch/e\u0301.txt', { expect: 'allow' }),
  fp('long path', 'Write', `.agents/runs/LC/scratch/${'a'.repeat(200)}/${'b'.repeat(200)}/c.txt`, { expect: 'allow' }),
  fp('newline in path', 'Write', 'src/x.js\n.agents/runs/LC/scratch/y.txt', { stricter: false }),
  // not closed by the shell (a textual `..` after a link): the Node guard resolves physically
  fp('link to outside then .. (the shell folds it textually and allows)', 'Edit', 'escdeep/../impl.txt', { who: 'proofline-implementer a7', stricter: true }),
];

// the pairs run in small batches: each pair is a shell hook (about 15 processes) and an in-process guard
test('file-tool guards: same verdict and text as the shell hook (run open)', { skip, timeout: 280000 }, async () => {
  const cases = corpus.filter((c) => c.run !== false);
  for (let i = 0; i < cases.length; i += 8) await Promise.all(cases.slice(i, i + 8).map(compare));
});

/** @type {Case[]} */
const noRun = [
  fp('no run: lead product', 'Write', '<P>/src/x.js', { run: false, expect: 'deny' }),
  fp('no run: lead relative product', 'Edit', 'impl.txt', { run: false, expect: 'deny' }),
  fp('no run: task file', 'Write', '.agents/tasks/NEW-1.md', { run: false, expect: 'allow' }),
  fp('no run: product doc', 'Write', 'docs/product/prd.md', { run: false, expect: 'allow' }),
  fp('no run: wiki', 'Write', 'docs/wiki/concepts/retry.md', { run: false, expect: 'allow' }),
  fp('no run: local explain', 'Write', '.agents/local/explain/x.html', { run: false, expect: 'allow' }),
  fp('no run: git-ignored file', 'Write', 'dist/bundle.js', { run: false, expect: 'allow' }),
  fp('no run: through ../', 'Write', 'docs/wiki/../../src/x.js', { run: false, expect: 'deny' }),
  fp('no run: approval', 'Write', '.agents/local/approvals/001-push.yaml', { run: false, expect: 'deny' }),
  fp('no run: capture', 'Write', '.agents/local/prompts/forged.json', { run: false, expect: 'deny' }),
  fp('no run: run approval', 'Write', '.agents/runs/LC/approvals/001-plan.yaml', { run: false, expect: 'deny' }),
  fp('no run: RUN.yaml', 'Edit', '.agents/runs/LC/RUN.yaml', { run: false, expect: 'deny' }),
  fp('no run: scripts', 'Edit', '.agents/scripts/agent.sh', { run: false, expect: 'deny' }),
  fp('no run: config', 'Edit', '.agents/config.yaml', { run: false, expect: 'deny' }),
  fp('no run: settings', 'Edit', '.claude/settings.json', { run: false, expect: 'deny' }),
  fp('no run: githook', 'Write', '.agents/githooks/pre-commit', { run: false, expect: 'deny' }),
  fp('no run: subagent', 'Write', '<P>/src/x.js', { run: false, who: 'proofline-task-author a5', expect: 'allow' }),
  fp('no run: env role', 'Write', '<P>/src/x.js', { run: false, env: { AGENT_ROLE: 'explorer' }, expect: 'allow' }),
  fp('no run: outside', 'Write', '<B>/elsewhere/x', { run: false, expect: 'allow' }),
  fp('no run: db', 'Read', 'data.db', { run: false, expect: 'deny' }),
  fp('no run: notebook', 'NotebookEdit', '', { run: false, input: (d) => ({ notebook_path: `${d}/src/n.ipynb` }), expect: 'deny' }),
  { n: 'no run: patch', tool: 'apply_patch', run: false, input: () => ({ command: '*** Begin Patch\n*** Update File: src/x.js\n*** End Patch' }), expect: 'deny' },
  fp('no run: without path', 'Write', '', { run: false, input: () => ({ content: 'x' }), expect: 'allow' }),
  { n: 'Skill proofline', tool: 'Skill', run: false, input: () => ({ skill: 'proofline:proofline-lead' }), env: { CLAUDE_PLUGIN_ROOT: '<B>/plug' } },
  { n: 'Skill other', tool: 'Skill', run: false, input: () => ({ skill: 'tdd' }), expect: 'allow' },
  { n: 'Skill invalid name', tool: 'Skill', run: false, input: () => ({ skill: '../x' }), expect: 'allow' },
  { n: 'Skill via name key', tool: 'Skill', run: false, input: () => ({ name: 'proofline:x' }), expect: 'allow' },
];

test('file-tool guards: same verdict and text as the shell hook (no run)', { skip, timeout: 280000 }, async () => {
  const dir = join(base, 'plug/skills/proofline-lead');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'x\n');
  for (let i = 0; i < noRun.length; i += 8) await Promise.all(noRun.slice(i, i + 8).map(compare));
});

test('file-tool guards: a case variant of a protected name is protected (case-insensitive file systems)', { skip: skip || caseSensitive, timeout: 60000 }, async () => {
  for (const p of ['.AGENTS/local/approvals/x.yaml', '.agents/LOCAL/approvals/x.yaml', '.agents/runs/LC/run.yaml', '.agents/runs/LC/Gates/001.yaml']) {
    const r = await nodeVerdict(runDir, { tool_name: 'Write', tool_input: { file_path: p } }, {});
    assert.equal(r?.decision, 'deny', p);
  }
});
